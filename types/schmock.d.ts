/**
 * Schmock - Schema-driven mock API generator
 * @packageDocumentation
 */
declare namespace Schmock {
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
    version: string
    
    /**
     * Called once when plugin is registered
     * @param core - Schmock instance
     */
    setup?(core: Core): void | Promise<void>
    
    /**
     * Called before request processing
     * @param context - Request context
     */
    beforeRequest?(context: Context): void | Promise<void>
    
    /**
     * Generate or transform response data
     * @param context - Request context
     * @returns Generated data
     */
    generate?(context: Context): any | Promise<any>
    
    /**
     * Post-process generated data
     * @param context - Request context
     * @param data - Generated data
     * @returns Modified data
     */
    afterGenerate?(context: Context, data: any): any | Promise<any>
    
    /**
     * Called before sending response
     * @param context - Request context with response
     */
    beforeResponse?(context: Context & { response: Response }): void | Promise<void>
    
    /**
     * Extend route configuration
     * @param route - Original route config
     * @returns Extended route config
     */
    extendRoute?(route: Route): Route
    
    /**
     * Extend JSON schema
     * @param schema - Original schema
     * @returns Extended schema
     */
    extendSchema?(schema: import('json-schema').JSONSchema7): import('json-schema').JSONSchema7
  }

  /**
   * Request context passed through plugin lifecycle
   */
  interface Context {
    /** Current request */
    request: Request
    /** Matched route configuration */
    route: Route
    /** Shared state between plugins for this request */
    state: Record<string, any>
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
    'generate:start': Context
    /** Emitted after data generation */
    'generate:end': { context: Context; data: any }
    /** Emitted when plugin is registered */
    'plugin:registered': { plugin: Plugin }
    /** Emitted on errors */
    'error': { error: Error; context?: Context }
  }

  /**
   * Core Schmock instance API
   */
  interface Core {
    /**
     * Register a plugin
     * @param plugin - Plugin to register
     * @returns Self for chaining
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
}