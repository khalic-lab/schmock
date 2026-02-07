import {
  PluginError,
  RouteDefinitionError,
  RouteNotFoundError,
  SchmockError,
} from "./errors.js";
import { parseRouteKey } from "./parser.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
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
 * Compiled callable route with pattern matching
 */
interface CompiledCallableRoute {
  pattern: RegExp;
  params: string[];
  method: Schmock.HttpMethod;
  path: string;
  generator: Schmock.Generator;
  config: Schmock.RouteConfig;
}

function isGeneratorFunction(
  gen: Schmock.Generator,
): gen is Schmock.GeneratorFunction {
  return typeof gen === "function";
}

function isResponseObject(value: unknown): value is {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value
  );
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
    // Auto-detect contentType if not provided
    if (!config.contentType) {
      if (typeof generator === "function") {
        // Default to JSON for function generators
        config.contentType = "application/json";
      } else if (
        typeof generator === "string" ||
        typeof generator === "number" ||
        typeof generator === "boolean"
      ) {
        // Default to plain text for primitives
        config.contentType = "text/plain";
      } else if (Buffer.isBuffer(generator)) {
        // Default to octet-stream for buffers
        config.contentType = "application/octet-stream";
      } else {
        // Default to JSON for objects/arrays
        config.contentType = "application/json";
      }
    }

    // Validate generator matches contentType if it's static data
    if (
      typeof generator !== "function" &&
      config.contentType === "application/json"
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

    // Check for duplicate routes
    const existing = this.routes.find(
      (r) => r.method === parsed.method && r.path === parsed.path,
    );
    if (existing) {
      this.logger.log(
        "warning",
        `Duplicate route: ${route} — first registration wins`,
      );
    }

    // Compile the route
    const compiledRoute: CompiledCallableRoute = {
      pattern: parsed.pattern,
      params: parsed.params,
      method: parsed.method,
      path: parsed.path,
      generator,
      config,
    };

    this.routes.push(compiledRoute);

    // Store static routes (no params) in Map for O(1) lookup
    // Only store the first registration — "first registration wins" semantics
    if (parsed.params.length === 0) {
      const normalizedPath =
        parsed.path.endsWith("/") && parsed.path !== "/"
          ? parsed.path.slice(0, -1)
          : parsed.path;
      const key = `${parsed.method} ${normalizedPath}`;
      if (!this.staticRoutes.has(key)) {
        this.staticRoutes.set(key, compiledRoute);
      }
    }

    this.logger.log("route", `Route defined: ${route}`, {
      contentType: config.contentType,
      generatorType: typeof generator,
      hasParams: parsed.params.length > 0,
    });

    return this;
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
    return this;
  }

  // ===== Request Spy / History API =====

  history(method?: Schmock.HttpMethod, path?: string): Schmock.RequestRecord[] {
    if (method && path) {
      return this.requestHistory.filter(
        (r) => r.method === method && r.path === path,
      );
    }
    return [...this.requestHistory];
  }

  called(method?: Schmock.HttpMethod, path?: string): boolean {
    if (method && path) {
      return this.requestHistory.some(
        (r) => r.method === method && r.path === path,
      );
    }
    return this.requestHistory.length > 0;
  }

  callCount(method?: Schmock.HttpMethod, path?: string): number {
    if (method && path) {
      return this.requestHistory.filter(
        (r) => r.method === method && r.path === path,
      ).length;
    }
    return this.requestHistory.length;
  }

  lastRequest(
    method?: Schmock.HttpMethod,
    path?: string,
  ): Schmock.RequestRecord | undefined {
    if (method && path) {
      const filtered = this.requestHistory.filter(
        (r) => r.method === method && r.path === path,
      );
      return filtered[filtered.length - 1];
    }
    return this.requestHistory[this.requestHistory.length - 1];
  }

  // ===== Reset / Lifecycle =====

  reset(): void {
    this.routes = [];
    this.staticRoutes.clear();
    this.plugins = [];
    this.requestHistory = [];
    if (this.globalConfig.state) {
      for (const key of Object.keys(this.globalConfig.state)) {
        delete this.globalConfig.state[key];
      }
    }
    this.logger.log("lifecycle", "Mock fully reset");
  }

  resetHistory(): void {
    this.requestHistory = [];
    this.logger.log("lifecycle", "Request history cleared");
  }

  resetState(): void {
    if (this.globalConfig.state) {
      for (const key of Object.keys(this.globalConfig.state)) {
        delete this.globalConfig.state[key];
      }
    }
    this.logger.log("lifecycle", "State cleared");
  }

  async handle(
    method: Schmock.HttpMethod,
    path: string,
    options?: Schmock.RequestOptions,
  ): Promise<Schmock.Response> {
    const requestId = crypto.randomUUID();
    this.logger.log("request", `[${requestId}] ${method} ${path}`, {
      headers: options?.headers,
      query: options?.query,
      bodyType: options?.body ? typeof options.body : "none",
    });
    this.logger.time(`request-${requestId}`);

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
          this.logger.timeEnd(`request-${requestId}`);
          return response;
        }

        // Remove namespace prefix, ensuring we always start with /
        const stripped = pathToCheck.slice(namespace.length);
        requestPath = stripped.startsWith("/") ? stripped : `/${stripped}`;
      }

      // Find matching route
      const matchedRoute = this.findRoute(method, requestPath);

      if (!matchedRoute) {
        this.logger.log(
          "route",
          `[${requestId}] No route found for ${method} ${requestPath}`,
        );
        const error = new RouteNotFoundError(method, path);
        const response = {
          status: 404,
          body: { error: error.message, code: error.code },
          headers: {},
        };
        this.logger.timeEnd(`request-${requestId}`);
        return response;
      }

      this.logger.log(
        "route",
        `[${requestId}] Matched route: ${method} ${matchedRoute.path}`,
      );

      // Extract parameters from the matched route
      const params = this.extractParams(matchedRoute, requestPath);

      // Generate initial response from route handler
      const context: Schmock.RequestContext = {
        method,
        path: requestPath,
        params,
        query: options?.query || {},
        headers: options?.headers || {},
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
        query: options?.query || {},
        headers: options?.headers || {},
        body: options?.body,
        state: new Map(),
        routeState: this.globalConfig.state || {},
      };

      // Run plugin pipeline to transform the response
      try {
        const pipelineResult = await this.runPluginPipeline(
          pluginContext,
          result,
          matchedRoute.config,
          requestId,
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
      const response = this.parseResponse(result, matchedRoute.config);

      // Apply global delay if configured
      await this.applyDelay();

      // Record request in history
      this.requestHistory.push({
        method,
        path: requestPath,
        params,
        query: options?.query || {},
        headers: options?.headers || {},
        body: options?.body,
        timestamp: Date.now(),
        response: { status: response.status, body: response.body },
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

      // Apply global delay if configured (even for error responses)
      await this.applyDelay();

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
  private async applyDelay(): Promise<void> {
    if (!this.globalConfig.delay) {
      return;
    }

    const delay = Array.isArray(this.globalConfig.delay)
      ? Math.random() *
          (this.globalConfig.delay[1] - this.globalConfig.delay[0]) +
        this.globalConfig.delay[0]
      : this.globalConfig.delay;

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Parse and normalize response result into Response object
   * Handles tuple format [status, body, headers], direct values, and response objects
   * @param result - Raw result from generator or plugin
   * @param routeConfig - Route configuration for content-type defaults
   * @returns Normalized Response object with status, body, and headers
   * @private
   */
  private parseResponse(
    result: unknown,
    routeConfig: Schmock.RouteConfig,
  ): Schmock.Response {
    let status = 200;
    let body: unknown = result;
    let headers: Record<string, string> = {};

    let tupleFormat = false;

    // Handle already-formed response objects (from plugin error recovery)
    if (isResponseObject(result)) {
      return {
        status: result.status,
        body: result.body,
        headers: result.headers || {},
      };
    }

    // Handle tuple response format [status, body, headers?]
    if (Array.isArray(result) && typeof result[0] === "number") {
      [status, body, headers = {}] = result;
      tupleFormat = true;
    }

    // Handle null/undefined responses with 204 No Content
    // But don't auto-convert if tuple format was used (status was explicitly provided)
    if (body === null || body === undefined) {
      if (!tupleFormat) {
        status = status === 200 ? 204 : status; // Only change to 204 if status wasn't explicitly set via tuple
      }
      body = undefined; // Ensure body is undefined for null responses
    }

    // Add content-type header from route config if it exists and headers don't already have it
    // But only if this isn't a tuple response (where headers are explicitly controlled)
    if (!headers["content-type"] && routeConfig.contentType && !tupleFormat) {
      headers["content-type"] = routeConfig.contentType;

      // Handle special conversion cases when contentType is explicitly set
      if (routeConfig.contentType === "text/plain" && body !== undefined) {
        if (typeof body === "object" && !Buffer.isBuffer(body)) {
          body = JSON.stringify(body);
        } else if (typeof body !== "string") {
          body = String(body);
        }
      }
    }

    return {
      status,
      body,
      headers,
    };
  }

  /**
   * Run all registered plugins in sequence
   * First plugin to set response becomes generator, subsequent plugins transform
   * Handles plugin errors via onError hooks
   * @param context - Plugin context with request details
   * @param initialResponse - Initial response from route generator
   * @param _routeConfig - Route config (unused but kept for signature)
   * @param _requestId - Request ID (unused but kept for signature)
   * @returns Updated context and final response after all plugins
   * @private
   */
  private async runPluginPipeline(
    context: Schmock.PluginContext,
    initialResponse?: unknown,
    _routeConfig?: Schmock.RouteConfig,
    _requestId?: string,
  ): Promise<{ context: Schmock.PluginContext; response?: unknown }> {
    let currentContext = context;
    let response: unknown = initialResponse;

    this.logger.log(
      "pipeline",
      `Running plugin pipeline for ${this.plugins.length} plugins`,
    );

    for (const plugin of this.plugins) {
      this.logger.log("pipeline", `Processing plugin: ${plugin.name}`);

      try {
        const result = await plugin.process(currentContext, response);

        if (!result || !result.context) {
          throw new Error(`Plugin ${plugin.name} didn't return valid result`);
        }

        currentContext = result.context;

        // First plugin to set response becomes the generator
        if (
          result.response !== undefined &&
          (response === undefined || response === null)
        ) {
          this.logger.log(
            "pipeline",
            `Plugin ${plugin.name} generated response`,
          );
          response = result.response;
        } else if (result.response !== undefined && response !== undefined) {
          this.logger.log(
            "pipeline",
            `Plugin ${plugin.name} transformed response`,
          );
          response = result.response;
        }
      } catch (error) {
        this.logger.log(
          "pipeline",
          `Plugin ${plugin.name} failed: ${errorMessage(error)}`,
        );

        // Try error handling if plugin has onError hook
        if (plugin.onError) {
          try {
            const pluginError =
              error instanceof Error ? error : new Error(errorMessage(error));
            const errorResult = await plugin.onError(
              pluginError,
              currentContext,
            );
            if (errorResult) {
              this.logger.log(
                "pipeline",
                `Plugin ${plugin.name} handled error`,
              );

              // Error return → transform the thrown error
              if (errorResult instanceof Error) {
                throw new PluginError(plugin.name, errorResult);
              }

              // ResponseResult return → recover, stop pipeline
              if (
                typeof errorResult === "object" &&
                errorResult !== null &&
                "status" in errorResult
              ) {
                response = errorResult;
                break;
              }
            }
            // void/falsy return → propagate original error below
          } catch (hookError) {
            // If the hook itself threw (including our PluginError above), re-throw it
            if (hookError instanceof PluginError) {
              throw hookError;
            }
            this.logger.log(
              "pipeline",
              `Plugin ${plugin.name} error handler failed: ${errorMessage(hookError)}`,
            );
          }
        }

        const cause =
          error instanceof Error ? error : new Error(errorMessage(error));
        throw new PluginError(plugin.name, cause);
      }
    }

    return { context: currentContext, response };
  }

  /**
   * Find a route that matches the given method and path
   * Uses two-pass matching: static routes first, then parameterized routes
   * Matches routes in registration order (first registered wins)
   * @param method - HTTP method to match
   * @param path - Request path to match
   * @returns Matched compiled route or undefined if no match
   * @private
   */
  private findRoute(
    method: Schmock.HttpMethod,
    path: string,
  ): CompiledCallableRoute | undefined {
    // O(1) lookup for static routes
    const normalizedPath =
      path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
    const staticMatch = this.staticRoutes.get(`${method} ${normalizedPath}`);
    if (staticMatch) {
      return staticMatch;
    }

    // Fall through to parameterized route scan
    for (const route of this.routes) {
      if (
        route.method === method &&
        route.params.length > 0 &&
        route.pattern.test(path)
      ) {
        return route;
      }
    }

    return undefined;
  }

  /**
   * Extract parameter values from path based on route pattern
   * Maps capture groups from regex match to parameter names
   * @param route - Compiled route with pattern and param names
   * @param path - Request path to extract values from
   * @returns Object mapping parameter names to extracted values
   * @private
   */
  private extractParams(
    route: CompiledCallableRoute,
    path: string,
  ): Record<string, string> {
    const match = path.match(route.pattern);
    if (!match) return {};

    const params: Record<string, string> = {};
    route.params.forEach((param, index) => {
      params[param] = match[index + 1];
    });

    return params;
  }
}
