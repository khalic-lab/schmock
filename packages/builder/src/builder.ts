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
          enforce: resolvedPlugin.enforce,
          hooks: Object.keys(resolvedPlugin).filter((key) =>
            [
              "beforeRequest",
              "beforeGenerate",
              "generate",
              "afterGenerate",
              "beforeResponse",
              "onError",
              "transform",
            ].includes(key),
          ),
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
    const state = this.options.state;

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
  private sortedPlugins: Plugin[];
  private logger: DebugLogger;

  constructor(
    private routes: CompiledRoute<TState>[],
    private state: TState,
    private plugins: Plugin[] = [],
    debugEnabled = false,
  ) {
    this.logger = new DebugLogger(debugEnabled);

    // Sort plugins by enforce property
    this.sortedPlugins = this.sortPlugins(plugins);

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

    // Emit request:start event
    this.emit("request:start", { method, path });

    try {
      // Find matching route
      const route = this.findRoute(method, path);

      if (!route) {
        this.logger.log(
          "route",
          `[${requestId}] No route found for ${method} ${path}`,
        );
        const error = new RouteNotFoundError(method, path);
        this.emit("error", { error, method, path });
        const response = {
          status: 404,
          body: { error: error.message, code: error.code },
          headers: {},
        };
        this.emit("request:end", { method, path, status: 404 });
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

      // Run beforeRequest hooks
      pluginContext = await this.runBeforeRequestHooks(pluginContext);

      // Build response context for route functions
      const context: ResponseContext<TState> = {
        state: this.state,
        params: pluginContext.params,
        query: pluginContext.query,
        body: pluginContext.body,
        headers: pluginContext.headers,
        method,
        path,
      };

      // Check beforeGenerate hooks for early response
      const earlyResponse = await this.runBeforeGenerateHooks(pluginContext);
      if (earlyResponse !== undefined) {
        // Plugin returned early response
        let result = earlyResponse;

        // Run afterGenerate hooks
        result = await this.runAfterGenerateHooks(result, pluginContext);

        // Parse and prepare response
        let response = this.parseResponse(result);

        // Run beforeResponse hooks
        response = await this.runBeforeResponseHooks(response, pluginContext);

        this.emit("request:end", { method, path, status: response.status });
        return response;
      }

      // Execute response function or generate data via plugins
      let result: any;

      if (route.definition.response) {
        // Route has explicit response function
        result = await route.definition.response(context);
      } else {
        // No response function - try plugins
        result = await this.generateViaPlugins(route, pluginContext);

        if (result === undefined) {
          throw new ResponseGenerationError(
            `${method} ${path}`,
            new Error("No response function or plugin could handle route"),
          );
        }
      }

      // Run afterGenerate hooks
      result = await this.runAfterGenerateHooks(result, pluginContext);

      // Parse and prepare response
      let response = this.parseResponse(result);

      // Run beforeResponse hooks
      response = await this.runBeforeResponseHooks(response, pluginContext);

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

      // Emit request:end event
      this.emit("request:end", { method, path, status: response.status });

      return response;
    } catch (error) {
      this.logger.log(
        "error",
        `[${requestId}] Error processing request: ${(error as Error).message}`,
        error,
      );

      // Create plugin context for error handling
      const errorContext: Schmock.PluginContext = {
        path,
        method,
        params: {},
        query: options?.query || {},
        headers: options?.headers || {},
        body: options?.body,
        state: new Map(),
        route: {} as any, // Empty route for error context
        routeState: this.state,
      };

      // Run onError hooks
      const errorResult = await this.runOnErrorHooks(
        error as Error,
        errorContext,
      );

      // Check if plugin handled the error with a response
      if (
        errorResult &&
        typeof errorResult === "object" &&
        "status" in errorResult
      ) {
        const response = errorResult as {
          status: number;
          body: unknown;
          headers: Record<string, string>;
        };
        this.logger.log(
          "error",
          `[${requestId}] Plugin handled error with response ${response.status}`,
        );
        this.logger.timeEnd(`request-${requestId}`);
        this.emit("request:end", { method, path, status: response.status });
        return response;
      }

      // Emit error event
      this.emit("error", { error: errorResult as Error, method, path });

      // Return error response
      const errorResponse = {
        status: 500,
        body: {
          error:
            errorResult instanceof Error
              ? errorResult.message
              : String(errorResult),
          code:
            errorResult instanceof SchmockError
              ? errorResult.code
              : "INTERNAL_ERROR",
        },
        headers: {},
      };

      this.logger.log("error", `[${requestId}] Returning error response 500`);
      this.logger.timeEnd(`request-${requestId}`);
      this.emit("request:end", { method, path, status: 500 });
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
   * Generate data via plugins when no response function is provided.
   */
  private async generateViaPlugins(
    route: CompiledRoute<TState>,
    context: Schmock.PluginContext,
  ): Promise<any> {
    const pluginsWithGenerate = this.sortedPlugins.filter((p) => p.generate);
    this.logger.log(
      "hooks",
      `Trying generate hooks for ${pluginsWithGenerate.length} plugins`,
    );

    // Try each plugin's generate method
    for (const plugin of this.sortedPlugins) {
      if (plugin.generate) {
        this.logger.log("hooks", `Executing generate: ${plugin.name}`);
        try {
          const result = await plugin.generate(context);
          if (result !== undefined && result !== null) {
            this.logger.log("hooks", `Plugin ${plugin.name} generated data`);
            return result;
          }
        } catch (error) {
          this.logger.log(
            "hooks",
            `Plugin ${plugin.name} generate failed: ${(error as Error).message}`,
          );
          // Wrap plugin errors
          const pluginError = new PluginError(plugin.name, error as Error);
          this.emit("error", { error: pluginError, context });
          throw pluginError;
        }
      }
    }

    this.logger.log("hooks", "No plugin generated data");
    return undefined;
  }

  /**
   * Emit an event to all registered handlers.
   */
  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        if (event !== "error") {
          this.emit("error", { error: error as Error });
        }
      }
    }
  }

  /**
   * Sort plugins by enforce property
   */
  private sortPlugins(plugins: Plugin[]): Plugin[] {
    const pre = plugins.filter((p) => p.enforce === "pre");
    const normal = plugins.filter((p) => !p.enforce);
    const post = plugins.filter((p) => p.enforce === "post");
    return [...pre, ...normal, ...post];
  }

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
   * Run beforeRequest hooks
   */
  private async runBeforeRequestHooks(
    context: Schmock.PluginContext,
  ): Promise<Schmock.PluginContext> {
    let currentContext = context;
    const pluginsWithHook = this.sortedPlugins.filter((p) => p.beforeRequest);

    this.logger.log(
      "hooks",
      `Running beforeRequest hooks for ${pluginsWithHook.length} plugins`,
    );

    for (const plugin of this.sortedPlugins) {
      if (plugin.beforeRequest) {
        this.logger.log("hooks", `Executing beforeRequest: ${plugin.name}`);
        try {
          const result = await plugin.beforeRequest(currentContext);
          if (result) {
            this.logger.log("hooks", `Plugin ${plugin.name} modified context`);
            currentContext = result;
          }
        } catch (error) {
          this.logger.log(
            "hooks",
            `Plugin ${plugin.name} beforeRequest failed: ${(error as Error).message}`,
          );
          throw new PluginError(plugin.name, error as Error);
        }
      }
    }

    return currentContext;
  }

  /**
   * Run beforeGenerate hooks
   */
  private async runBeforeGenerateHooks(
    context: Schmock.PluginContext,
  ): Promise<any> {
    const pluginsWithHook = this.sortedPlugins.filter((p) => p.beforeGenerate);
    this.logger.log(
      "hooks",
      `Running beforeGenerate hooks for ${pluginsWithHook.length} plugins`,
    );

    for (const plugin of this.sortedPlugins) {
      if (plugin.beforeGenerate) {
        this.logger.log("hooks", `Executing beforeGenerate: ${plugin.name}`);
        try {
          const result = await plugin.beforeGenerate(context);
          if (result !== undefined && result !== null) {
            this.logger.log(
              "hooks",
              `Plugin ${plugin.name} returned early response`,
            );
            return result;
          }
        } catch (error) {
          this.logger.log(
            "hooks",
            `Plugin ${plugin.name} beforeGenerate failed: ${(error as Error).message}`,
          );
          throw new PluginError(plugin.name, error as Error);
        }
      }
    }

    return undefined;
  }

  /**
   * Run afterGenerate hooks
   */
  private async runAfterGenerateHooks(
    data: any,
    context: Schmock.PluginContext,
  ): Promise<any> {
    let currentData = data;
    const pluginsWithHook = this.sortedPlugins.filter((p) => p.afterGenerate);
    this.logger.log(
      "hooks",
      `Running afterGenerate hooks for ${pluginsWithHook.length} plugins`,
    );

    for (const plugin of this.sortedPlugins) {
      if (plugin.afterGenerate) {
        this.logger.log("hooks", `Executing afterGenerate: ${plugin.name}`);
        try {
          currentData = await plugin.afterGenerate(currentData, context);
          this.logger.log("hooks", `Plugin ${plugin.name} transformed data`);
        } catch (error) {
          this.logger.log(
            "hooks",
            `Plugin ${plugin.name} afterGenerate failed: ${(error as Error).message}`,
          );
          throw new PluginError(plugin.name, error as Error);
        }
      }
    }

    return currentData;
  }

  /**
   * Run beforeResponse hooks
   */
  private async runBeforeResponseHooks(
    response: {
      status: number;
      body: unknown;
      headers: Record<string, string>;
    },
    context: Schmock.PluginContext,
  ): Promise<{
    status: number;
    body: unknown;
    headers: Record<string, string>;
  }> {
    let currentResponse = response;
    const pluginsWithHook = this.sortedPlugins.filter((p) => p.beforeResponse);
    this.logger.log(
      "hooks",
      `Running beforeResponse hooks for ${pluginsWithHook.length} plugins`,
    );

    for (const plugin of this.sortedPlugins) {
      if (plugin.beforeResponse) {
        this.logger.log("hooks", `Executing beforeResponse: ${plugin.name}`);
        try {
          const result = await plugin.beforeResponse(
            currentResponse as any,
            context,
          );
          if (result) {
            this.logger.log("hooks", `Plugin ${plugin.name} modified response`);
            currentResponse = result as any;
          }
        } catch (error) {
          this.logger.log(
            "hooks",
            `Plugin ${plugin.name} beforeResponse failed: ${(error as Error).message}`,
          );
          throw new PluginError(plugin.name, error as Error);
        }
      }
    }

    return currentResponse;
  }

  /**
   * Run onError hooks
   */
  private async runOnErrorHooks(
    error: Error,
    context: Schmock.PluginContext,
  ): Promise<Error | any> {
    let lastError = error;
    const pluginsWithHook = this.sortedPlugins.filter((p) => p.onError);
    this.logger.log(
      "hooks",
      `Running onError hooks for ${pluginsWithHook.length} plugins`,
    );

    for (const plugin of this.sortedPlugins) {
      if (plugin.onError) {
        this.logger.log("hooks", `Executing onError: ${plugin.name}`);
        try {
          const result = await plugin.onError(lastError, context);
          if (result) {
            this.logger.log("hooks", `Plugin ${plugin.name} handled error`);
            return result;
          }
        } catch (hookError) {
          this.logger.log(
            "hooks",
            `Plugin ${plugin.name} onError hook failed: ${(hookError as Error).message}`,
          );
          // If error hook itself fails, update the error but continue
          lastError = new PluginError(plugin.name, hookError as Error);
        }
      }
    }

    return lastError;
  }
}
