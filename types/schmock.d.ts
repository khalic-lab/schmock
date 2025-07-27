/**
 * Schmock - Schema-driven mock API generator
 * @packageDocumentation
 */
declare namespace Schmock {
  /**
   * HTTP methods supported by Schmock
   */
  type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'
  
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
  type RouteKey = `${HttpMethod} ${string}`
  /**
   * Main configuration object for Schmock instance
   */
  interface Config {
    /** Route definitions mapped by path pattern */
    routes: Record<string, Route | any>
  }

  /**
   * Route configuration for a single endpoint
   */
  interface Route {
    /** Static data to return */
    data?: any
    /** JSON Schema for validation and generation */
    schema?: string | import('json-schema').JSONSchema7
    /** Custom handler function */
    handler?: RequestHandler
  }

  /**
   * Function that handles requests and returns response data
   */
  type RequestHandler = (request: Request) => any | Promise<any>

  /**
   * Incoming HTTP request representation
   */
  interface Request {
    /** Request path (e.g., "/api/users/123") */
    path: string
    /** HTTP method */
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'
    /** Request headers */
    headers: Record<string, string>
    /** Request body (for POST, PUT, PATCH) */
    body?: any
    /** Query parameters */
    query: Record<string, string>
    /** Path parameters extracted from route pattern */
    params: Record<string, string>
  }

  /**
   * HTTP response to be sent back
   */
  interface Response {
    /** HTTP status code */
    status: number
    /** Response body */
    body: any
    /** Response headers */
    headers: Record<string, string>
  }

  /**
   * Plugin interface for extending Schmock functionality
   */
  interface Plugin {
    /** Unique plugin identifier */
    name: string
    /** Plugin version (semver) */
    version?: string
    /** Control execution order */
    enforce?: 'pre' | 'post'
    
    /**
     * Called once when plugin is registered
     * @param core - Schmock instance
     */
    setup?(core: Core): void | Promise<void>
    
    /**
     * Called before any data generation
     * Can return data to short-circuit the pipeline
     * @param context - Plugin context
     * @returns Data to return immediately, or void to continue
     */
    beforeGenerate?(context: PluginContext): any | void | Promise<any | void>
    
    /**
     * Generate data when route has no configured data
     * @param context - Plugin context
     * @returns Generated data or void to pass to next plugin
     */
    generate?(context: PluginContext): any | void | Promise<any | void>
    
    /**
     * Transform data (from route config or previous plugin)
     * @param data - Current data
     * @param context - Plugin context
     * @returns Transformed data
     */
    transform?(data: any, context: PluginContext): any | Promise<any>
    
    /**
     * Called before returning response (cannot modify data)
     * @param data - Final data
     * @param context - Plugin context
     */
    beforeResponse?(data: any, context: PluginContext): void | Promise<void>
  }
  
  /**
   * Context passed through plugin pipeline
   */
  interface PluginContext {
    /** Request path */
    path: string
    /** Matched route configuration */
    route: Route
    /** HTTP method (optional) */
    method?: string
    /** Route parameters */
    params?: Record<string, string>
    /** Shared state between plugins for this request */
    state: Map<string, any>
  }

  /**
   * Context for processing requests (used by standalone/HTTP implementations)
   */
  interface ProcessContext {
    /** HTTP method */
    method?: string
    /** Request headers */
    headers?: Record<string, string>
    /** Request body */
    body?: any
    /** Query parameters */
    query?: Record<string, string>
    /** Path parameters */
    params?: Record<string, string>
  }

  /**
   * Events emitted during request lifecycle
   */
  interface EventMap {
    /** Emitted when request processing starts */
    'request:start': { request: Request; route: Route }
    /** Emitted when request processing ends */
    'request:end': { request: Request; response: Response }
    /** Emitted before data generation */
    'generate:start': PluginContext
    /** Emitted after data generation */
    'generate:end': { context: PluginContext; data: any }
    /** Emitted when plugin is registered */
    'plugin:registered': { plugin: Plugin }
    /** Emitted on errors */
    'error': { error: Error; context?: PluginContext }
  }

  /**
   * Core Schmock orchestrator (no HTTP methods)
   */
  interface CoreInstance {
    /**
     * Register a plugin
     * @param plugin - Plugin to register
     * @returns Self for chaining
     */
    use(plugin: Plugin): CoreInstance
    
    /**
     * Process a request through the plugin pipeline
     * @param path - Request path
     * @param context - Processing context
     * @returns Generated/transformed data
     */
    process(path: string, context?: ProcessContext): Promise<any>
    
    /**
     * Subscribe to an event
     * @param event - Event name
     * @param handler - Event handler
     */
    on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void
    
