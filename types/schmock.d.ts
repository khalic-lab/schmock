/**
 * Schmock - Schema-driven mock API generator
 * @packageDocumentation
 */
declare namespace Schmock {
  /**
   * HTTP methods supported by Schmock
   */
  type HttpMethod =
    | "GET"
    | "POST"
    | "PUT"
    | "DELETE"
    | "PATCH"
    | "HEAD"
    | "OPTIONS";

  /**
   * Route key format: 'METHOD /path'
   *
   * @example
   * 'GET /users'
   * 'POST /users/:id'
   * 'DELETE /api/posts/:postId/comments/:commentId'
   *
   * Design rationale:
   * - Combines method and path in a single, scannable string
   * - Matches OpenAPI/Swagger documentation format
   * - Enables copy-paste from API docs
   * - TypeScript validates format at compile time
   * - Used by modern frameworks like Hono
   */
  type RouteKey = `${HttpMethod} ${string}`;
  
  /**
   * Plugin interface for extending Schmock functionality
   */
  interface Plugin {
    /** Unique plugin identifier */
    name: string;
    /** Plugin version (semver) */
    version?: string;
    /** Control execution order */
    enforce?: "pre" | "post";


    /**
     * Called before request handling
     * Can modify the request context or reject the request
     * @param context - Plugin context with request details
     * @returns Modified context or void
     */
    beforeRequest?(context: PluginContext): PluginContext | void | Promise<PluginContext | void>;

    /**
     * Called before any data generation
     * Can return data to short-circuit the pipeline
     * @param context - Plugin context
     * @returns Data to return immediately, or void to continue
     */
    beforeGenerate?(context: PluginContext): any | void | Promise<any | void>;

    /**
     * Generate data when route has no configured data
     * @param context - Plugin context
     * @returns Generated data or void to pass to next plugin
     */
    generate?(context: PluginContext): any | void | Promise<any | void>;

    /**
     * Transform generated data
     * @param data - Data from generation or previous transform
     * @param context - Plugin context
     * @returns Transformed data
     */
    afterGenerate?(data: any, context: PluginContext): any | Promise<any>;

    /**
     * Transform data (from route config or previous plugin)
     * @param data - Current data
     * @param context - Plugin context
     * @returns Transformed data
     */
    transform?(data: any, context: PluginContext): any | Promise<any>;

    /**
     * Called before returning response
     * Last chance to modify the response data
     * @param response - Response object
     * @param context - Plugin context
     * @returns Modified response or void
     */
    beforeResponse?(response: ResponseResult, context: PluginContext): ResponseResult | void | Promise<ResponseResult | void>;

    /**
     * Called when an error occurs
     * Can handle, transform, or suppress errors
     * @param error - The error that occurred
     * @param context - Plugin context
     * @returns Modified error, response data, or void to continue error propagation
     */
    onError?(error: Error, context: PluginContext): Error | ResponseResult | void | Promise<Error | ResponseResult | void>;
  }

  /**
   * Context passed through plugin pipeline
   */
  interface PluginContext {
    /** Request path */
    path: string;
    /** Matched route configuration */
    route: any;
    /** HTTP method */
    method: HttpMethod;
    /** Route parameters */
    params: Record<string, string>;
    /** Query parameters */
    query: Record<string, string>;
    /** Request headers */
    headers: Record<string, string>;
    /** Request body */
    body?: any;
    /** Shared state between plugins for this request */
    state: Map<string, any>;
    /** Route-specific state */
    routeState?: any;
  }


  // ===== Fluent Builder API Types =====

  /**
   * Configuration options for builder
   */
  interface BuilderConfig {
    /** Base path prefix for all routes */
    namespace?: string;
    /** Response delay in ms, or [min, max] for random delay */
    delay?: number | [number, number];
    /** Enable debug mode for detailed logging */
    debug?: boolean;
  }

  /**
   * Context passed to response functions
   */
  interface ResponseContext<TState = any> {
    /** Shared mutable state */
    state: TState;
    /** Path parameters (e.g., :id) */
    params: Record<string, string>;
    /** Query string parameters */
    query: Record<string, string>;
    /** Request body (for POST, PUT, PATCH) */
    body?: any;
    /** Request headers */
    headers: Record<string, string>;
    /** HTTP method */
    method: HttpMethod;
    /** Request path */
    path: string;
  }

  /**
   * Response function return types:
   * - Any value: returns as 200 OK
   * - [status, body]: custom status with body
   * - [status, body, headers]: custom status, body, and headers
   */
  type ResponseResult =
    | any
    | [number, any]
    | [number, any, Record<string, string>];

  /**
   * Response function that handles requests
   */
  type ResponseFunction<TState = any> = (
    context: ResponseContext<TState>,
  ) => ResponseResult | Promise<ResponseResult>;

  /**
   * Route definition for fluent API
   */
  interface RouteDefinition<TState = any> {
    /**
     * Function that generates the response
     */
    response: ResponseFunction<TState>;

    /**
     * Plugin extensions (validation, middleware, etc.)
     */
    [key: string]: any;
  }

  /**
   * Routes configuration using 'METHOD /path' keys
   */
  type Routes<TState = any> = {
    [K in RouteKey]?: RouteDefinition<TState>;
  };

  /**
   * Fluent builder interface
   */
  interface Builder<TState = any> {
    /**
     * Configure mock options
     *
     * @example
     * schmock().config({ namespace: '/api/v1', delay: [100, 500] })
     */
    config(options: BuilderConfig): Builder<TState>;

    /**
     * Define routes using 'METHOD /path' keys
     *
     * @example
     * ```typescript
     * schmock()
     *   .routes({
     *     'GET /users': {
     *       response: ({ state }) => state.users
     *     },
     *     'POST /users': {
     *       response: ({ body, state }) => {
     *         const user = { id: Date.now(), ...body }
     *         state.users.push(user)
     *         return [201, user]
     *       }
     *     }
     *   })
     * ```
     */
    routes(routes: Routes<TState>): Builder<TState>;

    /**
     * Set initial shared state
     *
     * @example
     * schmock().state({ users: [], posts: [] })
     */
    state<T>(initial: T): Builder<T>;

    /**
     * Register a plugin
     */
    use(plugin: Plugin | (() => Plugin)): Builder<TState>;

    /**
     * Build the mock instance
     */
    build(): MockInstance<TState>;
  }

  /**
   * Built mock instance
   */
  interface MockInstance<TState = any> {
    /**
     * Handle a request (for testing or adapters)
     *
     * @example
     * const response = await mock.handle('GET', '/users')
     */
    handle(
      method: HttpMethod,
      path: string,
      options?: {
        headers?: Record<string, string>;
        body?: any;
        query?: Record<string, string>;
      },
    ): Promise<{
      status: number;
      body: any;
      headers: Record<string, string>;
    }>;

    /**
     * Subscribe to an event
     */
    on(event: string, handler: (data: any) => void): void;

    /**
     * Unsubscribe from an event
     */
    off(event: string, handler: (data: any) => void): void;
  }
}
