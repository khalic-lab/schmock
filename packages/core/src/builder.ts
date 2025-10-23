import {
  PluginError,
  RouteDefinitionError,
  RouteNotFoundError,
  SchmockError,
} from "./errors";
import { parseRouteKey } from "./parser";

/**
 * Debug logger that respects debug mode configuration
 */
class DebugLogger {
  constructor(private enabled = false) {}

  log(category: string, message: string, data?: any) {
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

/**
 * Callable mock instance that implements the new API.
 *
 * @internal
 */
export class CallableMockInstance {
  private routes: CompiledCallableRoute[] = [];
  private plugins: Schmock.Plugin[] = [];
  private logger: DebugLogger;

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

  async handle(
    method: Schmock.HttpMethod,
    path: string,
    options?: Schmock.RequestOptions,
  ): Promise<Schmock.Response> {
    const requestId = Math.random().toString(36).substring(7);
    this.logger.log("request", `[${requestId}] ${method} ${path}`, {
      headers: options?.headers,
      query: options?.query,
      bodyType: options?.body ? typeof options.body : "none",
    });
    this.logger.time(`request-${requestId}`);

    try {
      // Apply namespace if configured
      let requestPath = path;
      if (this.globalConfig.namespace) {
        // Normalize namespace to handle edge cases
        const namespace = this.globalConfig.namespace;
        if (namespace === "/") {
          // Root namespace means no transformation needed
          requestPath = path;
        } else {
          // Handle namespace without leading slash by normalizing both namespace and path
          const normalizedNamespace = namespace.startsWith("/")
            ? namespace
            : `/${namespace}`;
          const normalizedPath = path.startsWith("/") ? path : `/${path}`;

          // Remove trailing slash from namespace unless it's root
          const finalNamespace =
            normalizedNamespace.endsWith("/") && normalizedNamespace !== "/"
              ? normalizedNamespace.slice(0, -1)
              : normalizedNamespace;

          if (!normalizedPath.startsWith(finalNamespace)) {
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
          requestPath = normalizedPath.substring(finalNamespace.length);
          if (!requestPath.startsWith("/")) {
            requestPath = `/${requestPath}`;
          }
        }
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

      let result: any;
      if (typeof matchedRoute.generator === "function") {
        result = await (matchedRoute.generator as Schmock.GeneratorFunction)(
          context,
        );
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
          `[${requestId}] Plugin pipeline error: ${(error as Error).message}`,
        );
        throw error;
      }

      // Parse and prepare response
      const response = this.parseResponse(result, matchedRoute.config);

      // Apply global delay if configured
      await this.applyDelay();

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
        `[${requestId}] Error processing request: ${(error as Error).message}`,
        error,
      );

      // Return error response
      const errorResponse = {
        status: 500,
        body: {
          error: (error as Error).message,
          code:
            error instanceof SchmockError
              ? (error as SchmockError).code
              : "INTERNAL_ERROR",
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

  private parseResponse(
    result: any,
    routeConfig: Schmock.RouteConfig,
  ): Schmock.Response {
    let status = 200;
    let body = result;
    let headers: Record<string, string> = {};

    let tupleFormat = false;

    // Handle already-formed response objects (from plugin error recovery)
    if (
      result &&
      typeof result === "object" &&
      "status" in result &&
      "body" in result
    ) {
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

  private async runPluginPipeline(
    context: Schmock.PluginContext,
    initialResponse?: any,
    _routeConfig?: Schmock.RouteConfig,
    _requestId?: string,
  ): Promise<{ context: Schmock.PluginContext; response?: any }> {
    let currentContext = context;
    let response: any = initialResponse;

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
          `Plugin ${plugin.name} failed: ${(error as Error).message}`,
        );

        // Try error handling if plugin has onError hook
        if (plugin.onError) {
          try {
            const errorResult = await plugin.onError(
              error as Error,
              currentContext,
            );
            if (errorResult) {
              this.logger.log(
                "pipeline",
                `Plugin ${plugin.name} handled error`,
              );
              // If error handler returns response, use it and stop pipeline
              if (typeof errorResult === "object" && errorResult.status) {
                // Return the error response as the current response, stop pipeline
                response = errorResult;
                break;
              }
            }
          } catch (hookError) {
            this.logger.log(
              "pipeline",
              `Plugin ${plugin.name} error handler failed: ${(hookError as Error).message}`,
            );
          }
        }

        throw new PluginError(plugin.name, error as Error);
      }
    }

    return { context: currentContext, response };
  }

  /**
   * Find a route that matches the given method and path.
   */
  private findRoute(
    method: Schmock.HttpMethod,
    path: string,
  ): CompiledCallableRoute | undefined {
    // First pass: Look for exact matches (routes without parameters)
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const route = this.routes[i];
      if (
        route.method === method &&
        route.params.length === 0 &&
        route.pattern.test(path)
      ) {
        return route;
      }
    }

    // Second pass: Look for parameterized routes
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const route = this.routes[i];
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
   * Extract parameter values from the path based on the route pattern.
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
