type Plugin = Schmock.Plugin;

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

  config(options: BuilderConfig): Builder<TState> {
    this.options.config = { ...this.options.config, ...options };
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

  use(plugin: Plugin): Builder<TState> {
    this.options.plugins.push(plugin);
    return this;
  }

  build(): MockInstance<TState> {
    const compiledRoutes = this.compileRoutes();
    const state = this.options.state;
    const plugins = this.options.plugins;

    return new SchmockInstance(compiledRoutes, state as TState, plugins);
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
        throw new Error(`Route definition is required for ${routeKey}`);
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

  constructor(
    private routes: CompiledRoute<TState>[],
    private state: TState,
    private plugins: Plugin[] = [],
  ) {}

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
    // Emit request:start event
    this.emit("request:start", { method, path });

    try {
      // Find matching route
      const route = this.findRoute(method, path);

      if (!route) {
        const response = {
          status: 404,
          body: { error: "Not Found" },
          headers: {},
        };
        this.emit("request:end", { method, path, status: 404 });
        return response;
      }

      // Extract params from path
      const params = this.extractParams(route, path);

      // Build context
      const context: ResponseContext<TState> = {
        state: this.state,
        params,
        query: options?.query || {},
        body: options?.body,
        headers: options?.headers || {},
        method,
        path,
      };

      // Execute response function or generate data via plugins
      let result: any;

      if (route.definition.response) {
        // Route has explicit response function
        // Enhance context with plugin helpers if route has schema
        const enhancedContext = await this.enhanceContextWithPlugins(
          context,
          route,
        );
        result = await route.definition.response(enhancedContext);
      } else {
        // No response function - try plugins
        result = await this.generateViaPlugins(route, context);

        if (result === undefined) {
          throw new Error(
            `No response function or plugin could handle route: ${method} ${path}`,
          );
        }
      }

      // Parse result
      let response: {
        status: number;
        body: unknown;
        headers: Record<string, string>;
      };

      if (Array.isArray(result)) {
        // Check if it's a tuple response [status, body, headers?]
        if (typeof result[0] === "number") {
          const [status, body, headers] = result;
          response = {
            status,
            body,
            headers: headers || {},
          };
        } else {
          response = {
            status: 200,
            body: result,
            headers: {},
          };
        }
      } else {
        response = {
          status: 200,
          body: result,
          headers: {},
        };
      }

      // Emit request:end event
      this.emit("request:end", { method, path, status: response.status });

      return response;
    } catch (error) {
      // Emit error event
      this.emit("error", { error: error as Error, method, path });

      // Return error response instead of throwing
      const errorResponse = {
        status: 500,
        body: { error: error instanceof Error ? error.message : String(error) },
        headers: {},
      };

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
    context: ResponseContext<TState>,
  ): Promise<any> {
    const pluginContext: Schmock.PluginContext = {
      path: context.path,
      route: route.definition as any,
      method: context.method,
      params: context.params,
      state: new Map(), // Plugin state - separate from route state
    };

    // Try each plugin's generate method
    for (const plugin of this.plugins) {
      if (plugin.generate) {
        try {
          const result = await plugin.generate(pluginContext);
          if (result !== undefined && result !== null) {
            return result;
          }
        } catch (error) {
          // Plugin failed, continue to next plugin or let caller handle error
          this.emit("error", { error: error as Error, context: pluginContext });
          // Don't return here, let the error propagate up to the handle method
          throw error;
        }
      }
    }

    return undefined;
  }

  /**
   * Enhance response context with plugin helpers.
   */
  private async enhanceContextWithPlugins(
    context: ResponseContext<TState>,
    route: CompiledRoute<TState>,
  ): Promise<ResponseContext<TState> & any> {
    const enhanced = { ...context };

    // Check if any plugin can provide schema helpers
    for (const plugin of this.plugins) {
      if (plugin.name === "schema" && (route.definition as any).schema) {
        // Add generateFromSchema helper for schema plugin
        (enhanced as any).generateFromSchema = (options?: any) => {
          const { generateFromSchema } = require("@schmock/schema");
          return generateFromSchema({
            schema: (route.definition as any).schema,
            count: options?.count || (route.definition as any).count,
            overrides:
              options?.overrides || (route.definition as any).overrides,
            params: context.params,
            state: context.state,
            query: context.query,
            ...options,
          });
        };
        break;
      }
    }

    return enhanced;
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
}
