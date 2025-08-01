import {
  PluginError,
  ResponseGenerationError,
  RouteDefinitionError,
  RouteNotFoundError,
  SchmockError,
} from "./errors";
import type { ParsedRoute } from "./parser";
import { parseRouteKey } from "./parser";
import type { HttpMethod } from "./types";

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
      } else if (typeof generator === "string") {
        // Default to plain text for strings
        config.contentType = "text/plain";
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
        if (!path.startsWith(this.globalConfig.namespace)) {
          this.logger.log(
            "route",
            `[${requestId}] Path doesn't match namespace ${this.globalConfig.namespace}`,
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
        requestPath = path.substring(this.globalConfig.namespace.length);
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
      const response = this.parseResponse(result);

      // Apply global delay if configured
      if (this.globalConfig.delay) {
        const delay = Array.isArray(this.globalConfig.delay)
          ? Math.random() *
              (this.globalConfig.delay[1] - this.globalConfig.delay[0]) +
            this.globalConfig.delay[0]
          : this.globalConfig.delay;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

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

      this.logger.log("error", `[${requestId}] Returning error response 500`);
      this.logger.timeEnd(`request-${requestId}`);
      return errorResponse;
    }
  }

  private parseResponse(result: any): Schmock.Response {
    if (Array.isArray(result)) {
      // Check if it's a tuple response [status, body, headers?]
      if (typeof result[0] === "number") {
        const [status, body, headers] = result;
        return {
          status,
          body,
          headers: headers || {},
        };
      }
    }

    // Default response with 200 status
    return {
      status: 200,
      body: result,
      headers: {},
    };
  }

  private async runPluginPipeline(
    context: Schmock.PluginContext,
    initialResponse?: any,
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
        if (result.response !== undefined && response === undefined) {
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
              // If error handler returns response, use it
              if (typeof errorResult === "object" && errorResult.status) {
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
    return this.routes.find(
      (route) => route.method === method && route.pattern.test(path),
    );
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