import { awaitWithAbort, throwIfAborted } from "./abort.js";
import {
  canonicalizePath,
  markResponseException,
  markRouteNotFound,
  matchPathPrefix,
  normalizePath,
  parsePathPrefix,
} from "./constants.js";
import { DebugLogger } from "./debug-logger.js";
import { applyResponseDelay } from "./delay.js";
import { errorMessage, RouteNotFoundError, SchmockError } from "./errors.js";
import { MockEvents } from "./events.js";
import type { RequestGeneration } from "./generations.js";
import { RequestGenerations } from "./generations.js";
import { redactHeaders } from "./headers.js";
import type { RequestHistorySnapshot } from "./history.js";
import { RequestHistory } from "./history.js";
import { createFetchLease, NORMALIZED_ADMISSION_KEY } from "./interceptor.js";
import { NodeServerController } from "./node-server.js";
import {
  assertValidPlugin,
  runInstallHook,
  runUninstallHooks,
} from "./plugin-hooks.js";
import {
  recoverGeneratorError,
  runPluginBeforeRequest,
  runPluginPipeline,
} from "./plugin-pipeline.js";
import {
  buildJsonErrorResponse,
  normalizeResponse,
} from "./response-normalizer.js";
import { parseResponse } from "./response-parser.js";
import type { CompiledCallableRoute } from "./route-matcher.js";
import {
  extractParams,
  findRoute,
  isGeneratorFunction,
} from "./route-matcher.js";
import type { RouteTableSnapshot } from "./route-table.js";
import { copyRouteConfig, copyStaticData, RouteTable } from "./route-table.js";

type InternalGlobalConfig = Omit<Schmock.GlobalConfig, "state"> & {
  state: Record<string, unknown>;
};

/**
 * What an admitted request captured at arrival. The transports' public
 * `Schmock.RequestAdmission` wraps one of these.
 */
interface AdmissionSnapshot {
  readonly requestGeneration: RequestGeneration;
  readonly historyGeneration: symbol;
  readonly plugins: readonly Schmock.Plugin[];
  readonly routes: RouteTableSnapshot;
  readonly state: Record<string, unknown>;
  readonly namespace?: string;
  readonly globalDelay?: number | [number, number];
  released: boolean;
}

interface CanonicalNamespace {
  readonly raw: string;
  readonly prefix: Schmock.PathPrefix;
}

/** Where a request path lands in its admission's route table. */
type RouteResolution =
  | { readonly kind: "outside-namespace"; readonly namespacePath: string }
  | { readonly kind: "no-route"; readonly requestPath: string }
  | {
      readonly kind: "match";
      readonly route: CompiledCallableRoute;
      /** The namespace-stripped, normalized path the route matched. */
      readonly requestPath: string;
    };

/** A request bound to the route it matched. */
interface RouteMatch {
  readonly route: CompiledCallableRoute;
  readonly requestPath: string;
  /** The live parameters plugins and the generator receive. */
  readonly params: Record<string, string>;
  /** The parameters as the client sent them, for history. */
  readonly historyParams: Record<string, string>;
  /** `undefined` when history is disabled. */
  readonly historySnapshot: RequestHistorySnapshot | undefined;
  /** This request's own copy of the route config. */
  readonly routeConfig: Schmock.RouteConfig;
}

/** One admitted request, threaded through every stage of `handle()`. */
interface RequestScope {
  readonly method: Schmock.HttpMethod;
  /** The canonical path every lifecycle event, log line and 404 reports. */
  readonly path: string;
  readonly admission: AdmissionSnapshot;
  readonly signal: AbortSignal | undefined;
  readonly handleStart: number;
  readonly requestId: string;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  /**
   * Set once a route matched, so a request that fails afterwards is finalized
   * like a successful one: its own delay override and a history record.
   */
  match?: RouteMatch;
}

/** A matched request's response between pipeline stages. */
interface ResponseDraft {
  readonly context: Schmock.PluginContext;
  readonly result: unknown;
  /** An onError hook recovered: the response processors are skipped. */
  readonly recovered: boolean;
}

