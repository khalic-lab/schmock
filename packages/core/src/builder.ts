type Plugin = Schmock.Plugin;

import {
  PluginError,
  ResponseGenerationError,
  RouteDefinitionError,
  RouteNotFoundError,
  SchmockError,
} from "./errors";
import type { ParsedRoute } from "./parser";
import { parseRouteKey } from "./parser";
import type {
  Builder,
  BuilderConfig,
  HttpMethod,
  MockInstance,
  ResponseContext,
  RouteDefinition,
  Routes,
} from "./types";

interface BuilderState<TState> {
  config?: BuilderConfig;
  routes?: Routes<TState>;
  state?: TState;
  plugins: Plugin[];
}

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

interface CompiledRoute<TState> extends ParsedRoute {
  definition: RouteDefinition<TState>;
}

/**
 * Fluent builder for creating Schmock instances.
 *
 * @internal
 */
export class SchmockBuilder<TState = unknown> implements Builder<TState> {
  private options: BuilderState<TState> = {
    plugins: [],
  };
  private logger = new DebugLogger(false);

  config(options: BuilderConfig): Builder<TState> {
    this.options.config = { ...this.options.config, ...options };

    // Update logger debug mode when config changes
    if (options.debug !== undefined) {
      this.logger = new DebugLogger(options.debug);
      this.logger.log("config", "Debug mode enabled");
    }

    return this;
  }

  routes(routes: Routes<TState>): Builder<TState> {
    this.options.routes = { ...this.options.routes, ...routes };
    return this;
  }

  state<T>(initial: T): Builder<T> {
    const newBuilder = new SchmockBuilder<T>();
    newBuilder.options = {
      ...this.options,
      state: initial,
    } as BuilderState<T>;
    return newBuilder;
  }

  use(plugin: Plugin | (() => Plugin)): Builder<TState> {
    try {
      const resolvedPlugin = typeof plugin === "function" ? plugin() : plugin;
      this.options.plugins.push(resolvedPlugin);

      this.logger.log(
        "plugin",
        `Registered plugin: ${resolvedPlugin.name}@${resolvedPlugin.version}`,
        {
          name: resolvedPlugin.name,
          version: resolvedPlugin.version,
          hasProcess: typeof resolvedPlugin.process === "function",
          hasOnError: typeof resolvedPlugin.onError === "function",
        },
      );

      return this;
    } catch (error) {
      const pluginName =
        typeof plugin === "function" ? "unknown" : plugin.name || "unknown";
      this.logger.log(
        "plugin",
        `Failed to register plugin: ${pluginName}`,
        error,
      );
      throw new PluginError(pluginName, error as Error);
    }
  }

  build(): MockInstance<TState> {
    this.logger.log("build", "Building Schmock instance");
    this.logger.time("build");

    const compiledRoutes = this.compileRoutes();
    const state = this.options.state || ({} as TState);

    this.logger.log("build", `Compiled ${compiledRoutes.length} routes`);
    this.logger.log("build", `Loaded ${this.options.plugins.length} plugins`);

    // Pass debug config to the instance
    const debugEnabled = this.options.config?.debug || false;
    const instance = new SchmockInstance(
      compiledRoutes,
      state as TState,
      this.options.plugins,
      debugEnabled,
    );

    this.logger.timeEnd("build");
    this.logger.log("build", "Schmock instance ready");

    return instance;
  }

  /**
   * Compile route definitions into parsed routes with patterns.
   * Applies namespace prefix if configured.
   */
  private compileRoutes(): CompiledRoute<TState>[] {
    const routes = this.options.routes || {};
    const namespace = this.options.config?.namespace || "";

    return Object.entries(routes).map(([routeKey, definition]) => {
      if (!definition) {
        throw new RouteDefinitionError(
          routeKey,
          "Route definition is required",
        );
      }
      const parsed = parseRouteKey(routeKey);

      // Apply namespace if configured
      if (namespace) {
        parsed.path = namespace + parsed.path;
        // Rebuild pattern with namespace
        const regexPath = parsed.path
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/:([^/]+)/g, "([^/]+)");
        parsed.pattern = new RegExp(`^${regexPath}$`);
      }

      return {
        ...parsed,
        definition,
      };
    });
  }
}

/**
 * Mock instance that handles requests based on configured routes.
 *
 * @internal
 */
class SchmockInstance<TState> implements MockInstance<TState> {
  private eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  private plugins: Plugin[];
  private logger: DebugLogger;

