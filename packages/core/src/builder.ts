import type { Server } from "node:http";
import { awaitWithAbort, throwIfAborted } from "./abort.js";
import { isBinaryBody } from "./binary.js";
import {
  canonicalizePath,
  markResponseException,
  markRouteNotFound,
  matchPathPrefix,
  normalizePath,
  parsePathPrefix,
} from "./constants.js";
import {
  errorMessage,
  RouteDefinitionError,
  RouteNotFoundError,
  SchmockError,
} from "./errors.js";
import { redactHeaders } from "./headers.js";
import { DEFAULT_MAX_BODY_SIZE, serveNodeRequest } from "./http-helpers.js";
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

/**
 * What an admitted request captured at arrival. The transports' public
 * `Schmock.RequestAdmission` wraps one of these.
 */
interface AdmissionSnapshot {
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

function snapshotHistoryValue(value: unknown): unknown {
  try {
    return removeSharedMemory(structuredClone(value));
  } catch {
    return unavailableHistoryValue(value);
  }
}

/**
 * Snapshot a body that already went through `normalizeResponse`.
 *
 * A normalized body is a string, a `JSON.parse` tree or a fresh byte copy, so
 * it can never hold shared memory: the `removeSharedMemory` walk that caller
 * supplied values need would only re-visit every node for nothing.
 */
function snapshotNormalizedBody(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return unavailableHistoryValue(value);
  }
}

/**
 * A per-request copy of a route's config for the plugin context.
 *
 * Shallow on purpose: plugin metadata under `openapi:*` keys is shared,
 * read-only structure (and some of it is keyed by identity in WeakMaps), but a
 * plugin that assigns `context.route.contentType` or edits the delay tuple must
 * not change every later request.
 */
function copyRouteConfig(config: Schmock.RouteConfig): Schmock.RouteConfig {
  const copy: Schmock.RouteConfig = { ...config };
  if (Array.isArray(config.delay)) {
    copy.delay = [config.delay[0], config.delay[1]];
  }
  return copy;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep-copy the plain data (arrays and plain objects) of a static generator so
 * plugins can edit their response in place without changing the route.
 *
 * Anything else — dates, binary values, class instances with a prototype
 * `toJSON` — is passed by reference: `structuredClone` would strip those
 * prototypes (a Buffer would come back as a bare Uint8Array) and change what
 * the response serializes to. Enumerable symbol keys are kept so the response
 * normalizer still sees, and rejects, them.
 */
function copyStaticData(
  value: unknown,
  copies = new Map<object, unknown>(),
): unknown {
  if (typeof value !== "object" || value === null) return value;
  const existing = copies.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    copies.set(value, copy);
    for (let index = 0; index < value.length; index += 1) {
      if (index in value) copy[index] = copyStaticData(value[index], copies);
    }
    for (const key of Object.getOwnPropertySymbols(value)) {
      if (!Object.getOwnPropertyDescriptor(value, key)?.enumerable) continue;
      Reflect.set(copy, key, copyStaticData(Reflect.get(value, key), copies));
    }
    return copy;
  }
  if (!isPlainObject(value)) return value;

  const copy: Record<PropertyKey, unknown> =
    Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  copies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (!Object.getOwnPropertyDescriptor(value, key)?.enumerable) continue;
    copy[key] = copyStaticData(Reflect.get(value, key), copies);
  }
  return copy;
}

interface CanonicalNamespace {
  readonly raw: string;
  readonly prefix: Schmock.PathPrefix;
}

