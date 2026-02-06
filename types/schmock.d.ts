/**
 * Schmock - Schema-driven mock API generator with callable API
 * @packageDocumentation
 */

declare namespace Schmock {
  type JSONSchema7 = import("json-schema").JSONSchema7;
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

    /**
     * Process the request through this plugin
     * First plugin to set response becomes the generator, others transform
     * @param context - Plugin context with request details
     * @param response - Response from previous plugin (if any)
     * @returns Updated context and response
     */
    process(context: PluginContext, response?: any): PluginResult | Promise<PluginResult>;

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
   * Alias for response body type
   */
  type ResponseBody = unknown;

  /**
   * Result returned by plugin process method
   */
  interface PluginResult {
    /** Updated context */
    context: PluginContext;
    /** Response data (if generated/modified) */
    response?: unknown;
  }

  /**
   * Context passed through plugin pipeline
   */
  interface PluginContext {
    /** Request path */
    path: string;
    /** Matched route configuration */
    route: RouteConfig;
    /** HTTP method */
    method: HttpMethod;
    /** Route parameters */
    params: Record<string, string>;
    /** Query parameters */
    query: Record<string, string>;
    /** Request headers */
    headers: Record<string, string>;
    /** Request body */
    body?: unknown;
    /** Shared state between plugins for this request */
    state: Map<string, unknown>;
    /** Route-specific state */
    routeState?: Record<string, unknown>;
  }

  // ===== Callable API Types =====

  /**
   * Global configuration options for the mock instance
   */
  interface GlobalConfig {
    /** Base path prefix for all routes */
    namespace?: string;
    /** Response delay in ms, or [min, max] for random delay */
    delay?: number | [number, number];
    /** Enable debug mode for detailed logging */
    debug?: boolean;
    /** Initial shared state object */
    state?: Record<string, unknown>;
  }

  /**
   * Route-specific configuration options
   */
  interface RouteConfig {
    /** MIME type for content type validation (auto-detected if not provided) */
    contentType?: string;
    /** Additional route-specific options */
    [key: string]: any;
  }

  /**
   * Generator types that can be passed to route definitions
   */
  type Generator = 
    | GeneratorFunction
    | StaticData
    | JSONSchema7;

  /**
   * Function that generates responses
   */
  type GeneratorFunction = (context: RequestContext) => ResponseResult | Promise<ResponseResult>;

  /**
   * Static data (non-function) that gets returned as-is
   */
  type StaticData = string | number | boolean | null | undefined | Record<string, unknown> | unknown[];

  /**
   * Context passed to generator functions
   */
  interface RequestContext {
    /** HTTP method */
    method: HttpMethod;
    /** Request path */
    path: string;
    /** Route parameters (e.g., :id) */
    params: Record<string, string>;
    /** Query string parameters */
    query: Record<string, string>;
    /** Request headers */
    headers: Record<string, string>;
    /** Request body (for POST, PUT, PATCH) */
    body?: unknown;
    /** Shared mutable state */
    state: Record<string, unknown>;
  }

  /**
   * Response result types:
   * - Any value: returns as 200 OK
   * - [status, body]: custom status with body
   * - [status, body, headers]: custom status, body, and headers
   */
  type ResponseResult =
    | ResponseBody
    | [number, unknown]
    | [number, unknown, Record<string, string>];

  /**
   * Response object returned by handle method
   */
  interface Response {
    status: number;
    body: unknown;
    headers: Record<string, string>;
  }

  /**
   * Options for handle method
   */
  interface RequestOptions {
    headers?: Record<string, string>;
    body?: any;
    query?: Record<string, string>;
  }

  /**
   * Main callable mock instance interface
   */
  interface CallableMockInstance {
    /**
     * Define a route by calling the instance directly
     * 
     * @param route - Route pattern in format 'METHOD /path'
     * @param generator - Response generator (function, static data, or schema)
     * @param config - Route-specific configuration
     * @returns The same instance for method chaining
     * 
     * @example
     * ```typescript
     * const mock = schmock()
     * mock('GET /users', () => [...users], { contentType: 'application/json' })
     * mock('POST /users', userData, { contentType: 'application/json' })
     * ```
     */
    (route: RouteKey, generator: Generator, config?: RouteConfig): CallableMockInstance;

    /**
     * Add a plugin to the pipeline
     * 
     * @param plugin - Plugin to add to the pipeline
     * @returns The same instance for method chaining
     * 
     * @example
     * ```typescript
     * mock('GET /users', generator, config)
     *   .pipe(authPlugin())
     *   .pipe(corsPlugin())
     * ```
     */
    pipe(plugin: Plugin): CallableMockInstance;

    /**
     * Handle a request and return a response
     * 
     * @param method - HTTP method
     * @param path - Request path
     * @param options - Request options (headers, body, query)
     * @returns Promise resolving to response object
     * 
     * @example
     * ```typescript
     * const response = await mock.handle('GET', '/users', {
     *   headers: { 'Authorization': 'Bearer token' }
     * })
     * ```
     */
    handle(method: HttpMethod, path: string, options?: RequestOptions): Promise<Response>;
  }

}
