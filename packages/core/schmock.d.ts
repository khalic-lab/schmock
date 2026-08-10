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
     * Route registrations are committed atomically only when this hook returns
     * synchronously. The scoped instance must not be retained or used later.
     * Returning a Promise is unsupported and leaves the plugin inactive.
     * @param instance - A synchronous, installation-scoped callable instance
     */
    install?(instance: CallableMockInstance): void;

    /**
     * Called during reset after every request admitted with this plugin settles.
     * Cleanup runs in reverse registration order and must complete synchronously.
     */
    uninstall?(instance: CallableMockInstance): void;

    /**
     * Inspect or transform a request before its route generator executes.
     * Returning a response short-circuits the generator, while returning only
     * a context allows request changes to flow into the generator.
     */
    beforeRequest?(
      context: PluginContext,
    ): PluginResult | void | Promise<PluginResult | void>;

    /**
     * Process the request through this plugin
     * First plugin to set response becomes the generator, others transform
     * @param context - Plugin context with request details
     * @param response - Response from previous plugin (if any)
     * @returns Updated context and response
     */
    process(
      context: PluginContext,
      response?: unknown,
    ): PluginResult | Promise<PluginResult>;

    /**
     * Called when this plugin or an earlier pipeline stage fails. If this hook
     * does not recover, downstream handlers are tried in registration order.
     * @param error - The error that occurred
     * @param context - Plugin context
     * @returns Modified error, response data, or void to continue error propagation
     */
    onError?(
      error: Error,
      context: PluginContext,
    ): Error | ResponseResult | void | Promise<Error | ResponseResult | void>;
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
    /** True when a beforeRequest hook supplied the response instead of the route generator. */
    requestShortCircuited?: boolean;
    /** Route-specific state */
    routeState?: Record<string, unknown>;
    /** Abort signal associated with the admitted request */
    readonly signal?: AbortSignal;
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
    /**
     * Maximum number of requests retained in history (FIFO eviction).
     * Defaults to unbounded; set this to cap memory growth in long-running servers.
     */
    maxHistorySize?: number;
  }

  /**
   * Route-specific configuration options
   */
  interface RouteConfig {
    /** MIME type for content type validation (auto-detected if not provided) */
    contentType?: string;
    /** Per-route response delay in ms, or [min, max] for random delay (overrides global) */
    delay?: number | [number, number];
    /**
     * Extension point for plugin-specific metadata.
     *
     * Intentionally open: `@schmock/openapi` stores "openapi:*" keys here
     * (e.g. `"openapi:operationId"`, `"openapi:tags"`, `"openapi:owner"`,
     * `"openapi:requestContent"`), and
     * third-party plugins may do the same. Removing this signature would be a
     * breaking change.
     *
     * **Known tradeoff:** typos in known keys (e.g. `{ contenType: "…" }`) compile
     * silently. Prefer using the explicitly typed properties above when possible.
     */
    [key: string]: unknown;
  }

  /**
   * Generator types that can be passed to route definitions
   */
  type Generator = GeneratorFunction | StaticData | JSONSchema7;

  /**
   * Function that generates responses
   */
  type GeneratorFunction = (
    context: RequestContext,
  ) => ResponseResult | Promise<ResponseResult>;

  /**
   * Static data (non-function) that gets returned as-is
   */
  type StaticData =
    | string
    | number
    | boolean
    | null
    | undefined
    | Record<string, unknown>
    | unknown[]
    | ArrayBuffer
    | ArrayBufferView;

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
    /**
     * Per-request plugin state — the same `Map` as `PluginContext.state`.
     *
     * Lets a generator hand request-scoped data to the plugins that post-process
     * its response (e.g. mutations staged until the final status is known).
     * Absent when a generator is invoked outside the request pipeline.
     */
    pluginState?: Map<string, unknown>;
    /** Abort signal associated with the request */
    readonly signal?: AbortSignal;
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
    signal?: AbortSignal;
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
    (
      route: RouteKey,
      generator: Generator,
      config?: RouteConfig,
    ): CallableMockInstance;

    /**
     * Add a plugin to the pipeline
     *
     * @param plugin - Plugin to add to the pipeline
     * @returns The same instance for method chaining
     *
     * @example
     * ```typescript
     * mock.pipe(authPlugin()).pipe(corsPlugin())
     * mock('GET /users', generator, config)
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
    handle(
      method: HttpMethod,
      path: string,
      options?: RequestOptions,
    ): Promise<Response>;

    // ===== Request Spy / History API =====

    /**
     * Get all recorded requests, optionally filtered by method and path
     *
     * @param method - Filter by HTTP method
     * @param path - Filter by request path
     * @returns Array of request records
     */
    history(method?: HttpMethod, path?: string): RequestRecord[];

    /**
     * Check if any request was made, optionally for a specific route
     *
     * @param method - Filter by HTTP method
     * @param path - Filter by request path
     * @returns true if at least one matching request was recorded
     */
    called(method?: HttpMethod, path?: string): boolean;

    /**
     * Get the number of recorded requests, optionally for a specific route
     *
     * @param method - Filter by HTTP method
     * @param path - Filter by request path
     * @returns Number of matching requests
     */
    callCount(method?: HttpMethod, path?: string): number;

    /**
     * Get the most recent request, optionally for a specific route
     *
     * @param method - Filter by HTTP method
     * @param path - Filter by request path
     * @returns Most recent matching request record, or undefined
     */
    lastRequest(method?: HttpMethod, path?: string): RequestRecord | undefined;

    // ===== Reset / Lifecycle =====

    /**
     * Clear routes, state, plugins, listeners, and history, and stop the Node
     * server. An explicitly acquired fetch interception remains active until
     * its InterceptHandle is restored.
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

    // ===== Lifecycle Events =====

    /**
     * Register an event listener
     */
    on<E extends SchmockEvent>(
      event: E,
      listener: (data: SchmockEventMap[E]) => void,
    ): CallableMockInstance;

    /**
     * Remove an event listener
     */
    off<E extends SchmockEvent>(
      event: E,
      listener: (data: SchmockEventMap[E]) => void,
    ): CallableMockInstance;

    // ===== Introspection =====

    /**
     * Get all registered routes as an array of route info objects
     */
    getRoutes(): RouteInfo[];

    /**
     * Get the current shared state object
     */
    getState(): Record<string, unknown>;

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

    // ===== Fetch Interceptor =====

    /**
     * Intercept globalThis.fetch and route requests through this mock.
     * Client-side equivalent of listen().
     *
     * @param options - Intercept configuration
     * @returns Handle with restore() to stop intercepting
     * @throws If already intercepting (call restore() first)
     */
    intercept(options?: InterceptOptions): InterceptHandle;
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

  // ===== Response Helpers =====

  interface PaginateOptions {
    page?: number;
    pageSize?: number;
  }

  /**
   * Shape returned by the core `paginate()` helper (packages/core/src/helpers.ts).
   *
   * **Note:** the `@schmock/query` plugin produces a DIFFERENT nested shape:
   * ```ts
   * { data: T[]; pagination: { page: number; limit: number; total: number; totalPages: number } }
   * ```
   * Do not assume this type describes query-plugin responses.
   */
  interface PaginatedResponse<T> {
    data: T[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }

  // ===== Adapter Types =====

  interface AdapterRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
    query: Record<string, string>;
    readonly signal?: AbortSignal;
  }

  interface AdapterResponse {
    status: number;
    body: unknown;
    headers: Record<string, string>;
  }

  interface InterceptOptions {
    /**
     * Only intercept URLs matching this base.
     *
     * Two modes:
     * - Path form ("/api"): match request pathnames whose prefix is the
     *   base path (with a segment-boundary check, so "/api" never
     *   matches "/apiv2").
     * - Origin form ("https://api.example.com" or
     *   "https://api.example.com/v1"): require the request origin to
     *   match the base origin AND, if a base path is present, the
     *   request pathname to start with it. Relative-URL fetches
     *   (no origin) won't match an origin-form base.
     */
    baseUrl?: string;
    /** Pass unmatched routes to real fetch (default: true) */
    passthrough?: boolean;
    /** Modify request before Schmock handles it */
    beforeRequest?: (
      request: AdapterRequest,
    ) => AdapterRequest | void | Promise<AdapterRequest | void>;
    /** Modify response before returning to caller */
    beforeResponse?: (
      response: AdapterResponse,
      request: AdapterRequest,
    ) => AdapterResponse | void | Promise<AdapterResponse | void>;
    /** Format errors into custom response bodies */
    errorFormatter?: (error: Error) => unknown;
  }

  interface InterceptHandle {
    /** Stop intercepting and restore original fetch */
    restore(): void;
    /** Whether this interceptor is currently active */
    readonly active: boolean;
  }

  // ===== Lifecycle Events =====

  interface RequestStartEvent {
    readonly method: HttpMethod;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
  }

  interface RequestMatchEvent {
    readonly method: HttpMethod;
    readonly path: string;
    readonly routePath: string;
    readonly params: Readonly<Record<string, string>>;
  }

  interface RequestNotFoundEvent {
    readonly method: HttpMethod;
    readonly path: string;
  }

  interface RequestEndEvent {
    readonly method: HttpMethod;
    readonly path: string;
    readonly status: number;
    readonly duration: number;
  }

  type SchmockEventMap = {
    "request:start": RequestStartEvent;
    "request:match": RequestMatchEvent;
    "request:notfound": RequestNotFoundEvent;
    "request:end": RequestEndEvent;
  };

  type SchmockEvent = keyof SchmockEventMap;

  // ===== Introspection Types =====

  interface RouteInfo {
    method: HttpMethod;
    path: string;
    hasParams: boolean;
  }

  // ===== OpenAPI Plugin Types =====

  /**
   * Per-resource configuration override for OpenAPI plugin
   */
  interface ResourceOverride {
    /** Override: which property in list response holds the items array (e.g. "data") */
    listWrapProperty?: string;
    /** Override: force flat array for list (ignores any wrapper in the spec) */
    listFlat?: boolean;
    /** Override: JSON Schema for error responses (404, etc.) */
    errorSchema?: JSONSchema7;
  }

  /**
   * Response header definition from an OpenAPI spec
   */
  interface ResponseHeaderDef {
    schema?: JSONSchema7;
    description: string;
  }

  /**
   * Per-operation metadata auto-detected from spec or set via overrides
   */
  interface CrudOperationMeta {
    /** Full success response schema (wrapper + items) */
    responseSchema?: JSONSchema7;
    /** Concrete success status selected from the operation contract. */
    responseStatus?: number;
    /** Response headers from spec */
    responseHeaders?: Record<string, ResponseHeaderDef>;
    /** Error response schemas keyed by status code */
    errorSchemas?: Map<number, JSONSchema7>;
    /** Declared media types for the success response, in spec order. */
    responseContentTypes?: string[];
    /**
     * Success response schemas keyed by declared media type (OAS3 `content`).
     * When present it takes precedence over `responseSchema`, so anything that
     * replaces `responseSchema` must clear this map too.
     */
    responseSchemasByMediaType?: Map<string, JSONSchema7>;
  }

  // ===== Faker Plugin Types =====

  /**
   * Context for schema-based data generation
   */
  interface SchemaGenerationContext {
    schema: JSONSchema7;
    count?: number;
    overrides?: Record<string, unknown>;
    params?: Record<string, string>;
    state?: Record<string, unknown>;
    query?: Record<string, string>;
    seed?: number;
  }

  /**
   * Options for the faker plugin
   */
  interface FakerPluginOptions {
    schema: JSONSchema7;
    count?: number;
    overrides?: Record<string, unknown>;
    seed?: number;
  }

  // ===== Express Adapter Types =====

  /**
   * Override parts of a request before Schmock handles it
   */
  type AdapterRequestOverride = Partial<AdapterRequest>;

  /**
   * Configuration options for Express adapter
   */
  interface ExpressAdapterOptions {
    errorFormatter?: (error: Error, req: unknown) => unknown;
    passErrorsToNext?: boolean;
    transformHeaders?: (
      headers: Record<string, string | string[] | undefined>,
    ) => Record<string, string>;
    transformQuery?: (query: Record<string, unknown>) => Record<string, string>;
    beforeRequest?: (
      req: unknown,
      res: unknown,
    ) =>
      | AdapterRequestOverride
      | undefined
      | Promise<AdapterRequestOverride | undefined>;
    beforeResponse?: (
      response: Response,
      req: unknown,
      res: unknown,
    ) => Response | undefined | Promise<Response | undefined>;
  }

  // ===== Angular Adapter Types =====

  /**
   * Configuration options for Angular adapter
   */
  interface AngularAdapterOptions {
    baseUrl?: string;
    passthrough?: boolean;
    errorFormatter?: (error: Error, request: unknown) => unknown;
    transformRequest?: (request: unknown) => AdapterRequestOverride;
    transformResponse?: (response: Response, request: unknown) => Response;
  }

  // ===== OpenAPI Plugin Options =====

  /** A callback request resolved from an OpenAPI callback expression. */
  interface OpenApiCallbackRequest {
    url: string;
    method: HttpMethod;
    headers: Record<string, string>;
    body?: unknown;
  }

  /** Explicit application-owned delivery for OpenAPI callbacks. */
  interface OpenApiCallbackOptions {
    dispatch(request: OpenApiCallbackRequest): void | Promise<void>;
  }

  /**
   * Policy governing `$ref`s that leave the root spec document.
   *
   * A spec is untrusted input — on the CLI it is a path a caller hands over —
   * and `$ref` is a file-read and network primitive, so nothing outside the
   * root document resolves unless it is opted into here.
   */
  interface OpenApiRefPolicy {
    /** Allow any `$ref` that leaves the root document. Default `false`. */
    external?: boolean;
    /** Allow `http(s)` `$ref`s. Requires `external`. Default `false`. */
    allowHttp?: boolean;
    /**
     * Hostnames an `http(s)` `$ref` may target. Empty or omitted means any
     * host, still minus loopback, link-local and private ranges.
     */
    allowedHosts?: string[];
    /** Per-request timeout for http `$ref`s, in ms. Default 5000. */
    timeoutMs?: number;
    /**
     * Redirects to follow for an http `$ref`. Default 0.
     *
     * `fetch` exposes no numeric redirect cap, so this behaves as a boolean:
     * `0` refuses redirects, any positive value follows up to the platform
     * default. Use `allowedHosts` when the exact destination matters.
     */
    redirects?: number;
    /** Maximum size of a single http `$ref` document, in bytes. Default 1 MB. */
    maxBytes?: number;
  }

  /**
   * Options for the OpenAPI plugin
   */
  interface OpenApiOptions {
    spec: string | object;
    seed?: SeedConfig;
    /**
     * Validate the spec against the OpenAPI schema and specification when it is
     * loaded. Default `false`: incomplete specs are deliberately tolerated, and
     * validation is expensive on large documents.
     */
    strict?: boolean;
    /** External `$ref` resolution policy. External refs are off by default. */
    refs?: OpenApiRefPolicy;
    validateRequests?: boolean;
    validateResponses?: boolean;
    /** @deprecated Unsupported. Supplying this option throws OPENAPI_UNSUPPORTED_OPTION. */
    queryFeatures?: {
      pagination?: boolean;
      sorting?: boolean;
      filtering?: boolean;
    };
    resources?: Record<string, ResourceOverride>;
    debug?: boolean;
    fakerSeed?: number;
    security?: boolean;
    /**
     * Enable callback delivery through an application-supplied dispatcher.
     * Callbacks are disabled when this option is omitted; Schmock never
     * performs callback network requests implicitly.
     */
    callbacks?: OpenApiCallbackOptions;
    /** Replace response schemas for specific routes. Key format: "METHOD /path" or "METHOD /path STATUS" */
    schemas?: Record<string, import("json-schema").JSONSchema7>;
    /** Called before generating a response body. Return a schema to replace the original, or void to keep it. */
    onSchema?: (
      schema: import("json-schema").JSONSchema7,
      context: {
        method: string;
        path: string;
        params: Record<string, string>;
        query: Record<string, string>;
        headers: Record<string, string>;
      },
    ) => import("json-schema").JSONSchema7 | undefined;
  }

  /**
   * Seed data source: inline array, file path, or auto-generate count
   */
  type SeedSource = unknown[] | string | { count: number };

  /**
   * Seed configuration mapping resource names to seed sources
   */
  type SeedConfig = Record<string, SeedSource>;

  // ===== CLI Types =====

  /**
   * Options for the CLI server
   */
  interface CliOptions {
    spec: string;
    port?: number;
    hostname?: string;
    seed?: string;
    cors?: boolean;
    debug?: boolean;
    fakerSeed?: number;
    errors?: boolean;
    watch?: boolean;
    admin?: boolean;
    /** Validate the spec against the OpenAPI schema at startup (`--strict`). */
    strict?: boolean;
    /** Resolve `$ref`s outside the spec document (`--refs-external`). */
    refsExternal?: boolean;
    /**
     * Hosts an `http(s)` `$ref` may target (`--refs-allow-http`). Supplying
     * this also enables http resolution, which still requires `refsExternal`.
     */
    refsAllowHttp?: string[];
  }

  /** Browser-safe subset of the Node server exposed by a CLI instance. */
  interface CliHttpServer {
    readonly listening: boolean;
    address():
      | string
      | { address: string; family: string; port: number }
      | null;
    close(callback?: (error?: Error) => void): this;
    closeAllConnections(): void;
    closeIdleConnections(): void;
    ref(): this;
    unref(): this;
  }

  /**
   * Running CLI server instance. Import `CliServer` from `@schmock/cli` for
   * the exact Node.js server type.
   */
  interface CliServer {
    server: CliHttpServer;
    port: number;
    hostname: string;
    close(): void;
  }
}
