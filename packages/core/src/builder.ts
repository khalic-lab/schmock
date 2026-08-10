import type { Server } from "node:http";
import { awaitWithAbort, throwIfAborted } from "./abort.js";
import { isBinaryBody } from "./binary.js";
import {
  canonicalizePath,
  markResponseException,
  markRouteNotFound,
  normalizePath,
  toHttpMethod,
} from "./constants.js";
import {
  errorMessage,
  RouteDefinitionError,
  RouteNotFoundError,
  SchmockError,
} from "./errors.js";
import {
  collectBody,
  HttpIngressError,
  parseNodeHeaders,
  parseNodeQuery,
  writeRejectedSchmockResponse,
  writeSchmockResponse,
} from "./http-helpers.js";
import { createFetchInterceptor } from "./interceptor.js";
import { parseRouteKey } from "./parser.js";
import {
  recoverGeneratorError,
  runPluginBeforeRequest,
  runPluginPipeline,
} from "./plugin-pipeline.js";
import { normalizeResponse } from "./response-normalizer.js";
import { parseResponse } from "./response-parser.js";
import type { CompiledCallableRoute } from "./route-matcher.js";
import {
  extractParams,
  findRoute,
  isGeneratorFunction,
} from "./route-matcher.js";

type InternalGlobalConfig = Omit<Schmock.GlobalConfig, "state"> & {
  state: Record<string, unknown>;
};

interface PendingServerStart {
  readonly token: symbol;
  readonly port: number;
  readonly hostname: string;
  readonly resolve: (info: Schmock.ServerInfo) => void;
  readonly reject: (error: unknown) => void;
  server?: Server;
  settled: boolean;
}

interface RequestAdmission {
  readonly requestGeneration: RequestGeneration;
  readonly historyGeneration: symbol;
  readonly plugins: readonly Schmock.Plugin[];
  readonly routes: CompiledCallableRoute[];
  readonly staticRoutes: Map<string, CompiledCallableRoute>;
  readonly state: Record<string, unknown>;
  readonly namespace?: string;
  readonly globalDelay?: number | [number, number];
  readonly maxHistorySize?: number;
  released: boolean;
}

interface RequestGeneration {
  activeAdmissions: number;
  retiredPlugins?: readonly Schmock.Plugin[];
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function unavailableHistoryValue(value: unknown): Record<string, string> {
  let type: string = typeof value;
  if (typeof value === "object" && value !== null) {
    try {
      type = Object.prototype.toString.call(value);
    } catch {
      type = "object";
    }
  }
  return {
    kind: "unavailable",
    reason: "not-structured-cloneable",
    type,
  };
}

function removeSharedMemory(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value !== "object" || value === null) return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  ) {
    const copy = Uint8Array.from(new Uint8Array(value)).buffer;
    seen.set(value, copy);
    return copy;
  }

  if (
    ArrayBuffer.isView(value) &&
    typeof SharedArrayBuffer !== "undefined" &&
    value.buffer instanceof SharedArrayBuffer
  ) {
    const copy = Uint8Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
    seen.set(value, copy);
    return copy;
  }

  seen.set(value, value);
  if (value instanceof Map) {
    const entries = [...value.entries()];
    value.clear();
    for (const [key, entryValue] of entries) {
      value.set(
        removeSharedMemory(key, seen),
        removeSharedMemory(entryValue, seen),
      );
    }
    return value;
  }
  if (value instanceof Set) {
    const entries = [...value.values()];
    value.clear();
    for (const entryValue of entries) {
      value.add(removeSharedMemory(entryValue, seen));
    }
    return value;
  }

  for (const key of Reflect.ownKeys(value)) {
    Reflect.set(value, key, removeSharedMemory(Reflect.get(value, key), seen));
  }
  return value;
}

/**
 * Reject a history limit that cannot bound anything.
 *
 * A negative limit used to read as "unbounded" and a fractional one evicted a
 * fractional number of records, so a typo silently disabled the cap instead of
 * failing. `Number.isInteger` also rejects NaN and Infinity. `0` stays valid
 * and keeps meaning "history disabled".
 */
function assertValidHistoryLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new SchmockError(
      `Invalid maxHistorySize: ${String(limit)}. Expected a non-negative integer (0 disables history).`,
      "INVALID_CONFIG",
      { maxHistorySize: limit },
    );
  }
}

/**
 * Header names whose VALUE is replaced in debug logs. The name is kept so a log
 * still shows the header was present; only the credential is hidden. Matches
 * the set the CLI already masks.
 */
const REDACTED_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-schmock-admin-token",
]);

const REDACTED_HEADER_VALUE = "[redacted]";

/**
 * Copy-on-write redaction: the input record is handed on to plugins, history
 * and transports, so it must never be mutated. When nothing is sensitive the
 * original object is returned unchanged.
 */
function redactSensitiveHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  let redacted: Record<string, string> | undefined;
  for (const name of Object.keys(headers)) {
    if (!REDACTED_HEADER_NAMES.has(name.toLowerCase())) continue;
    redacted ??= { ...headers };
    redacted[name] = REDACTED_HEADER_VALUE;
  }
  return redacted ?? headers;
}

function snapshotHistoryValue(value: unknown): unknown {
  try {
    return removeSharedMemory(structuredClone(value));
  } catch {
    return unavailableHistoryValue(value);
  }
}