    /**
     * Unsubscribe from an event
     * @param event - Event name
     * @param handler - Event handler to remove
     */
    off<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void
    
    /**
     * Emit an event
     * @param event - Event name
     * @param data - Event data
     */
    emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void
  }

  /**
   * Schmock instance with HTTP methods (for backward compatibility)
   */
  interface Core extends CoreInstance {
    /**
     * Register a plugin (overrides return type for chaining)
     */
    use(plugin: Plugin): Core
    
    /**
     * Make a request with any HTTP method
     * @param method - HTTP method
     * @param path - Request path
     * @param options - Additional request options
     */
    request(method: Request['method'], path: string, options?: Partial<Omit<Request, 'method' | 'path'>>): Promise<Response>
    
    /**
     * Make a GET request
     * @param path - Request path
     * @param options - Additional request options
     */
    get(path: string, options?: Partial<Omit<Request, 'method' | 'path'>>): Promise<Response>
    
    /**
     * Make a POST request
     * @param path - Request path
     * @param body - Request body
     * @param options - Additional request options
     */
    post(path: string, body?: any, options?: Partial<Omit<Request, 'method' | 'path' | 'body'>>): Promise<Response>
    
    /**
     * Make a PUT request
     * @param path - Request path
     * @param body - Request body
     * @param options - Additional request options
     */
    put(path: string, body?: any, options?: Partial<Omit<Request, 'method' | 'path' | 'body'>>): Promise<Response>
    
    /**
     * Make a DELETE request
     * @param path - Request path
     * @param options - Additional request options
     */
    delete(path: string, options?: Partial<Omit<Request, 'method' | 'path'>>): Promise<Response>
    
    /**
     * Make a PATCH request
     * @param path - Request path
     * @param body - Request body
     * @param options - Additional request options
     */
    patch(path: string, body?: any, options?: Partial<Omit<Request, 'method' | 'path' | 'body'>>): Promise<Response>
    
    /**
     * Subscribe to an event
     * @param event - Event name
     * @param handler - Event handler
     */
    on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void
    
    /**
     * Unsubscribe from an event
     * @param event - Event name
     * @param handler - Event handler to remove
     */
    off<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void
    
    /**
     * Emit an event
     * @param event - Event name
     * @param data - Event data
     */
    emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void
  }
  
  // ===== Fluent Builder API Types =====
  
  /**
   * Configuration options for builder
   */
  interface BuilderConfig {
    /** Base path prefix for all routes */
    namespace?: string
    /** Response delay in ms, or [min, max] for random delay */
    delay?: number | [number, number]
  }
  
  /**
   * Context passed to response functions
   */
  interface ResponseContext<TState = any> {
    /** Shared mutable state */
    state: TState
    /** Path parameters (e.g., :id) */
    params: Record<string, string>
    /** Query string parameters */
    query: Record<string, string>
    /** Request body (for POST, PUT, PATCH) */
    body?: any
    /** Request headers */
    headers: Record<string, string>
    /** HTTP method */
    method: HttpMethod
    /** Request path */
    path: string
  }
  
  /**
   * Response function return types:
   * - Any value: returns as 200 OK
   * - [status, body]: custom status with body
   * - [status, body, headers]: custom status, body, and headers
   */
  type ResponseResult = any | [number, any] | [number, any, Record<string, string>]
  
  /**
   * Response function that handles requests
   */
  type ResponseFunction<TState = any> = (
    context: ResponseContext<TState>
  ) => ResponseResult | Promise<ResponseResult>
  
  /**
   * Route definition for fluent API
   */
  interface RouteDefinition<TState = any> {
    /**
     * Function that generates the response
     */
    response: ResponseFunction<TState>
    
    /**
     * Plugin extensions (validation, middleware, etc.)
     */
    [key: string]: any
  }
  
  /**
   * Routes configuration using 'METHOD /path' keys
   */
  type Routes<TState = any> = {
    [K in RouteKey]?: RouteDefinition<TState>
  }
  
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
    config(options: BuilderConfig): Builder<TState>
    
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
    routes(routes: Routes<TState>): Builder<TState>
    
    /**
     * Set initial shared state
     * 
     * @example
     * schmock().state({ users: [], posts: [] })
     */
    state<T>(initial: T): Builder<T>
    
    /**
     * Register a plugin
     */
    use(plugin: Plugin): Builder<TState>
    
    /**
     * Build the mock instance
     */
    build(): MockInstance<TState>
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
    handle(method: HttpMethod, path: string, options?: {
      headers?: Record<string, string>
      body?: any
      query?: Record<string, string>
    }): Promise<{
      status: number
      body: any
      headers: Record<string, string>
    }>
  }
}