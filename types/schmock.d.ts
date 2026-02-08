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
     * Called once when the plugin is added via .pipe()
     * Use this to register routes or configure the instance at setup time
     * @param instance - The callable mock instance
     */
    install?(instance: CallableMockInstance): void;

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
    [key: string]: unknown;
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
    body?: unknown;
    query?: Record<string, string>;
  }

  /**
   * Record of a single request handled by the mock
   */
  interface RequestRecord {
    /** HTTP method */
    method: HttpMethod;
    /** Request path (without namespace) */
    path: string;
    /** Extracted route parameters */
    params: Record<string, string>;
    /** Query parameters */
    query: Record<string, string>;
    /** Request headers */
    headers: Record<string, string>;
    /** Request body */
    body: unknown;
    /** Unix timestamp (ms) when request was handled */
    timestamp: number;
    /** Response returned for this request */
    response: { status: number; body: unknown };
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

    // ===== Request Spy / History API =====

    /**
     * Get all recorded requests, optionally filtered by method and path
     *
     * @param method - Filter by HTTP method
     * @param path - Filter by request path
     * @returns Array of request records
     */
    history(): RequestRecord[];
    history(method: HttpMethod, path: string): RequestRecord[];

    /**
     * Check if any request was made, optionally for a specific route
     *
     * @param method - Filter by HTTP method
     * @param path - Filter by request path
     * @returns true if at least one matching request was recorded
     */
    called(): boolean;
    called(method: HttpMethod, path: string): boolean;

    /**
     * Get the number of recorded requests, optionally for a specific route
     *
     * @param method - Filter by HTTP method
     * @param path - Filter by request path
     * @returns Number of matching requests
     */
    callCount(): number;
    callCount(method: HttpMethod, path: string): number;

    /**
     * Get the most recent request, optionally for a specific route
     *
     * @param method - Filter by HTTP method
     * @param path - Filter by request path
     * @returns Most recent matching request record, or undefined
     */
    lastRequest(): RequestRecord | undefined;
    lastRequest(method: HttpMethod, path: string): RequestRecord | undefined;

    // ===== Reset / Lifecycle =====

    /**
     * Clear all routes, state, plugins, and history
     */
    reset(): void;

    /**
     * Clear only request history, keep routes and state
     */
    resetHistory(): void;

    /**
     * Clear only state, keep routes and history
     */
    resetState(): void;

    // ===== Standalone Server =====

    /**
     * Start a standalone HTTP server
     *
     * @param port - Port to listen on (0 for random)
     * @param hostname - Hostname to bind to (default: "127.0.0.1")
     * @returns Promise resolving to server info with actual port and hostname
     * @throws If the server is already running
     */
    listen(port?: number, hostname?: string): Promise<ServerInfo>;

    /**
     * Stop the standalone server (idempotent, no-op if not running)
     */
    close(): void;
  }

  /**
   * Information about a running standalone server
   */
  interface ServerInfo {
    /** Port the server is listening on */
    port: number;
    /** Hostname the server is bound to */
    hostname: string;
  }

}