/**
 * Debug logger that respects debug mode configuration
 */
class DebugLogger {
  constructor(private enabled = false) {}

  log(category: string, message: string, data?: unknown) {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [SCHMOCK:${category.toUpperCase()}]`;

    if (data) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  time(label: string) {
    if (!this.enabled) return;
    console.time(`[SCHMOCK] ${label}`);
  }

  timeEnd(label: string) {
    if (!this.enabled) return;
    console.timeEnd(`[SCHMOCK] ${label}`);
  }
}

/**
 * Callable mock instance that implements the new API.
 *
 * @internal
 */
export class CallableMockInstance {
  private routes: CompiledCallableRoute[] = [];
  private staticRoutes = new Map<string, CompiledCallableRoute>();
  private plugins: Schmock.Plugin[] = [];
  private logger: DebugLogger;
  private requestHistory: Schmock.RequestRecord[] = [];
  private callableRef: Schmock.CallableMockInstance | undefined;
  private server: Server | undefined;
  private pendingServerStart: PendingServerStart | undefined;
  private serverCloseBarrier: Promise<void> | undefined;
  private interceptHandles = new Set<Schmock.InterceptHandle>();
  private requestGeneration: RequestGeneration = { activeAdmissions: 0 };
  private historyGeneration = Symbol("schmock.history.generation");
  private interceptOwner = Symbol("schmock.intercept.owner");
  private globalConfig: InternalGlobalConfig;
  // biome-ignore lint/complexity/noBannedTypes: internal storage for event listeners with varying signatures
  private listeners = new Map<string, Set<Function>>();

  constructor(globalConfig: Schmock.GlobalConfig = {}) {
    assertValidHistoryLimit(globalConfig.maxHistorySize);
    this.globalConfig = {
      ...globalConfig,
      state: globalConfig.state ?? {},
    };
    this.logger = new DebugLogger(globalConfig.debug || false);
    if (globalConfig.debug) {
      this.logger.log("config", "Debug mode enabled");
    }
    this.logger.log("config", "Callable mock instance created", {
      debug: globalConfig.debug,
      namespace: globalConfig.namespace,
      delay: globalConfig.delay,
    });
  }

  // Method for defining routes (called when instance is invoked)
  defineRoute(
    route: Schmock.RouteKey,
    generator: Schmock.Generator,
    config: Schmock.RouteConfig,
  ): this {
    // FIX 1.2: shallow-clone the caller's config so mutations below stay private
    const routeConfig = { ...config };

    // Auto-detect contentType if not provided
    if (!routeConfig.contentType) {
      if (typeof generator === "function") {
        // Default to JSON for function generators
        routeConfig.contentType = "application/json";
      } else if (
        typeof generator === "string" ||
        typeof generator === "number" ||
        typeof generator === "boolean"
      ) {
        // Default to plain text for primitives
        routeConfig.contentType = "text/plain";
      } else if (isBinaryBody(generator)) {
        // Default to octet-stream for browser and Node binary values
        routeConfig.contentType = "application/octet-stream";
      } else {
        // Default to JSON for objects/arrays
        routeConfig.contentType = "application/json";
      }
    }

    // Validate generator matches contentType if it's static data
    if (
      typeof generator !== "function" &&
      routeConfig.contentType === "application/json"
    ) {
      try {
        JSON.stringify(generator);
      } catch (_error) {
        throw new RouteDefinitionError(
          route,
          "Generator data is not valid JSON but contentType is application/json",
        );
      }
    }

    // Parse the route key to create pattern and extract parameters
    const parsed = parseRouteKey(route);

    // FIX 2.2: normalize paths before duplicate check so /users and /users/ are
    // treated as the same route (consistent with the static-route Map key below)
    const normalizedParsedPath = normalizePath(parsed.path);
    const existing = this.routes.find(
      (r) =>
        r.method === parsed.method &&
        normalizePath(r.path) === normalizedParsedPath,
    );
    if (existing) {
      this.logger.log(
        "warning",
        `Duplicate route: ${route} — first registration wins`,
      );
      return this;
    }

    // Compile the route
    const compiledRoute: CompiledCallableRoute = {
      pattern: parsed.pattern,
      params: parsed.params,
      method: parsed.method,
      path: parsed.path,
      generator,
      config: routeConfig,
    };

    this.routes.push(compiledRoute);

    // Store static routes (no params) in Map for O(1) lookup
    if (parsed.params.length === 0) {
      const key = `${parsed.method} ${normalizePath(parsed.path)}`;
      this.staticRoutes.set(key, compiledRoute);
    }

    this.logger.log("route", `Route defined: ${route}`, {
      contentType: routeConfig.contentType,
      generatorType: typeof generator,
      hasParams: parsed.params.length > 0,
    });

    return this;
  }

  setCallableRef(ref: Schmock.CallableMockInstance): void {
    this.callableRef = ref;
  }

  pipe(plugin: Schmock.Plugin): this {
    if (plugin.install && this.callableRef) {
      const previousRoutes = this.routes;
      const previousStaticRoutes = this.staticRoutes;
      this.routes = previousRoutes.slice();
      this.staticRoutes = new Map(previousStaticRoutes);

      let installActive = true;
      let installFacade: Schmock.CallableMockInstance;
      const requireInstallScope = () => {
        if (installActive) return;
        throw new SchmockError(
          `Plugin "${plugin.name}" used its install instance outside install()`,
          "PLUGIN_INSTALL_SCOPE_EXPIRED",
          { plugin: plugin.name },
        );
      };
      const rejectInstallOperation = (operation: string): never => {
        requireInstallScope();
        throw new SchmockError(
          `Plugin "${plugin.name}" cannot call ${operation} during install()`,
          "PLUGIN_INSTALL_OPERATION_UNSUPPORTED",
          { operation, plugin: plugin.name },
        );
      };
      const registerRoute = (
        route: Schmock.RouteKey,
        generator: Schmock.Generator,
        config: Schmock.RouteConfig = {},
      ) => {
        requireInstallScope();
        this.defineRoute(route, generator, config);
        return installFacade;
      };
      installFacade = Object.assign(registerRoute, {
        pipe: () => rejectInstallOperation("pipe()"),
        handle: () => rejectInstallOperation("handle()"),
        history: (method?: Schmock.HttpMethod, path?: string) => {
          requireInstallScope();
          return this.history(method, path);
        },
        called: (method?: Schmock.HttpMethod, path?: string) => {
          requireInstallScope();
          return this.called(method, path);
        },
        callCount: (method?: Schmock.HttpMethod, path?: string) => {
          requireInstallScope();
          return this.callCount(method, path);
        },
        lastRequest: (method?: Schmock.HttpMethod, path?: string) => {
          requireInstallScope();
          return this.lastRequest(method, path);
        },
        reset: () => rejectInstallOperation("reset()"),
        resetHistory: () => rejectInstallOperation("resetHistory()"),
        resetState: () => rejectInstallOperation("resetState()"),
        on: () => rejectInstallOperation("on()"),
        off: () => rejectInstallOperation("off()"),
        getRoutes: () => {
          requireInstallScope();
          return this.getRoutes();
        },
        getState: () => {
          requireInstallScope();
          return this.getState();
        },
        listen: () => rejectInstallOperation("listen()"),
        close: () => rejectInstallOperation("close()"),
        intercept: () => rejectInstallOperation("intercept()"),
      });

      try {
        const installResult: unknown = plugin.install(installFacade);
        installActive = false;
        if (isThenable(installResult)) {
          void Promise.resolve(installResult).catch((error) => {
            this.logger.log(
              "plugin",
              `Rejected async install for ${plugin.name}: ${errorMessage(error)}`,
            );
          });
          throw new SchmockError(
            `Plugin "${plugin.name}" returned a Promise from install()`,
            "PLUGIN_ASYNC_INSTALL_UNSUPPORTED",
            { plugin: plugin.name },
          );
        }
      } catch (error) {
        this.routes = previousRoutes;
        this.staticRoutes = previousStaticRoutes;
        throw error;
      } finally {
        installActive = false;
      }
    }

    this.plugins.push(plugin);
    this.logger.log(
      "plugin",
      `Registered plugin: ${plugin.name}@${plugin.version || "unknown"}`,
      {
        name: plugin.name,
        version: plugin.version,
        hasProcess: typeof plugin.process === "function",
        hasOnError: typeof plugin.onError === "function",
      },
    );
    return this;
  }

  private uninstallPlugins(plugins: readonly Schmock.Plugin[]): void {
    for (let index = plugins.length - 1; index >= 0; index -= 1) {
      const plugin = plugins[index];
      if (!plugin.uninstall || !this.callableRef) continue;

      try {
        const uninstallResult: unknown = plugin.uninstall(this.callableRef);
        if (isThenable(uninstallResult)) {
          void Promise.resolve(uninstallResult).catch((error) => {
            this.logger.log(
              "plugin",
              `Async uninstall for ${plugin.name} failed: ${errorMessage(error)}`,
            );
          });
          this.logger.log(
            "plugin",
            `Plugin ${plugin.name} returned an unsupported Promise from uninstall()`,
          );
        }
      } catch (error) {
        this.logger.log(
          "plugin",
          `Plugin ${plugin.name} uninstall failed: ${errorMessage(error)}`,
        );
      }
    }
  }

  // ===== Request Spy / History API =====

  private cloneRecord(r: Schmock.RequestRecord): Schmock.RequestRecord {
    return {
      method: r.method,
      path: r.path,
      params: { ...r.params },
      query: { ...r.query },
      headers: { ...r.headers },
      body: snapshotHistoryValue(r.body),
      timestamp: r.timestamp,
      response: {
        status: r.response.status,
        body: snapshotHistoryValue(r.response.body),
      },
    };
  }

  /**
   * History stores the canonical request path — percent-encoded and
   * trailing-slash-normalized exactly as `handle()` produced it — so a spy
   * filter must be put into the same form before it is compared, or the very
   * string the caller passed to `handle()` would not match its own record.
   * `canonicalizePath` is idempotent, so an already-encoded filter keeps
   * matching and both spellings work.
   */
  #historyMatcher(
    method?: Schmock.HttpMethod,
    path?: string,
  ): (r: Schmock.RequestRecord) => boolean {
    const wanted =
      path === undefined ? undefined : normalizePath(canonicalizePath(path));
    return (r) =>
      (!method || r.method === method) && (!wanted || r.path === wanted);
  }

  history(method?: Schmock.HttpMethod, path?: string): Schmock.RequestRecord[] {
    if (method || path) {
      return this.requestHistory
        .filter(this.#historyMatcher(method, path))
        .map((r) => this.cloneRecord(r));
    }
    return this.requestHistory.map((r) => this.cloneRecord(r));
  }

  called(method?: Schmock.HttpMethod, path?: string): boolean {
    if (method || path) {
      return this.requestHistory.some(this.#historyMatcher(method, path));
    }
    return this.requestHistory.length > 0;
  }

  callCount(method?: Schmock.HttpMethod, path?: string): number {
    if (method || path) {
      return this.requestHistory.filter(this.#historyMatcher(method, path))
        .length;
    }
    return this.requestHistory.length;
  }

  lastRequest(
    method?: Schmock.HttpMethod,
    path?: string,
  ): Schmock.RequestRecord | undefined {
    if (method || path) {
      const filtered = this.requestHistory.filter(
        this.#historyMatcher(method, path),
      );
      const last = filtered[filtered.length - 1];
      // FIX 2.3: return a deep clone so callers cannot corrupt internal history
      return last ? this.cloneRecord(last) : undefined;
    }
    const last = this.requestHistory[this.requestHistory.length - 1];
    // FIX 2.3: return a deep clone so callers cannot corrupt internal history
    return last ? this.cloneRecord(last) : undefined;
  }

  // ===== Introspection =====

  getRoutes(): Schmock.RouteInfo[] {
    return this.routes.map((r) => ({
      method: r.method,
      path: r.path,
      hasParams: r.params.length > 0,
    }));
  }

  getState(): Record<string, unknown> {
    return { ...(this.globalConfig.state || {}) };
  }

  // ===== Lifecycle Events =====

  on<E extends Schmock.SchmockEvent>(
    event: E,
    listener: (data: Schmock.SchmockEventMap[E]) => void,
  ): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off<E extends Schmock.SchmockEvent>(
    event: E,
    listener: (data: Schmock.SchmockEventMap[E]) => void,
  ): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  private emit<E extends Schmock.SchmockEvent>(
    event: E,
    data: Schmock.SchmockEventMap[E],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;

    const snapshot: Record<string, unknown> = { ...data };
    if ("headers" in data) {
      snapshot.headers = Object.freeze({ ...data.headers });
    }
    if ("params" in data) {
      snapshot.params = Object.freeze({ ...data.params });
    }
    const eventData = Object.freeze(snapshot);

    for (const listener of [...set]) {
      try {
        const listenerResult: unknown = listener(eventData);
        if (isThenable(listenerResult)) {
          void Promise.resolve(listenerResult).catch((error) => {
            this.logger.log(
              "event",
              `${event} listener rejected: ${errorMessage(error)}`,
            );
          });
        }
      } catch (error) {
        this.logger.log(
          "event",
          `${event} listener failed: ${errorMessage(error)}`,
        );
      }
    }
  }

  // ===== Reset / Lifecycle =====

  reset(): void {
    const retiredGeneration = this.requestGeneration;
    this.requestGeneration = { activeAdmissions: 0 };
    this.historyGeneration = Symbol("schmock.history.generation");
    this.close();
    const installedPlugins = this.plugins;
    this.plugins = [];
    this.#retireRequestGeneration(retiredGeneration, installedPlugins);
    this.routes = [];
    this.staticRoutes.clear();
    this.requestHistory = [];
    this.listeners.clear();
    this.globalConfig.state = {};
    this.logger.log("lifecycle", "Mock fully reset");
  }

  resetHistory(): void {
    this.historyGeneration = Symbol("schmock.history.generation");
    this.requestHistory = [];
    this.logger.log("lifecycle", "Request history cleared");
  }

  resetState(): void {
    this.globalConfig.state = {};
    this.logger.log("lifecycle", "State cleared");
  }

  #captureRequestAdmission(): RequestAdmission {
    const requestGeneration = this.requestGeneration;
    requestGeneration.activeAdmissions += 1;
    return {
      requestGeneration,
      historyGeneration: this.historyGeneration,
      plugins: this.plugins.slice(),
      routes: this.routes.slice(),
      staticRoutes: new Map(this.staticRoutes),
      state: this.globalConfig.state,
      namespace: this.globalConfig.namespace,
      globalDelay: this.globalConfig.delay,
      maxHistorySize: this.globalConfig.maxHistorySize,
      released: false,
    };
  }

  #releaseRequestAdmission(admission: RequestAdmission): void {
    if (admission.released) return;
    admission.released = true;

    const generation = admission.requestGeneration;
    generation.activeAdmissions -= 1;
    if (
      generation.activeAdmissions === 0 &&
      generation.retiredPlugins !== undefined
    ) {
      const plugins = generation.retiredPlugins;
      generation.retiredPlugins = undefined;
      this.uninstallPlugins(plugins);
    }
  }

  #retireRequestGeneration(
    generation: RequestGeneration,
    plugins: readonly Schmock.Plugin[],
  ): void {
    generation.retiredPlugins = plugins;
    if (generation.activeAdmissions === 0) {
      generation.retiredPlugins = undefined;
      this.uninstallPlugins(plugins);
    }
  }

  createRequestAdmission() {
    const admission = this.#captureRequestAdmission();
    return {
      handle: (
        method: Schmock.HttpMethod,
        path: string,
        options?: Schmock.RequestOptions,
      ) => this.handle(method, path, options, admission),
      release: () => this.#releaseRequestAdmission(admission),
    };
  }

  // ===== Standalone Server =====

  listen(port = 0, hostname = "127.0.0.1"): Promise<Schmock.ServerInfo> {
    if (this.server || this.pendingServerStart) {
      throw new SchmockError(
        "Server is already running",
        "SERVER_ALREADY_RUNNING",
      );
    }

    let resolveStart = (_info: Schmock.ServerInfo) => {};
    let rejectStart = (_error: unknown) => {};
    const startPromise = new Promise<Schmock.ServerInfo>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const operation: PendingServerStart = {
      token: Symbol("schmock.server.start"),
      port,
      hostname,
      resolve: resolveStart,
      reject: rejectStart,
      settled: false,
    };
    this.pendingServerStart = operation;

    const closeBarrier = this.serverCloseBarrier ?? Promise.resolve();
    void closeBarrier
      // Lazy-load node:http so browser bundles never pull it in. See issue #395.
      .then(() => import("node:http"))
      .then(({ createServer }) => {
        if (!this.#ownsServerStart(operation)) return;
        this.#startHttpServer(operation, createServer);
      })
      .catch((error) => {
        this.#rejectServerStart(operation, error);
      });

    return startPromise;
  }

  #ownsServerStart(operation: PendingServerStart): boolean {
    return this.pendingServerStart === operation && !operation.settled;
  }

  #startHttpServer(
    operation: PendingServerStart,
    createServer: typeof import("node:http").createServer,
  ): void {
    const httpServer = createServer((req, res) => {
      const admittedRequest = this.createRequestAdmission();
      const abortController = new AbortController();
      const abortRequest = () => abortController.abort();
      req.once("aborted", abortRequest);
      res.once("close", abortRequest);
      let requestMethod: Schmock.HttpMethod =
        req.method?.toUpperCase() === "HEAD" ? "HEAD" : "GET";
      const handleRequest = async () => {
        try {
          const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
          const method = toHttpMethod(req.method ?? "GET");
          requestMethod = method;
          const path = url.pathname;
          const headers = parseNodeHeaders(req);
          const query = parseNodeQuery(url);
          const body = await collectBody(req, headers);
          const schmockResponse = await admittedRequest.handle(method, path, {
            headers,
            body,
            query,
            signal: abortController.signal,
          });
          writeSchmockResponse(res, schmockResponse);
        } finally {
          req.off("aborted", abortRequest);
          res.off("close", abortRequest);
          admittedRequest.release();
        }
      };

      handleRequest().catch((error) => {
        // A failing error-response write must never escape this handler as an
        // unhandled rejection: destroy the socket so the client is not left
        // hanging on a response that will never arrive.
        try {
          const ingressError =
            error instanceof HttpIngressError ? error : undefined;
          const status = ingressError?.status ?? 500;
          const code = ingressError?.code ?? "SERVER_ERROR";
          if (!res.headersSent && !res.writableEnded) {
            if (ingressError) res.shouldKeepAlive = false;
            // `shouldKeepAlive = false` alone emits no Connection header when
            // writeHead is given a header object, so the announcement has to be
            // explicit. It travels on the transport's own header channel rather
            // than on the response: normalizeResponse strips hop-by-hop headers
            // from everything a route produces.
            const transportHeaders = ingressError
              ? { connection: "close" }
              : undefined;
            const response = normalizeResponse(
              {
                status,
                body: {
                  error:
                    error instanceof Error
                      ? error.message
                      : "Internal Server Error",
                  code,
                },
                headers: { "content-type": "application/json" },
              },
              requestMethod,
            );
            if (ingressError?.status === 413) {
              writeRejectedSchmockResponse(
                req,
                res,
                response,
                transportHeaders,
              );
            } else {
              writeSchmockResponse(res, response, transportHeaders);
            }
          } else if (!res.writableEnded) {
            res.end();
          }
        } catch {
          res.destroy();
        }
      });
    });

    operation.server = httpServer;

    const handleStartupError = (error: Error) => {
      this.#rejectServerStart(operation, error);
    };
    httpServer.once("error", handleStartupError);

    try {
      httpServer.listen(operation.port, operation.hostname, () => {
        httpServer.off("error", handleStartupError);
        if (!this.#ownsServerStart(operation)) {
          this.#beginServerClose(httpServer);
          return;
        }

        const addr = httpServer.address();
        const actualPort =
          addr !== null && typeof addr === "object"
            ? addr.port
            : operation.port;
        const info = { port: actualPort, hostname: operation.hostname };
        operation.settled = true;
        this.pendingServerStart = undefined;
        this.server = httpServer;
        this.logger.log(
          "server",
          `Listening on ${operation.hostname}:${actualPort}`,
        );
        operation.resolve(info);
      });
    } catch (error) {
      httpServer.off("error", handleStartupError);
      this.#rejectServerStart(operation, error);
    }
  }

  #rejectServerStart(operation: PendingServerStart, error: unknown): void {
    if (operation.settled) return;

    operation.settled = true;
    if (this.pendingServerStart === operation) {
      this.pendingServerStart = undefined;
    }
    if (operation.server) {
      this.#beginServerClose(operation.server);
    }
    operation.reject(error);
  }

  #cancelServerStart(): void {
    const operation = this.pendingServerStart;
    if (!operation) return;

    this.#rejectServerStart(
      operation,
      new SchmockError("Server start was cancelled", "SERVER_START_CANCELLED"),
    );
  }

  #beginServerClose(server: Server): void {
    const closePromise = new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    try {
      server.closeAllConnections();
    } catch {
      // A not-yet-listening server has no connections to close.
    }
    const previousBarrier = this.serverCloseBarrier ?? Promise.resolve();
    const combinedBarrier = Promise.all([previousBarrier, closePromise]).then(
      () => undefined,
    );
    this.serverCloseBarrier = combinedBarrier;
    void combinedBarrier.finally(() => {
      if (this.serverCloseBarrier === combinedBarrier) {
        this.serverCloseBarrier = undefined;
      }
    });
  }

  close(): void {
    this.#cancelServerStart();
    const server = this.server;
    if (!server) return;

    this.server = undefined;
    this.#beginServerClose(server);
    this.logger.log("server", "Server stopped");
  }

  // ===== Fetch Interceptor =====

  intercept(options?: Schmock.InterceptOptions): Schmock.InterceptHandle {
    // Ownership is a lease, not a lock: nested providers, separate roots, and
    // a manual intercept() alongside an adapter each get their own registry
    // slot with their own options, released independently. The owner symbol
    // keeps them one mock for dispatch, so a single request reaches handle()
    // once no matter how many leases this instance holds.
    const lease = createFetchInterceptor(
      (method, path, opts) => this.handle(method, path, opts),
      options,
      () => this.createRequestAdmission(),
      this.interceptOwner,
    );

    const handle: Schmock.InterceptHandle = {
      restore: () => {
        lease.restore();
        if (this.interceptHandles.delete(handle)) {
          this.logger.log(
            "lifecycle",
            `Interception lease released (${this.interceptHandles.size} still held)`,
          );
        }
      },
      update: (nextOptions) => {
        lease.update(nextOptions);
      },
      get active() {
        return lease.active;
      },
    };

    this.interceptHandles.add(handle);
    this.logger.log(
      "lifecycle",
      `Interception lease acquired (${this.interceptHandles.size} held)`,
    );

    return handle;
  }

  async handle(
    method: Schmock.HttpMethod,
    path: string,
    options?: Schmock.RequestOptions,
    admission?: RequestAdmission,
  ): Promise<Schmock.Response> {
    const requestAdmission = admission ?? this.#captureRequestAdmission();
    try {
      return await this.#handleAdmittedRequest(
        method,
        path,
        options,
        requestAdmission,
      );
    } finally {
      this.#releaseRequestAdmission(requestAdmission);
    }
  }

  async #handleAdmittedRequest(
    method: Schmock.HttpMethod,
    requestedPath: string,
    options: Schmock.RequestOptions | undefined,
    admission: RequestAdmission,
  ): Promise<Schmock.Response> {
    // Canonicalize before anything observes the path: a transport hands over an
    // already-encoded `url.pathname` while a direct handle() caller may type
    // literal unicode, and every lifecycle event, log line and 404 message must
    // report the same spelling.
    const path = canonicalizePath(requestedPath);
    const requestGeneration = admission.requestGeneration;
    const historyGeneration = admission.historyGeneration;
    const requestPlugins = admission.plugins;
    const requestRoutes = admission.routes;
    const requestStaticRoutes = admission.staticRoutes;
    const requestState = admission.state;
    const namespace = admission.namespace;
    const globalDelay = admission.globalDelay;
    const maxHistorySize = admission.maxHistorySize;
    const signal = options?.signal;
    throwIfAborted(signal);

    const handleStart = performance.now();
    const requestId = this.globalConfig.debug ? crypto.randomUUID() : "";
    const reqQuery = { ...(options?.query ?? {}) };
    const reqHeaders = { ...(options?.headers ?? {}) };
    const requestBody = options?.body;
    this.logger.log("request", `[${requestId}] ${method} ${path}`, {
      headers: redactSensitiveHeaders(reqHeaders),
      query: reqQuery,
      // Presence, not truthiness: "", 0 and false are bodies too.
      bodyType:
        options !== undefined && "body" in options && options.body !== undefined
          ? typeof options.body
          : "none",
    });
    this.logger.time(`request-${requestId}`);

    if (this.requestGeneration === requestGeneration) {
      this.emit("request:start", {
        method,
        path,
        headers: reqHeaders,
      });
    }

    // Hoisted so the catch block can finalize a matched request the same way
    // the success path does — same delay override, same history record.
    let requestPath = path;
    let matchedRoute: CompiledCallableRoute | undefined;
    let params: Record<string, string> = {};

    try {
      // Apply namespace if configured
      if (namespace && namespace !== "/") {
        const normalizedNamespace = canonicalizePath(
          namespace.startsWith("/") ? namespace : `/${namespace}`,
        );

        const pathToCheck = path.startsWith("/") ? path : `/${path}`;

        // Check if path starts with namespace
        // handle both "/api/users" (starts with /api) and "/api" (exact match)
        // but NOT "/apiv2" (prefix match but wrong segment)
        const isMatch =
          pathToCheck === normalizedNamespace ||
          pathToCheck.startsWith(
            normalizedNamespace.endsWith("/")
              ? normalizedNamespace
              : `${normalizedNamespace}/`,
          );

        if (!isMatch) {
          this.logger.log(
            "route",
            `[${requestId}] Path doesn't match namespace ${normalizedNamespace}`,
          );
          // A request outside the namespace is a route miss like any other, so
          // it reports one instead of silently ending.
          return this.#finalizeMiss({
            method,
            path,
            requestId,
            handleStart,
            requestGeneration,
          });
        }

        // Remove namespace prefix, ensuring we always start with /
        const stripped = pathToCheck.slice(normalizedNamespace.length);
        requestPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
      }

      // One trailing-slash normalization for the whole request: route lookup
      // and parameter extraction must see the identical string, or a request
      // could match a route and then capture no parameters.
      requestPath = normalizePath(requestPath);

      // Find matching route
      matchedRoute = findRoute(
        method,
        requestPath,
        requestStaticRoutes,
        requestRoutes,
      );

      if (!matchedRoute) {
        this.logger.log(
          "route",
          `[${requestId}] No route found for ${method} ${requestPath}`,
        );
        return this.#finalizeMiss({
          method,
          path,
          requestId,
          handleStart,
          requestGeneration,
        });
      }

      this.logger.log(
        "route",
        `[${requestId}] Matched route: ${method} ${matchedRoute.path}`,
      );

      // Extract parameters from the matched route
      params = extractParams(matchedRoute, requestPath);

      if (this.requestGeneration === requestGeneration) {
        this.emit("request:match", {
          method,
          // Every lifecycle event carries the ORIGINAL request path; the
          // namespace-stripped route form is exposed as routePath.
          path,
          routePath: matchedRoute.path,
          params,
        });
      }
      throwIfAborted(signal);

      // Build plugin context before route code so request guards can reject
      // invalid or unauthorized requests without triggering side effects.
      let pluginContext: Schmock.PluginContext = {
        path: requestPath,
        route: matchedRoute.config,
        method,
        params,
        query: reqQuery,
        headers: reqHeaders,
        body: requestBody,
        state: new Map(),
        routeState: requestState,
        signal,
      };

      const preflightResult = await runPluginBeforeRequest(
        requestPlugins,
        pluginContext,
        this.logger,
        signal,
      );
      throwIfAborted(signal);
      pluginContext = preflightResult.context;
      if (preflightResult.requestShortCircuited === true) {
        pluginContext = { ...pluginContext, requestShortCircuited: true };
      }

      let result: unknown = preflightResult.response;
      let skipPostProcessing = preflightResult.recoveredFromError === true;

      if (result === undefined) {
        const context: Schmock.RequestContext = {
          method: pluginContext.method,
          path: pluginContext.path,
          params: pluginContext.params,
          query: pluginContext.query,
          headers: pluginContext.headers,
          body: pluginContext.body,
          state: pluginContext.routeState ?? requestState,
          pluginState: pluginContext.state,
          signal,
        };

        try {
          if (isGeneratorFunction(matchedRoute.generator)) {
            result = await awaitWithAbort(
              matchedRoute.generator(context),
              signal,
            );
          } else {
            result = matchedRoute.generator;
          }
          throwIfAborted(signal);
        } catch (error) {
          throwIfAborted(signal);
          const recovery = await recoverGeneratorError(
            requestPlugins,
            pluginContext,
            error,
            this.logger,
            signal,
          );
          throwIfAborted(signal);
          pluginContext = recovery.context;
          result = recovery.response;
          skipPostProcessing = recovery.recoveredFromError === true;
        }
      }

      // Run plugin pipeline to transform the response
      try {
        if (skipPostProcessing) {
          this.logger.log(
            "pipeline",
            "Skipping response processors after error recovery",
          );
        } else {
          const pipelineResult = await runPluginPipeline(
            requestPlugins,
            pluginContext,
            result,
            this.logger,
            signal,
          );
          throwIfAborted(signal);
          pluginContext = pipelineResult.context;
          result = pipelineResult.response;
        }
      } catch (error) {
        this.logger.log(
          "error",
          `[${requestId}] Plugin pipeline error: ${errorMessage(error)}`,
        );
        throw error;
      }

      // Parse and prepare response
      const response = normalizeResponse(
        parseResponse(result, matchedRoute.config),
        method,
      );

      await this.#finalizeMatchedRequest({
        method,
        path,
        requestPath,
        params,
        reqQuery,
        reqHeaders,
        requestBody,
        response,
        routeDelay: matchedRoute.config.delay,
        globalDelay,
        record: true,
        signal,
        requestGeneration,
        historyGeneration,
        maxHistorySize,
        requestId,
        handleStart,
      });

      return response;
    } catch (error) {
      throwIfAborted(signal);
      this.logger.log(
        "error",
        `[${requestId}] Error processing request: ${errorMessage(error)}`,
        error,
      );

      // Return error response
      const responseError =
        error instanceof Error ? error : new Error(errorMessage(error));
      const errorResponse = markResponseException(
        normalizeResponse(
          {
            status: 500,
            body: {
              error: responseError.message,
              code:
                error instanceof SchmockError ? error.code : "INTERNAL_ERROR",
            },
            headers: { "content-type": "application/json" },
          },
          method,
        ),
        responseError,
      );

      // A request that matched a route did happen: it is finalized exactly like
      // a successful one — its own delay override, and a history record.
      await this.#finalizeMatchedRequest({
        method,
        path,
        requestPath,
        params,
        reqQuery,
        reqHeaders,
        requestBody,
        response: errorResponse,
        routeDelay: matchedRoute?.config.delay,
        globalDelay,
        record: matchedRoute !== undefined,
        signal,
        requestGeneration,
        historyGeneration,
        maxHistorySize,
        requestId,
        handleStart,
      });

      return errorResponse;
    }
  }

  /**
   * Finish a request that matched a route.
   *
   * Order matters: delay first (an abort during it must escape before anything
   * is committed), then the history record, then `request:end`, then the logs.
   */
  async #finalizeMatchedRequest(input: {
    method: Schmock.HttpMethod;
    path: string;
    requestPath: string;
    params: Record<string, string>;
    reqQuery: Record<string, string>;
    reqHeaders: Record<string, string>;
    requestBody: unknown;
    response: Schmock.Response;
    routeDelay?: number | [number, number];
    globalDelay?: number | [number, number];
    record: boolean;
    signal?: AbortSignal;
    requestGeneration: RequestGeneration;
    historyGeneration: symbol;
    maxHistorySize?: number;
    requestId: string;
    handleStart: number;
  }): Promise<void> {
    const { response, maxHistorySize } = input;

    // Apply delay (route-level overrides global)
    await this.applyDelay(input.routeDelay, input.globalDelay, input.signal);
    throwIfAborted(input.signal);

    // Record request in history (FIFO-bounded when maxHistorySize is set)
    if (
      input.record &&
      this.requestGeneration === input.requestGeneration &&
      this.historyGeneration === input.historyGeneration &&
      maxHistorySize !== 0
    ) {
      this.requestHistory.push({
        method: input.method,
        path: input.requestPath,
        params: { ...input.params },
        query: { ...input.reqQuery },
        headers: { ...input.reqHeaders },
        body: snapshotHistoryValue(input.requestBody),
        timestamp: Date.now(),
        response: {
          status: response.status,
          body: snapshotHistoryValue(response.body),
        },
      });
      // The constructor already rejected a limit that is not a non-negative
      // integer, so a plain comparison is enough here.
      if (
        maxHistorySize !== undefined &&
        this.requestHistory.length > maxHistorySize
      ) {
        this.requestHistory.splice(
          0,
          this.requestHistory.length - maxHistorySize,
        );
      }
    }

    if (this.requestGeneration === input.requestGeneration) {
      this.emit("request:end", {
        method: input.method,
        path: input.path,
        status: response.status,
        duration: performance.now() - input.handleStart,
      });
    }

    this.logger.log(
      "response",
      `[${input.requestId}] Sending response ${response.status}`,
      {
        status: response.status,
        headers: redactSensitiveHeaders(response.headers),
        bodyType: typeof response.body,
      },
    );
    this.logger.timeEnd(`request-${input.requestId}`);
  }

  /**
   * Finish a request that matched no route — an unknown path or one outside the
   * configured namespace. Misses stay delay-free and out of history: nothing
   * ran, so there is nothing to record.
   */
  #finalizeMiss(input: {
    method: Schmock.HttpMethod;
    path: string;
    requestId: string;
    handleStart: number;
    requestGeneration: RequestGeneration;
  }): Schmock.Response {
    if (this.requestGeneration === input.requestGeneration) {
      this.emit("request:notfound", {
        method: input.method,
        path: input.path,
      });
    }

    const error = new RouteNotFoundError(input.method, input.path);
    const response = markRouteNotFound(
      normalizeResponse(
        {
          status: 404,
          body: { error: error.message, code: error.code },
          headers: { "content-type": "application/json" },
        },
        input.method,
      ),
    );

    if (this.requestGeneration === input.requestGeneration) {
      this.emit("request:end", {
        method: input.method,
        path: input.path,
        status: 404,
        duration: performance.now() - input.handleStart,
      });
    }
    this.logger.timeEnd(`request-${input.requestId}`);
    return response;
  }

  /**
   * Apply configured response delay
   * Supports both fixed delays and random delays within a range
   * @private
   */
  private async applyDelay(
    routeDelay?: number | [number, number],
    globalDelay?: number | [number, number],
    signal?: AbortSignal,
  ): Promise<void> {
    const effectiveDelay = routeDelay ?? globalDelay;
    if (!effectiveDelay) {
      throwIfAborted(signal);
      return;
    }

    const configuredMs = Array.isArray(effectiveDelay)
      ? Math.random() * (effectiveDelay[1] - effectiveDelay[0]) +
        effectiveDelay[0]
      : effectiveDelay;
    const ms = Math.max(0, configuredMs);

    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        try {
          throwIfAborted(signal);
        } catch (error) {
          reject(error);
        }
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