/** `request:end` status for a request its caller cancelled. */
const ABORTED_REQUEST_STATUS = 499;

/**
 * Callable mock instance that implements the new API.
 *
 * @internal
 */
export class CallableMockInstance {
  private readonly routeTable = new RouteTable();
  private plugins: Schmock.Plugin[] = [];
  private logger: DebugLogger;
  private readonly requestHistory: RequestHistory;
  private readonly nodeServer: NodeServerController;
  private callableRef: Schmock.CallableMockInstance | undefined;
  private interceptHandles = new Set<Schmock.InterceptHandle>();
  private readonly generations = new RequestGenerations((plugins) =>
    this.uninstallPlugins(plugins),
  );
  private interceptOwner = Symbol("schmock.intercept.owner");
  private globalConfig: InternalGlobalConfig;
  private readonly events: MockEvents;
  private namespaceCache: CanonicalNamespace | undefined;

  constructor(globalConfig: Schmock.GlobalConfig = {}) {
    // First: an invalid maxHistorySize throws before anything else is built.
    this.requestHistory = new RequestHistory(globalConfig.maxHistorySize);
    this.globalConfig = {
      ...globalConfig,
      state: globalConfig.state ?? {},
    };
    this.logger = new DebugLogger(globalConfig.debug || false);
    this.events = new MockEvents(this.logger);
    this.nodeServer = new NodeServerController({
      admitRequest: () => this.createRequestAdmission(),
      logger: this.logger,
    });
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
    this.routeTable.define({ route, generator, config, logger: this.logger });
    return this;
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
    this.generations.uninstallBeforeReinstall(plugin);

    if (plugin.install && this.callableRef) {
      // Routes the hook registers before it fails are rolled back with it.
      const checkpoint = this.routeTable.checkpoint();
      try {
        runInstallHook({
          plugin,
          reads: this,
          registerRoute: (route, generator, config) => {
            this.defineRoute(route, generator, config);
          },
          logger: this.logger,
        });
      } catch (error) {
        this.routeTable.rollback(checkpoint);
        throw error;
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

  private uninstallPlugins(plugins: readonly Schmock.Plugin[]): void {
    if (!this.callableRef) return;
    runUninstallHooks({ plugins, reads: this, logger: this.logger });
  }

  // ===== Request Spy / History API =====

  history(method?: Schmock.HttpMethod, path?: string): Schmock.RequestRecord[] {
    return this.requestHistory.history(method, path);
  }

  called(method?: Schmock.HttpMethod, path?: string): boolean {
    return this.requestHistory.called(method, path);
  }

  callCount(method?: Schmock.HttpMethod, path?: string): number {
    return this.requestHistory.callCount(method, path);
  }

  lastRequest(
    method?: Schmock.HttpMethod,
    path?: string,
  ): Schmock.RequestRecord | undefined {
    return this.requestHistory.lastRequest(method, path);
  }

  // ===== Introspection =====

  getRoutes(): Schmock.RouteInfo[] {
    return this.routeTable.list();
  }

  getState(): Record<string, unknown> {
    return { ...(this.globalConfig.state || {}) };
  }

  // ===== Lifecycle Events =====

  on<E extends Schmock.SchmockEvent>(
    event: E,
    listener: (data: Schmock.SchmockEventMap[E]) => void,
  ): this {
    this.events.on(event, listener);
    return this;
  }

  off<E extends Schmock.SchmockEvent>(
    event: E,
    listener: (data: Schmock.SchmockEventMap[E]) => void,
  ): this {
    this.events.off(event, listener);
    return this;
  }

  // ===== Reset / Lifecycle =====

  reset(): void {
    const retiredGeneration = this.generations.advance();
    this.requestHistory.startGeneration();
    this.close();
    const installedPlugins = this.plugins;
    this.plugins = [];
    this.generations.retire(retiredGeneration, installedPlugins);
    // Replaced, never cleared in place: in-flight admissions still route with
    // the old containers.
    this.routeTable.clear();
    this.requestHistory.clear();
    this.events.clear();
    this.globalConfig.state = {};
    this.logger.log("lifecycle", "Mock fully reset");
  }

  resetHistory(): void {
    this.requestHistory.startGeneration();
    this.requestHistory.clear();
    this.logger.log("lifecycle", "Request history cleared");
  }

  resetState(): void {
    this.globalConfig.state = {};
    this.logger.log("lifecycle", "State cleared");
  }

  #captureRequestAdmission(): AdmissionSnapshot {
    const requestGeneration = this.generations.admit();
    // O(1) snapshot: the containers are captured by reference. `plugins` is
    // only ever replaced, and the route tables are copy-on-write.
    return {
      requestGeneration,
      historyGeneration: this.requestHistory.generation,
      plugins: this.plugins,
      routes: this.routeTable.share(),
      state: this.globalConfig.state,
      namespace: this.globalConfig.namespace,
      globalDelay: this.globalConfig.delay,
      released: false,
    };
  }

  #releaseRequestAdmission(admission: AdmissionSnapshot): void {
    if (admission.released) return;
    admission.released = true;
    this.generations.release(admission.requestGeneration);
  }

  createRequestAdmission(): Schmock.RequestAdmission {
    const admission = this.#captureRequestAdmission();
    const admitted = {
      handle: (
        method: Schmock.HttpMethod,
        path: string,
        options?: Schmock.RequestOptions,
      ) => this.handle(method, path, options, admission),
      release: () => this.#releaseRequestAdmission(admission),
      // Whether handle(method, path) would reach a route, answered from this
      // admission's own snapshot by the resolver handle() itself uses, so a
      // miss is never a false negative. The interceptor asks it to skip
      // reading the body of a request that will pass through anyway.
      hasRoute: (method: Schmock.HttpMethod, path: string) => {
        try {
          const resolution = this.#resolveRoute(
            method,
            canonicalizePath(path),
            admission,
          );
          return resolution.kind === "match";
        } catch {
          // Whatever made the resolver throw, handle() must answer it.
          return true;
        }
      },
      // handle() above normalizes every response for its method, so the
      // interceptor may send one on without a second normalizing pass.
      [NORMALIZED_ADMISSION_KEY]: true,
    };
    return admitted;
  }