  constructor(
    private routes: CompiledRoute<TState>[],
    private state: TState,
    plugins: Plugin[] = [],
    debugEnabled = false,
  ) {
    this.logger = new DebugLogger(debugEnabled);
    this.plugins = plugins;

    this.logger.log("instance", "SchmockInstance created", {
      routeCount: routes.length,
      pluginCount: plugins.length,
      debugEnabled,
    });
  }

  async handle(
    method: HttpMethod,
    path: string,
    options?: {
      headers?: Record<string, string>;
      body?: unknown;
      query?: Record<string, string>;
    },
  ): Promise<{
    status: number;
    body: unknown;
    headers: Record<string, string>;
  }> {
    const requestId = Math.random().toString(36).substring(7);
    this.logger.log("request", `[${requestId}] ${method} ${path}`, {
      headers: options?.headers,
      query: options?.query,
      bodyType: options?.body ? typeof options.body : "none",
    });
    this.logger.time(`request-${requestId}`);

    try {
      // Find matching route
      const route = this.findRoute(method, path);

      if (!route) {
        this.logger.log(
          "route",
          `[${requestId}] No route found for ${method} ${path}`,
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
        `[${requestId}] Matched route: ${route.pattern}`,
      );

      // Build initial plugin context
      let pluginContext: Schmock.PluginContext = {
        path,
        route: route.definition as any,
        method,
        params: this.extractParams(route, path),
        query: options?.query || {},
        headers: options?.headers || {},
        body: options?.body,
        state: new Map(),
        routeState: this.state,
      };

      // Run plugin pipeline
      let result: any;

      try {
        const pipelineResult = await this.runPluginPipeline(pluginContext);
        pluginContext = pipelineResult.context;
        result = pipelineResult.response;
      } catch (error) {
        this.logger.log(
          "error",
          `[${requestId}] Plugin pipeline error: ${(error as Error).message}`,
        );
        throw error;
      }

      // Track if we explicitly got a response
      let hasExplicitResponse = result !== undefined;

      // Fallback to route handler if no plugin generated response
      if (result === undefined && route.definition.response) {
        const context: ResponseContext<TState> = {
          state: this.state,
          params: pluginContext.params,
          query: pluginContext.query,
          body: pluginContext.body,
          headers: pluginContext.headers,
          method,
          path,
        };
        result = await route.definition.response(context);
        hasExplicitResponse = true; // Even if the response is undefined, it was explicitly returned
      }

      // Error if no response generator at all
      if (!hasExplicitResponse) {
        throw new ResponseGenerationError(
          `${method} ${path}`,
          new Error("No response generated - check plugins and route handlers"),
        );
      }

      // Parse and prepare response
      const response = this.parseResponse(result);

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

  /**
   * Find a route that matches the given method and path.
   */
  private findRoute(
    method: HttpMethod,
    path: string,
  ): CompiledRoute<TState> | undefined {
    return this.routes.find(
      (route) => route.method === method && route.pattern.test(path),
    );
  }

  /**
   * Extract parameter values from the path based on the route pattern.
   */
  private extractParams(
    route: CompiledRoute<TState>,
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

  /**
   * Subscribe to an event.
   */
  on(event: string, handler: (data: unknown) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)?.add(handler);
  }

  /**
   * Unsubscribe from an event.
   */
  off(event: string, handler: (data: unknown) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit an event to all registered handlers.
   */

  /**
   * Parse response from various formats
   */
  private parseResponse(result: any): {
    status: number;
    body: unknown;
    headers: Record<string, string>;
  } {
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
      return {
        status: 200,
        body: result,
        headers: {},
      };
    }
    return {
      status: 200,
      body: result,
      headers: {},
    };
  }

  /**
   * Run plugin pipeline
   */
  private async runPluginPipeline(
    context: Schmock.PluginContext,
  ): Promise<{ context: Schmock.PluginContext; response?: any }> {
    let currentContext = context;
    let response: any;

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
}

/**
 * Callable mock instance that implements the new API.
 *
 * @internal
 */
interface CompiledCallableRoute {
  pattern: RegExp;
  params: string[];
  method: Schmock.HttpMethod;
  path: string;
  generator: Schmock.Generator;
  config: Schmock.RouteConfig;
}

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
      return {
        status: 200,
        body: result,
        headers: {},
      };
    }
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
