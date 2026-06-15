import type { Server } from "node:http";
import { normalizePath, toHttpMethod } from "./constants.js";
import {
  errorMessage,
  RouteDefinitionError,
  RouteNotFoundError,
  SchmockError,
} from "./errors.js";
import {
  collectBody,
  parseNodeHeaders,
  parseNodeQuery,
  writeSchmockResponse,
} from "./http-helpers.js";
import { createFetchInterceptor } from "./interceptor.js";
import { parseRouteKey } from "./parser.js";
import { runPluginPipeline } from "./plugin-pipeline.js";
import { parseResponse } from "./response-parser.js";
import type { CompiledCallableRoute } from "./route-matcher.js";
import {
  extractParams,
  findRoute,
  isGeneratorFunction,
} from "./route-matcher.js";

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
  private serverInfo: Schmock.ServerInfo | undefined;
  private interceptHandle: Schmock.InterceptHandle | null = null;
  // biome-ignore lint/complexity/noBannedTypes: internal storage for event listeners with varying signatures
  private listeners = new Map<string, Set<Function>>();

  constructor(private globalConfig: Schmock.GlobalConfig = {}) {
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
      } else if (Buffer.isBuffer(generator)) {
        // Default to octet-stream for buffers
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
    if (plugin.install && this.callableRef) {
      plugin.install(this.callableRef);
    }
    return this;
  }

  // ===== Request Spy / History API =====

  /**
   * FIX 2.3: Deep-clone a request record so callers cannot corrupt internal
   * history by mutating nested body/response objects.
   * Falls back to a shallow spread for bodies that are not structuredClone-able
   * (e.g. Buffers, streams — rare in practice but defensively handled).
   */
  private cloneRecord(r: Schmock.RequestRecord): Schmock.RequestRecord {
    try {
      return structuredClone(r);
    } catch {
      return {
        ...r,
        response: { ...r.response },
      };
    }
  }

  history(method?: Schmock.HttpMethod, path?: string): Schmock.RequestRecord[] {
    if (method || path) {
      return this.requestHistory
        .filter(
          (r) => (!method || r.method === method) && (!path || r.path === path),
        )
        .map((r) => this.cloneRecord(r));
    }
    return this.requestHistory.map((r) => this.cloneRecord(r));
  }

  called(method?: Schmock.HttpMethod, path?: string): boolean {
    if (method || path) {
      return this.requestHistory.some(
        (r) => (!method || r.method === method) && (!path || r.path === path),
      );
    }
    return this.requestHistory.length > 0;
  }

  callCount(method?: Schmock.HttpMethod, path?: string): number {
    if (method || path) {
      return this.requestHistory.filter(
        (r) => (!method || r.method === method) && (!path || r.path === path),
      ).length;
    }
    return this.requestHistory.length;
  }

  lastRequest(
    method?: Schmock.HttpMethod,
    path?: string,
  ): Schmock.RequestRecord | undefined {
    if (method || path) {
      const filtered = this.requestHistory.filter(
        (r) => (!method || r.method === method) && (!path || r.path === path),
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

  private emit(event: string, data: unknown): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        listener(data);
      }
    }
  }

  // ===== Reset / Lifecycle =====

  reset(): void {
    this.interceptHandle?.restore();
    this.interceptHandle = null;
    this.close();
    this.routes = [];
    this.staticRoutes.clear();
    this.plugins = [];
    this.requestHistory = [];
    this.listeners.clear();
    // FIX 3.3: assign a fresh object instead of deleting keys off the caller's
    // reference — this avoids mutating the external state object passed by the user
    if (this.globalConfig.state) {
      this.globalConfig.state = {};
    }
    this.logger.log("lifecycle", "Mock fully reset");
  }

  resetHistory(): void {
    this.requestHistory = [];
    this.logger.log("lifecycle", "Request history cleared");
  }

  resetState(): void {
    // FIX 3.3: assign a fresh object instead of deleting keys off the caller's
    // reference — this avoids mutating the external state object passed by the user
    if (this.globalConfig.state) {
      this.globalConfig.state = {};
    }
    this.logger.log("lifecycle", "State cleared");
  }

  // ===== Standalone Server =====

  listen(port = 0, hostname = "127.0.0.1"): Promise<Schmock.ServerInfo> {
    if (this.server) {
      throw new SchmockError(
        "Server is already running",
        "SERVER_ALREADY_RUNNING",
      );
    }

    // Lazy-load node:http so browser bundles never pull it in. See issue #395.
    return import("node:http").then(({ createServer }) =>
      this.#startHttpServer(createServer, port, hostname),
    );
  }

  #startHttpServer(
    createServer: typeof import("node:http").createServer,
    port: number,
    hostname: string,
  ): Promise<Schmock.ServerInfo> {
    const httpServer = createServer((req, res) => {
      const handleRequest = async () => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const method = toHttpMethod(req.method ?? "GET");
        const path = url.pathname;
        const headers = parseNodeHeaders(req);
        const query = parseNodeQuery(url);
        const body = await collectBody(req, headers);
        const schmockResponse = await this.handle(method, path, {
          headers,
          body,
          query,
        });
        writeSchmockResponse(res, schmockResponse);
      };

      handleRequest().catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(
          JSON.stringify({
            error:
              error instanceof Error ? error.message : "Internal Server Error",
            code: "SERVER_ERROR",
          }),
        );
      });
    });

    this.server = httpServer;

    return new Promise((resolve, reject) => {
      httpServer.on("error", reject);
      httpServer.listen(port, hostname, () => {
        const addr = httpServer.address();
        const actualPort =
          addr !== null && typeof addr === "object" ? addr.port : port;
        this.serverInfo = { port: actualPort, hostname };
        this.logger.log("server", `Listening on ${hostname}:${actualPort}`);
        resolve(this.serverInfo);
      });
    });
  }

  close(): void {
    if (!this.server) {
      return;
    }
    this.server.closeAllConnections();
    this.server.close();
    this.server = undefined;
    this.serverInfo = undefined;
    this.logger.log("server", "Server stopped");
  }

  // ===== Fetch Interceptor =====

  intercept(options?: Schmock.InterceptOptions): Schmock.InterceptHandle {
    if (this.interceptHandle?.active) {
      throw new SchmockError(
        "Already intercepting. Call restore() first.",
        "ALREADY_INTERCEPTING",
      );
    }

    this.interceptHandle = createFetchInterceptor(
      (method, path, opts) => this.handle(method, path, opts),
      options,
    );

    return this.interceptHandle;
  }

  async handle(
    method: Schmock.HttpMethod,
    path: string,
    options?: Schmock.RequestOptions,
  ): Promise<Schmock.Response> {
    const handleStart = performance.now();
    const requestId = this.globalConfig.debug ? crypto.randomUUID() : "";
    const reqQuery = options?.query || {};
    const reqHeaders = options?.headers || {};
    this.logger.log("request", `[${requestId}] ${method} ${path}`, {
      headers: reqHeaders,
      query: reqQuery,
      bodyType: options?.body ? typeof options.body : "none",
    });
    this.logger.time(`request-${requestId}`);

    this.emit("request:start", {
      method,
      path,
      headers: reqHeaders,
    });

    try {
      // Apply namespace if configured
      let requestPath = path;
      if (this.globalConfig.namespace && this.globalConfig.namespace !== "/") {
        const namespace = this.globalConfig.namespace.startsWith("/")
          ? this.globalConfig.namespace
          : `/${this.globalConfig.namespace}`;

        const pathToCheck = path.startsWith("/") ? path : `/${path}`;

        // Check if path starts with namespace
        // handle both "/api/users" (starts with /api) and "/api" (exact match)
        // but NOT "/apiv2" (prefix match but wrong segment)
        const isMatch =
          pathToCheck === namespace ||
          pathToCheck.startsWith(
            namespace.endsWith("/") ? namespace : `${namespace}/`,
          );

        if (!isMatch) {
          this.logger.log(
            "route",
            `[${requestId}] Path doesn't match namespace ${namespace}`,
          );
          const error = new RouteNotFoundError(method, path);
          const response = {
            status: 404,
            body: { error: error.message, code: error.code },
            headers: {},
          };
          this.emit("request:end", {
            method,
            path,
            status: 404,
            duration: performance.now() - handleStart,
          });
          this.logger.timeEnd(`request-${requestId}`);
          return response;
        }

        // Remove namespace prefix, ensuring we always start with /
        const stripped = pathToCheck.slice(namespace.length);
        requestPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
      }

      // Find matching route
      const matchedRoute = findRoute(
        method,
        requestPath,
        this.staticRoutes,
        this.routes,
      );

      if (!matchedRoute) {
        this.logger.log(
          "route",
          `[${requestId}] No route found for ${method} ${requestPath}`,
        );
        this.emit("request:notfound", { method, path: requestPath });
        const error = new RouteNotFoundError(method, path);
        const response = {
          status: 404,
          body: { error: error.message, code: error.code },
          headers: {},
        };
        this.emit("request:end", {
          method,
          path: requestPath,
          status: 404,
          duration: performance.now() - handleStart,
        });
        this.logger.timeEnd(`request-${requestId}`);
        return response;
      }

      this.logger.log(
        "route",
        `[${requestId}] Matched route: ${method} ${matchedRoute.path}`,
      );

      // Extract parameters from the matched route
      const params = extractParams(matchedRoute, requestPath);

      this.emit("request:match", {
        method,
        path: requestPath,
        routePath: matchedRoute.path,
        params,
      });

      // Generate initial response from route handler
      const context: Schmock.RequestContext = {
        method,
        path: requestPath,
        params,
        query: reqQuery,
        headers: reqHeaders,
        body: options?.body,
        state: this.globalConfig.state || {},
      };

      let result: unknown;
      if (isGeneratorFunction(matchedRoute.generator)) {
        result = await matchedRoute.generator(context);
      } else {
        result = matchedRoute.generator;
      }

      // Build plugin context
      let pluginContext: Schmock.PluginContext = {
        path: requestPath,
        route: matchedRoute.config,
        method,
        params,
        query: reqQuery,
        headers: reqHeaders,
        body: options?.body,
        state: new Map(),
        routeState: this.globalConfig.state || {},
      };

      // Run plugin pipeline to transform the response
      try {
        const pipelineResult = await runPluginPipeline(
          this.plugins,
          pluginContext,
          result,
          this.logger,
        );
        pluginContext = pipelineResult.context;
        result = pipelineResult.response;
      } catch (error) {
        this.logger.log(
          "error",
          `[${requestId}] Plugin pipeline error: ${errorMessage(error)}`,
        );
        throw error;
      }

      // Parse and prepare response
      const response = parseResponse(result, matchedRoute.config);

      // Apply delay (route-level overrides global)
      await this.applyDelay(matchedRoute.config.delay);

      // Record request in history (FIFO-bounded when maxHistorySize is set)
      this.requestHistory.push({
        method,
        path: requestPath,
        params,
        query: reqQuery,
        headers: reqHeaders,
        body: options?.body,
        timestamp: Date.now(),
        response: { status: response.status, body: response.body },
      });
      const maxHistorySize = this.globalConfig.maxHistorySize;
      if (
        typeof maxHistorySize === "number" &&
        maxHistorySize >= 0 &&
        this.requestHistory.length > maxHistorySize
      ) {
        this.requestHistory.splice(
          0,
          this.requestHistory.length - maxHistorySize,
        );
      }

      this.emit("request:end", {
        method,
        path: requestPath,
        status: response.status,
        duration: performance.now() - handleStart,
      });

      // Log successful response
      this.logger.log(
        "response",
        `[${requestId}] Sending response ${response.status}`,
        {
          status: response.status,
          headers: response.headers,
          bodyType: typeof response.body,
        },
      );
      this.logger.timeEnd(`request-${requestId}`);

      return response;
    } catch (error) {
      this.logger.log(
        "error",
        `[${requestId}] Error processing request: ${errorMessage(error)}`,
        error,
      );

      // Return error response
      const errorResponse = {
        status: 500,
        body: {
          error: errorMessage(error),
          code: error instanceof SchmockError ? error.code : "INTERNAL_ERROR",
        },
        headers: {},
      };

      // Apply delay even for error responses
      await this.applyDelay();

      this.emit("request:end", {
        method,
        path,
        status: 500,
        duration: performance.now() - handleStart,
      });

      this.logger.log("error", `[${requestId}] Returning error response 500`);
      this.logger.timeEnd(`request-${requestId}`);
      return errorResponse;
    }
  }

  /**
   * Apply configured response delay
   * Supports both fixed delays and random delays within a range
   * @private
   */
  private async applyDelay(
    routeDelay?: number | [number, number],
  ): Promise<void> {
    const effectiveDelay = routeDelay ?? this.globalConfig.delay;
    if (!effectiveDelay) {
      return;
    }

    const ms = Array.isArray(effectiveDelay)
      ? Math.random() * (effectiveDelay[1] - effectiveDelay[0]) +
        effectiveDelay[0]
      : effectiveDelay;

    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