  // ===== Standalone Server =====

  listen(port = 0, hostname = "127.0.0.1"): Promise<Schmock.ServerInfo> {
    return this.nodeServer.listen(port, hostname);
  }

  close(): void {
    this.nodeServer.close();
  }

  // ===== Fetch Interceptor =====

  intercept(options?: Schmock.InterceptOptions): Schmock.InterceptHandle {
    // Ownership is a lease, not a lock: nested providers, separate roots, and
    // a manual intercept() alongside an adapter each get their own registry
    // slot with their own options, released independently. The owner symbol
    // keeps them one mock for dispatch, so a single request reaches handle()
    // once no matter how many leases this instance holds.
    const lease = createFetchLease({
      handle: (method, path, opts) => this.handle(method, path, opts),
      options,
      admitRequest: () => this.createRequestAdmission(),
      owner: this.interceptOwner,
    });

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

  // ===== Request Handling =====

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
    const signal = options?.signal;
    throwIfAborted(signal);

    const scope: RequestScope = {
      method,
      path,
      admission,
      signal,
      handleStart: performance.now(),
      requestId: this.globalConfig.debug ? crypto.randomUUID() : "",
      query: { ...(options?.query ?? {}) },
      headers: { ...(options?.headers ?? {}) },
      body: options?.body,
    };
    const { requestId } = scope;
    this.logger.log("request", `[${requestId}] ${method} ${path}`, {
      headers: redactHeaders(scope.headers),
      query: scope.query,
      // Presence, not truthiness: "", 0 and false are bodies too.
      bodyType:
        options !== undefined && "body" in options && options.body !== undefined
          ? typeof options.body
          : "none",
    });
    this.logger.time(`request-${requestId}`);

    if (this.generations.isCurrent(admission.requestGeneration)) {
      this.events.emit("request:start", {
        method,
        path,
        headers: scope.headers,
      });
    }

    try {
      const resolution = this.#resolveRoute(method, path, admission);
      if (resolution.kind !== "match") {
        this.logger.log(
          "route",
          resolution.kind === "outside-namespace"
            ? `[${requestId}] Path doesn't match namespace ${resolution.namespacePath}`
            : `[${requestId}] No route found for ${method} ${resolution.requestPath}`,
        );
        // A request outside the namespace is a route miss like any other, so
        // it reports one instead of silently ending.
        return this.#finalizeMiss(scope);
      }

      const match = this.#bindRoute(scope, resolution);
      scope.match = match;
      if (this.generations.isCurrent(admission.requestGeneration)) {
        this.events.emit("request:match", {
          method,
          // Every lifecycle event carries the ORIGINAL request path; the
          // namespace-stripped route form is exposed as routePath.
          path,
          routePath: match.route.path,
          params: match.params,
        });
      }
      throwIfAborted(signal);

      let draft = await this.#runPreflight(scope, match);
      if (draft.result === undefined) {
        draft = await this.#runGenerator(scope, match, draft);
      }
      const response = await this.#runResponsePipeline(scope, match, draft);
      await this.#finalizeMatchedRequest(scope, response);
      return response;
    } catch (error) {
      return await this.#answerFailedRequest(scope, error);
    }
  }