/** What history records about the request, captured before any hook runs. */
interface RequestHistorySnapshot {
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type PluginHook = "install" | "uninstall";

const PLUGIN_HOOK_ERROR_CODES = {
  install: {
    expired: "PLUGIN_INSTALL_SCOPE_EXPIRED",
    unsupported: "PLUGIN_INSTALL_OPERATION_UNSUPPORTED",
  },
  uninstall: {
    expired: "PLUGIN_UNINSTALL_SCOPE_EXPIRED",
    unsupported: "PLUGIN_UNINSTALL_OPERATION_UNSUPPORTED",
  },
} as const satisfies Record<
  PluginHook,
  { expired: string; unsupported: string }
>;

/**
 * Optional hooks that break the plugin when set to a truthy non-function:
 * `install` threw a TypeError from pipe() and `beforeRequest` failed every
 * matched request. Falsy values (`onError: null`, `install: false`) are how
 * callers switch a hook off and keep working; `onError`/`uninstall` failures
 * only ever surfaced on paths that already fail or log, so they are left alone.
 */
const EAGER_PLUGIN_HOOKS = ["install", "beforeRequest"] as const;

function describeInvalidPlugin(plugin: unknown): string | undefined {
  if (
    (typeof plugin !== "object" && typeof plugin !== "function") ||
    plugin === null
  ) {
    return "expected a plugin object";
  }
  if (typeof Reflect.get(plugin, "process") !== "function") {
    return "process must be a function";
  }
  for (const hook of EAGER_PLUGIN_HOOKS) {
    const value: unknown = Reflect.get(plugin, hook);
    if (value && typeof value !== "function") {
      return `${hook} must be a function when set`;
    }
  }
  return undefined;
}

/**
 * Reject, when it is piped, a plugin that could never work: one without a
 * `process` function answered every matched request with a 500 instead.
 * Only shapes that already failed are rejected, so no working setup breaks.
 */
function assertValidPlugin(plugin: unknown): asserts plugin is Schmock.Plugin {
  const reason = describeInvalidPlugin(plugin);
  if (reason === undefined) return;
  const name: unknown =
    typeof plugin === "object" && plugin !== null
      ? Reflect.get(plugin, "name")
      : undefined;
  const label = typeof name === "string" && name.length > 0 ? ` "${name}"` : "";
  throw new SchmockError(
    `Invalid plugin${label}: ${reason}`,
    "PLUGIN_INVALID",
    {
      plugin: typeof name === "string" ? name : undefined,
      reason,
    },
  );
}

/** `request:end` status for a request its caller cancelled. */
const ABORTED_REQUEST_STATUS = 499;

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
  private namespaceCache: CanonicalNamespace | undefined;
  /**
   * True once an admission holds `routes`/`staticRoutes` by reference: the
   * next registration copies them first (copy-on-write) instead of every
   * request copying the whole route table.
   */
  private routesShared = false;
  /** Retired generations whose uninstall waits for in-flight requests. */
  private retiredGenerations = new Set<RequestGeneration>();

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
    // treated as the same route (consistent with the static-route Map key below).
    // Routes that differ only in parameter names (`/users/:id` and
    // `/users/:userId`) compile to the same pattern and match the same
    // requests, so the later one would be unreachable: it is a duplicate too.
    const normalizedParsedPath = normalizePath(parsed.path);
    const existing = this.routes.find(
      (r) =>
        r.method === parsed.method &&
        (normalizePath(r.path) === normalizedParsedPath ||
          r.pattern.source === parsed.pattern.source),
    );
    if (existing) {
      this.logger.log(
        "warning",
        normalizePath(existing.path) === normalizedParsedPath
          ? `Duplicate route: ${route} — first registration wins`
          : `Duplicate route: ${route} matches the same requests as ${existing.method} ${existing.path} — first registration wins`,
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

    this.#writableRoutes();
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

  /**
   * Copy-on-write for the route tables. An admitted request routes with the
   * containers it captured, by reference; the first registration after that
   * copies them so the in-flight snapshot never changes underneath it.
   */
  #writableRoutes(): void {
    if (!this.routesShared) return;
    this.routes = this.routes.slice();
    this.staticRoutes = new Map(this.staticRoutes);
    this.routesShared = false;
  }

  setCallableRef(ref: Schmock.CallableMockInstance): void {
    this.callableRef = ref;
  }

  pipe(plugin: Schmock.Plugin): this {
    assertValidPlugin(plugin);
    if (this.plugins.includes(plugin)) {
      // Piping one object twice used to run install() twice and process()
      // twice per request. It is a no-op rather than an error because the
      // pattern is common and was silently accepted: `.pipe(p)` chained after
      // every route definition, or a beforeEach that pipes without a reset.
      // Distinct objects that share a name (two openapi() specs) still stack.
      this.logger.log(
        "warning",
        `Plugin ${plugin.name} is already piped into this mock — ignored`,
      );
      return this;
    }
    this.#uninstallRetiredInstallation(plugin);

    if (plugin.install && this.callableRef) {
      const previousRoutes = this.routes;
      const previousStaticRoutes = this.staticRoutes;
      const previousRoutesShared = this.routesShared;
      this.routes = previousRoutes.slice();
      this.staticRoutes = new Map(previousStaticRoutes);
      this.routesShared = false;

      let installActive = true;
      const installFacade = this.#createHookFacade({
        plugin,
        hook: "install",
        isActive: () => installActive,
        registerRoute: (route, generator, config) => {
          this.defineRoute(route, generator, config);
        },
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
        this.routesShared = previousRoutesShared;
        throw error;
      } finally {
        installActive = false;
      }
    }

    // Replaced, never pushed into: in-flight admissions hold the old array.
    this.plugins = [...this.plugins, plugin];
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

  /**
   * The instance a plugin hook receives. Reads are live; route registration is
   * allowed only when the hook passes `registerRoute` (install does, uninstall
   * does not); every other operation is rejected. `isActive` expires the
   * facade when the hook returns, so a retained reference cannot act later.
   */
  #createHookFacade(input: {
    plugin: Schmock.Plugin;
    hook: PluginHook;
    isActive: () => boolean;
    registerRoute?: (
      route: Schmock.RouteKey,
      generator: Schmock.Generator,
      config: Schmock.RouteConfig,
    ) => void;
  }): Schmock.CallableMockInstance {
    const { plugin, hook, isActive, registerRoute } = input;
    const codes = PLUGIN_HOOK_ERROR_CODES[hook];
    const requireScope = () => {
      if (isActive()) return;
      throw new SchmockError(
        `Plugin "${plugin.name}" used its ${hook} instance outside ${hook}()`,
        codes.expired,
        { plugin: plugin.name },
      );
    };
    const reject = (operation: string): never => {
      requireScope();
      throw new SchmockError(
        `Plugin "${plugin.name}" cannot call ${operation} during ${hook}()`,
        codes.unsupported,
        { operation, plugin: plugin.name },
      );
    };
    let facade: Schmock.CallableMockInstance;
    const defineRoute = (
      route: Schmock.RouteKey,
      generator: Schmock.Generator,
      config: Schmock.RouteConfig = {},
    ): Schmock.CallableMockInstance => {
      if (!registerRoute) return reject("route registration");
      requireScope();
      registerRoute(route, generator, config);
      return facade;
    };
    facade = Object.assign(defineRoute, {
      pipe: () => reject("pipe()"),
      handle: () => reject("handle()"),
      history: (method?: Schmock.HttpMethod, path?: string) => {
        requireScope();
        return this.history(method, path);
      },
      called: (method?: Schmock.HttpMethod, path?: string) => {
        requireScope();
        return this.called(method, path);
      },
      callCount: (method?: Schmock.HttpMethod, path?: string) => {
        requireScope();
        return this.callCount(method, path);
      },
      lastRequest: (method?: Schmock.HttpMethod, path?: string) => {
        requireScope();
        return this.lastRequest(method, path);
      },
      reset: () => reject("reset()"),
      resetHistory: () => reject("resetHistory()"),
      resetState: () => reject("resetState()"),
      on: () => reject("on()"),
      off: () => reject("off()"),
      getRoutes: () => {
        requireScope();
        return this.getRoutes();
      },
      getState: () => {
        requireScope();
        return this.getState();
      },
      listen: () => reject("listen()"),
      close: () => reject("close()"),
      intercept: () => reject("intercept()"),
    });
    return facade;
  }

  /**
   * Run the uninstall a retired generation still owes this plugin object, now,
   * before it is installed again. Left to the retired generation, it would run
   * when that generation's last request settles — after the new install() —
   * and tear down the live installation.
   */
  #uninstallRetiredInstallation(plugin: Schmock.Plugin): void {
    for (const generation of this.retiredGenerations) {
      const pending = generation.retiredPlugins;
      if (!pending?.includes(plugin)) continue;
      generation.retiredPlugins = pending.filter(
        (retired) => retired !== plugin,
      );
      this.uninstallPlugins([plugin]);
    }
  }

  private uninstallPlugins(plugins: readonly Schmock.Plugin[]): void {
    for (let index = plugins.length - 1; index >= 0; index -= 1) {
      const plugin = plugins[index];
      if (!plugin.uninstall || !this.callableRef) continue;

      // Cleanup gets a read-only, expiring instance: through the live one a
      // plugin could pipe plugins or register routes into the mock that
      // reset() just cleared.
      let uninstallActive = true;
      const uninstallFacade = this.#createHookFacade({
        plugin,
        hook: "uninstall",
        isActive: () => uninstallActive,
      });
      try {
        const uninstallResult: unknown = plugin.uninstall(uninstallFacade);
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
      } finally {
        uninstallActive = false;
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
        body: snapshotNormalizedBody(r.response.body),
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
    // Replaced, never cleared in place: in-flight admissions still route with
    // the old containers.
    this.routes = [];
    this.staticRoutes = new Map();
    this.routesShared = false;
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

  #captureRequestAdmission(): AdmissionSnapshot {
    const requestGeneration = this.requestGeneration;
    requestGeneration.activeAdmissions += 1;
    // O(1) snapshot: the containers are captured by reference. `plugins` is
    // only ever replaced, and the route tables are copy-on-write.
    this.routesShared = true;
    return {
      requestGeneration,
      historyGeneration: this.historyGeneration,
      plugins: this.plugins,
      routes: this.routes,
      staticRoutes: this.staticRoutes,
      state: this.globalConfig.state,
      namespace: this.globalConfig.namespace,
      globalDelay: this.globalConfig.delay,
      maxHistorySize: this.globalConfig.maxHistorySize,
      released: false,
    };
  }

  #releaseRequestAdmission(admission: AdmissionSnapshot): void {
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
      this.retiredGenerations.delete(generation);
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
      return;
    }
    this.retiredGenerations.add(generation);
  }

  createRequestAdmission(): Schmock.RequestAdmission {
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
      // Lazy-load node:http so browser bundles never pull it in (issue #395).
      // The rejection handler must sit on the import() expression itself:
      // esbuild (and so the Angular application builder) leaves a dynamic
      // import unresolved only when that expression handles its own failure,
      // and the outer .catch() below does not count. Without it a
      // `platform: "browser"` build fails with `Could not resolve "node:http"`.
      .then(() =>
        import("node:http").catch((error: unknown) => {
          throw error;
        }),
      )
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
      // Admitted on arrival, before the request is parsed, so a reset() while
      // its body uploads neither changes its routes nor uninstalls its plugins.
      const admittedRequest = this.createRequestAdmission();
      void serveNodeRequest(req, res, {
        handle: admittedRequest.handle,
        maxBodySize: DEFAULT_MAX_BODY_SIZE,
      }).finally(() => admittedRequest.release());
    });

    operation.server = httpServer;

    const handleStartupError = (error: Error) => {
      this.#rejectServerStart(operation, error);
    };
    httpServer.once("error", handleStartupError);

    // Once listening, a server-level 'error' (an accept failure such as
    // EMFILE) must still have a listener: with none, Node rethrows it as an
    // uncaught exception and takes the whole test runner down.
    const reportServerError = (error: Error) => {
      this.logger.log("server", `Server error: ${errorMessage(error)}`);
    };

    try {
      httpServer.listen(operation.port, operation.hostname, () => {
        // Attach the permanent reporter BEFORE dropping the startup handler:
        // the other order leaves a window with no 'error' listener at all.
        httpServer.on("error", reportServerError);
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
    admission?: AdmissionSnapshot,
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
    admission: AdmissionSnapshot,
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
      headers: redactHeaders(reqHeaders),
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
    let routeConfig: Schmock.RouteConfig | undefined;
    let params: Record<string, string> = {};
    let historyParams: Record<string, string> = {};
    let historySnapshot: RequestHistorySnapshot | undefined;

    try {
      // Apply namespace if configured. A root namespace ("/") parses to the
      // empty prefix and strips nothing.
      const namespacePrefix = namespace
        ? this.#namespacePrefix(namespace)
        : undefined;
      if (namespacePrefix !== undefined && namespacePrefix.path !== "") {
        const pathToCheck = path.startsWith("/") ? path : `/${path}`;

        // Segment-boundary match: "/api" serves "/api" and "/api/users" but
        // not "/apiv2". The trailing-slash rule is parsePathPrefix's, shared
        // with intercept({ baseUrl }): "/api/" is the same namespace as "/api".
        if (!matchPathPrefix(namespacePrefix, pathToCheck)) {
          this.logger.log(
            "route",
            `[${requestId}] Path doesn't match namespace ${namespacePrefix.path}`,
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
        const stripped = pathToCheck.slice(namespacePrefix.path.length);
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
      // History reports what the CLIENT sent, so it is captured here, before
      // any plugin or the generator gets the live objects and can edit them.
      historyParams = { ...params };
      if (maxHistorySize !== 0) {
        historySnapshot = {
          query: { ...reqQuery },
          headers: { ...reqHeaders },
          body: snapshotHistoryValue(requestBody),
        };
      }
      // A per-request copy: a plugin that edits `context.route` in place
      // changes this request only, never the registered route.
      routeConfig = copyRouteConfig(matchedRoute.config);

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
        route: routeConfig,
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
            // Static data is one object shared by every request; plugins get
            // their own copy so an in-place edit cannot leak into the next
            // response (or back into the caller's object).
            result =
              requestPlugins.length > 0
                ? copyStaticData(matchedRoute.generator)
                : matchedRoute.generator;
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
        parseResponse(result, routeConfig),
        method,
      );

      await this.#finalizeMatchedRequest({
        method,
        path,
        requestPath,
        params: historyParams,
        historySnapshot,
        response,
        routeDelay: routeConfig.delay,
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
      // Every exit after `request:start` ends with exactly one `request:end`;
      // a cancelled request reports 499 (client closed request) before its
      // abort reason propagates.
      this.#throwIfRequestAborted(signal, {
        method,
        path,
        handleStart,
        requestGeneration,
      });
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
      try {
        await this.#finalizeMatchedRequest({
          method,
          path,
          requestPath,
          params: historyParams,
          historySnapshot,
          response: errorResponse,
          routeDelay: routeConfig?.delay,
          globalDelay,
          record: matchedRoute !== undefined,
          signal,
          requestGeneration,
          historyGeneration,
          maxHistorySize,
          requestId,
          handleStart,
        });
      } catch (finalizeError) {
        // Only the delay can reject here, and only with the abort reason.
        this.#throwIfRequestAborted(signal, {
          method,
          path,
          handleStart,
          requestGeneration,
        });
        throw finalizeError;
      }

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
    historySnapshot: RequestHistorySnapshot | undefined;
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
    const { response, maxHistorySize, historySnapshot } = input;

    // Apply delay (route-level overrides global)
    await this.applyDelay(input.routeDelay, input.globalDelay, input.signal);
    throwIfAborted(input.signal);

    // Record request in history (FIFO-bounded when maxHistorySize is set)
    if (
      input.record &&
      historySnapshot !== undefined &&
      this.requestGeneration === input.requestGeneration &&
      this.historyGeneration === input.historyGeneration &&
      maxHistorySize !== 0
    ) {
      this.requestHistory.push({
        method: input.method,
        path: input.requestPath,
        params: { ...input.params },
        query: historySnapshot.query,
        headers: historySnapshot.headers,
        body: historySnapshot.body,
        timestamp: Date.now(),
        response: {
          status: response.status,
          body: snapshotNormalizedBody(response.body),
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
        headers: redactHeaders(response.headers),
        bodyType: typeof response.body,
      },
    );
    this.logger.timeEnd(`request-${input.requestId}`);
  }

  /**
   * Rethrow a cancellation after reporting it as the request's terminal
   * event, so a `request:start` listener always sees exactly one
   * `request:end`. 499 is the de facto "client closed request" status.
   */
  #throwIfRequestAborted(
    signal: AbortSignal | undefined,
    request: {
      method: Schmock.HttpMethod;
      path: string;
      handleStart: number;
      requestGeneration: RequestGeneration;
    },
  ): void {
    if (!signal?.aborted) return;
    if (this.requestGeneration === request.requestGeneration) {
      this.emit("request:end", {
        method: request.method,
        path: request.path,
        status: ABORTED_REQUEST_STATUS,
        duration: performance.now() - request.handleStart,
      });
    }
    throwIfAborted(signal);
  }

  /**
   * The namespace as the path prefix request paths are compared with:
   * percent-encoded, with a leading slash and without a trailing one, so
   * `"/api/"` and `"/api"` behave identically (both serve `/api`, neither
   * serves `/api//users`). `""` for a root namespace. Only the path of an
   * origin-form namespace is used. Cached per namespace string instead of
   * re-parsed per request.
   */
  #namespacePrefix(namespace: string): Schmock.PathPrefix {
    const cached = this.namespaceCache;
    if (cached?.raw === namespace) return cached.prefix;
    const prefix = parsePathPrefix(namespace);
    this.namespaceCache = { raw: namespace, prefix };
    return prefix;
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