  /**
   * Where a request path lands in the admission's route table: outside the
   * namespace, on no route, or on a route. It only resolves — no logs, no
   * events — so `handle()` and the admission's route probe share it and can
   * never disagree. `path` must already be canonical.
   */
  #resolveRoute(
    method: Schmock.HttpMethod,
    path: string,
    admission: AdmissionSnapshot,
  ): RouteResolution {
    let requestPath = path;
    // Apply namespace if configured. A root namespace ("/") parses to the
    // empty prefix and strips nothing.
    const namespacePrefix = admission.namespace
      ? this.#namespacePrefix(admission.namespace)
      : undefined;
    if (namespacePrefix !== undefined && namespacePrefix.path !== "") {
      const pathToCheck = path.startsWith("/") ? path : `/${path}`;

      // Segment-boundary match: "/api" serves "/api" and "/api/users" but
      // not "/apiv2". The trailing-slash rule is parsePathPrefix's, shared
      // with intercept({ baseUrl }): "/api/" is the same namespace as "/api".
      if (!matchPathPrefix(namespacePrefix, pathToCheck)) {
        return {
          kind: "outside-namespace",
          namespacePath: namespacePrefix.path,
        };
      }

      // Remove namespace prefix, ensuring we always start with /
      const stripped = pathToCheck.slice(namespacePrefix.path.length);
      requestPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
    }

    // One trailing-slash normalization for the whole request: route lookup
    // and parameter extraction must see the identical string, or a request
    // could match a route and then capture no parameters.
    requestPath = normalizePath(requestPath);

    const route = findRoute(
      method,
      requestPath,
      admission.routes.staticRoutes,
      admission.routes.routes,
    );
    return route
      ? { kind: "match", route, requestPath }
      : { kind: "no-route", requestPath };
  }

  /**
   * Bind a request to the route it matched: its parameters, what history
   * will record, and its own copy of the route config.
   */
  #bindRoute(
    scope: RequestScope,
    resolution: { route: CompiledCallableRoute; requestPath: string },
  ): RouteMatch {
    const { route, requestPath } = resolution;
    this.logger.log(
      "route",
      `[${scope.requestId}] Matched route: ${scope.method} ${route.path}`,
    );

    const params = extractParams(route, requestPath);
    return {
      route,
      requestPath,
      params,
      // History reports what the CLIENT sent, so it is captured here, before
      // any plugin or the generator gets the live objects and can edit them.
      historyParams: { ...params },
      historySnapshot: this.requestHistory.snapshotRequest(scope),
      // A per-request copy: a plugin that edits `context.route` in place
      // changes this request only, never the registered route.
      routeConfig: copyRouteConfig(route.config),
    };
  }

  /**
   * Build the plugin context and run the plugins' `beforeRequest` guards, so
   * they can reject invalid or unauthorized requests before any route code
   * runs.
   */
  async #runPreflight(
    scope: RequestScope,
    match: RouteMatch,
  ): Promise<ResponseDraft> {
    const { signal } = scope;
    const pluginContext: Schmock.PluginContext = {
      path: match.requestPath,
      route: match.routeConfig,
      method: scope.method,
      params: match.params,
      query: scope.query,
      headers: scope.headers,
      body: scope.body,
      state: new Map(),
      routeState: scope.admission.state,
      signal,
    };

    const preflight = await runPluginBeforeRequest(
      scope.admission.plugins,
      pluginContext,
      this.logger,
      signal,
    );
    throwIfAborted(signal);
    return {
      context:
        preflight.requestShortCircuited === true
          ? { ...preflight.context, requestShortCircuited: true }
          : preflight.context,
      result: preflight.response,
      recovered: preflight.recoveredFromError === true,
    };
  }

  /**
   * Produce the route's response, and give the plugins' `onError` hooks the
   * chance to recover when the generator throws.
   */
  async #runGenerator(
    scope: RequestScope,
    match: RouteMatch,
    draft: ResponseDraft,
  ): Promise<ResponseDraft> {
    const { signal } = scope;
    const { context: pluginContext } = draft;
    const plugins = scope.admission.plugins;
    const context: Schmock.RequestContext = {
      method: pluginContext.method,
      path: pluginContext.path,
      params: pluginContext.params,
      query: pluginContext.query,
      headers: pluginContext.headers,
      body: pluginContext.body,
      state: pluginContext.routeState ?? scope.admission.state,
      pluginState: pluginContext.state,
      signal,
    };

    try {
      let result: unknown;
      if (isGeneratorFunction(match.route.generator)) {
        result = await awaitWithAbort(match.route.generator(context), signal);
      } else {
        // Static data is one object shared by every request; plugins get
        // their own copy so an in-place edit cannot leak into the next
        // response (or back into the caller's object).
        result =
          plugins.length > 0
            ? copyStaticData(match.route.generator)
            : match.route.generator;
      }
      throwIfAborted(signal);
      return { ...draft, result };
    } catch (error) {
      throwIfAborted(signal);
      const recovery = await recoverGeneratorError(
        plugins,
        pluginContext,
        error,
        this.logger,
        signal,
      );
      throwIfAborted(signal);
      return {
        context: recovery.context,
        result: recovery.response,
        recovered: recovery.recoveredFromError === true,
      };
    }
  }

  /**
   * Run the plugins' response processors (skipped after an error recovery)
   * and turn the result into the normalized response.
   */
  async #runResponsePipeline(
    scope: RequestScope,
    match: RouteMatch,
    draft: ResponseDraft,
  ): Promise<Schmock.Response> {
    let result = draft.result;
    try {
      if (draft.recovered) {
        this.logger.log(
          "pipeline",
          "Skipping response processors after error recovery",
        );
      } else {
        const pipelineResult = await runPluginPipeline(
          scope.admission.plugins,
          draft.context,
          result,
          this.logger,
          scope.signal,
        );
        throwIfAborted(scope.signal);
        result = pipelineResult.response;
      }
    } catch (error) {
      this.logger.log(
        "error",
        `[${scope.requestId}] Plugin pipeline error: ${errorMessage(error)}`,
      );
      throw error;
    }

    return normalizeResponse(
      parseResponse(result, match.routeConfig),
      scope.method,
    );
  }

  /**
   * Answer a request that failed after `request:start` with a marked 500.
   * Every such exit ends with exactly one `request:end`; a cancelled request
   * reports 499 (client closed request) before its abort reason propagates.
   */
  async #answerFailedRequest(
    scope: RequestScope,
    error: unknown,
  ): Promise<Schmock.Response> {
    this.#throwIfRequestAborted(scope);
    this.logger.log(
      "error",
      `[${scope.requestId}] Error processing request: ${errorMessage(error)}`,
      error,
    );

    const responseError =
      error instanceof Error ? error : new Error(errorMessage(error));
    const errorResponse = markResponseException(
      buildJsonErrorResponse({
        status: 500,
        error: responseError.message,
        code: error instanceof SchmockError ? error.code : "INTERNAL_ERROR",
        method: scope.method,
      }),
      responseError,
    );

    // A request that matched a route did happen: it is finalized exactly like
    // a successful one — its own delay override, and a history record.
    try {
      await this.#finalizeMatchedRequest(scope, errorResponse);
    } catch (finalizeError) {
      // Only the delay can reject here, and only with the abort reason.
      this.#throwIfRequestAborted(scope);
      throw finalizeError;
    }

    return errorResponse;
  }

  /**
   * Finish a request after `request:start`, matched or failed.
   *
   * Order matters: delay first (an abort during it must escape before anything
   * is committed), then the history record, then `request:end`, then the logs.
   */
  async #finalizeMatchedRequest(
    scope: RequestScope,
    response: Schmock.Response,
  ): Promise<void> {
    const { admission, match, signal } = scope;

    // Apply delay (route-level overrides global)
    await applyResponseDelay({
      routeDelay: match?.routeConfig.delay,
      globalDelay: admission.globalDelay,
      signal,
    });
    throwIfAborted(signal);

    // Record request in history (FIFO-bounded when maxHistorySize is set)
    const historySnapshot = match?.historySnapshot;
    if (
      match !== undefined &&
      historySnapshot !== undefined &&
      this.generations.isCurrent(admission.requestGeneration)
    ) {
      this.requestHistory.record({
        generation: admission.historyGeneration,
        method: scope.method,
        path: match.requestPath,
        params: match.historyParams,
        snapshot: historySnapshot,
        response,
      });
    }

    if (this.generations.isCurrent(admission.requestGeneration)) {
      this.events.emit("request:end", {
        method: scope.method,
        path: scope.path,
        status: response.status,
        duration: performance.now() - scope.handleStart,
      });
    }

    this.logger.log(
      "response",
      `[${scope.requestId}] Sending response ${response.status}`,
      {
        status: response.status,
        headers: redactHeaders(response.headers),
        bodyType: typeof response.body,
      },
    );
    this.logger.timeEnd(`request-${scope.requestId}`);
  }

  /**
   * Rethrow a cancellation after reporting it as the request's terminal
   * event, so a `request:start` listener always sees exactly one
   * `request:end`. 499 is the de facto "client closed request" status.
   */
  #throwIfRequestAborted(scope: RequestScope): void {
    const { signal } = scope;
    if (!signal?.aborted) return;
    if (this.generations.isCurrent(scope.admission.requestGeneration)) {
      this.events.emit("request:end", {
        method: scope.method,
        path: scope.path,
        status: ABORTED_REQUEST_STATUS,
        duration: performance.now() - scope.handleStart,
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
  #finalizeMiss(scope: RequestScope): Schmock.Response {
    const { method, path } = scope;
    // Checked before each event: a listener may reset the mock in between.
    if (this.generations.isCurrent(scope.admission.requestGeneration)) {
      this.events.emit("request:notfound", { method, path });
    }

    const error = new RouteNotFoundError(method, path);
    const response = markRouteNotFound(
      buildJsonErrorResponse({
        status: 404,
        error: error.message,
        code: error.code,
        method,
      }),
    );

    if (this.generations.isCurrent(scope.admission.requestGeneration)) {
      this.events.emit("request:end", {
        method,
        path,
        status: 404,
        duration: performance.now() - scope.handleStart,
      });
    }
    this.logger.timeEnd(`request-${scope.requestId}`);
    return response;
  }
}
