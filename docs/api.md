# API Reference

## Core (`@schmock/core`)

### `schmock(config?)`

Creates a callable mock instance.

```typescript
function schmock(config?: GlobalConfig): CallableMockInstance
```

```typescript
interface GlobalConfig {
  namespace?: string                   // base path prefix for all routes
  delay?: number | [number, number]    // response delay in ms, or [min, max] range
  debug?: boolean                      // enable debug logging
  state?: Record<string, unknown>      // initial shared state
}
```

### `CallableMockInstance`

#### Route definition (callable)

```typescript
mock(route: RouteKey, generator: Generator, config?: RouteConfig): CallableMockInstance
```

- `route` — `"METHOD /path"` format (e.g. `"GET /users/:id"`)
- `generator` — function, static data, or JSON schema
- `config` — optional route-specific config

```typescript
type RouteKey = `${HttpMethod} ${string}`
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'

type Generator = GeneratorFunction | StaticData | JSONSchema7
type GeneratorFunction = (ctx: RequestContext) => ResponseResult | Promise<ResponseResult>
type StaticData = string | number | boolean | null | undefined | Record<string, unknown> | unknown[]

interface RouteConfig {
  contentType?: string         // MIME type (auto-detected if omitted)
  delay?: number | [number, number]  // per-route delay override
  [key: string]: unknown       // custom route-specific data
}
```

#### `.handle(method, path, options?)`

Handle a request. Never throws — errors become response objects.

```typescript
handle(method: HttpMethod, path: string, options?: RequestOptions): Promise<Response>

interface RequestOptions {
  headers?: Record<string, string>
  body?: unknown
  query?: Record<string, string>
}

interface Response {
  status: number
  body: unknown
  headers: Record<string, string>
}
```

#### `.pipe(plugin)`

Add a plugin to the pipeline. Returns the instance for chaining.

```typescript
pipe(plugin: Plugin): CallableMockInstance
```

#### Request spying

```typescript
history(method?: HttpMethod, path?: string): RequestRecord[]
called(method?: HttpMethod, path?: string): boolean
callCount(method?: HttpMethod, path?: string): number
lastRequest(method?: HttpMethod, path?: string): RequestRecord | undefined

interface RequestRecord {
  method: HttpMethod
  path: string
  params: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
  timestamp: number
  response: { status: number; body: unknown }
}
```

#### Lifecycle

```typescript
reset(): void           // clear routes, state, history, plugins; stop server
resetHistory(): void    // clear request history only
resetState(): void      // reset state to initial config values
getState(): Record<string, unknown>
getRoutes(): RouteInfo[]  // [{ method, path, hasParams }]
```

#### Events

```typescript
on<E extends SchmockEvent>(event: E, listener: (data: SchmockEventMap[E]) => void): void
off<E extends SchmockEvent>(event: E, listener: (data: SchmockEventMap[E]) => void): void
```

| Event | Data |
|-------|------|
| `request:start` | `{ method, path, headers }` |
| `request:match` | `{ method, path, routePath, params }` |
| `request:notfound` | `{ method, path }` |
| `request:end` | `{ method, path, status, duration }` |

#### HTTP server

```typescript
listen(port?: number, hostname?: string): Promise<ServerInfo>  // default: port 0, hostname '127.0.0.1'
close(): void  // idempotent

interface ServerInfo { port: number; hostname: string }
```

### Request Context

Passed to generator functions:

```typescript
interface RequestContext {
  method: HttpMethod
  path: string
  params: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
  body?: unknown
  state: Record<string, unknown>     // mutable shared state
}
```

### Response Result

Generator functions can return:

```typescript
type ResponseResult =
  | ResponseBody                                    // plain value → 200
  | [number, unknown]                               // [status, body]
  | [number, unknown, Record<string, string>]       // [status, body, headers]
```

### Plugin Interface

```typescript
interface Plugin {
  name: string
  version?: string
  install?(instance: CallableMockInstance): void
  process(context: PluginContext, response?: unknown): PluginResult | Promise<PluginResult>
  onError?(error: Error, context: PluginContext): Error | ResponseResult | void | Promise<Error | ResponseResult | void>
}

interface PluginContext {
  path: string
  route: RouteConfig
  method: HttpMethod
  params: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
  body?: unknown
  state: Map<string, unknown>              // shared across plugins per request
  routeState?: Record<string, unknown>     // route-level persistent state
}

interface PluginResult {
  context: PluginContext
  response?: unknown
}
```

### Error Classes

All extend `SchmockError`:

```typescript
class SchmockError extends Error {
  readonly code: string
  readonly context?: unknown
}
```

| Class | Code | Context |
|-------|------|---------|
| `RouteNotFoundError` | `ROUTE_NOT_FOUND` | `{ method, path }` |
| `RouteParseError` | `ROUTE_PARSE_ERROR` | `{ routeKey, reason }` |
| `RouteDefinitionError` | `ROUTE_DEFINITION_ERROR` | `{ routeKey, reason }` |
| `ResponseGenerationError` | `RESPONSE_GENERATION_ERROR` | `{ route, originalError }` |
| `PluginError` | `PLUGIN_ERROR` | `{ pluginName, originalError }` |
| `SchemaValidationError` | `SCHEMA_VALIDATION_ERROR` | `{ schemaPath, issue, suggestion }` |
| `SchemaGenerationError` | `SCHEMA_GENERATION_ERROR` | `{ route, originalError, schema }` |
| `ResourceLimitError` | `RESOURCE_LIMIT_ERROR` | `{ resource, limit, actual }` |

### Constants

```typescript
HTTP_METHODS          // readonly ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
ROUTE_NOT_FOUND_CODE  // 'ROUTE_NOT_FOUND'
isHttpMethod(s)       // type guard → HttpMethod
toHttpMethod(s)       // normalize → HttpMethod (throws on invalid)
```

---

## Faker Plugin (`@schmock/faker`)

### `fakerPlugin(options)`

Generate data from JSON schemas using faker.js.

```typescript
function fakerPlugin(options: FakerPluginOptions): Plugin

interface FakerPluginOptions {
  schema: JSONSchema7
  count?: number                    // items for array schemas
  overrides?: Record<string, any>   // field overrides (supports templates)
  seed?: number                     // deterministic generation
}
```

### `generateFromSchema(options)`

Direct schema-to-data generation (used internally and available for standalone use).

```typescript
function generateFromSchema(options: SchemaGenerationContext): unknown

interface SchemaGenerationContext {
  schema: JSONSchema7
  count?: number
  overrides?: Record<string, any>
  params?: Record<string, string>
  state?: any
  query?: Record<string, string>
  seed?: number
}
```

### Template syntax

Override values support templates:

```typescript
overrides: {
  id: '{{params.id}}',          // route parameter
  owner: '{{state.user.name}}', // state value (nested access)
  q: '{{query.search}}',        // query parameter
}
```

### Smart field name mapping

The faker plugin maps property names to appropriate faker methods automatically. Examples:

| Field name | Generated as |
|-----------|--------------|
| `email`, `user_email` | Realistic email address |
| `name`, `full_name`, `display_name` | Person's full name |
| `phone`, `mobile`, `tel` | Phone number |
| `url`, `website`, `href` | URL |
| `avatar`, `photo_url`, `profile_image` | Image URL |
| `city`, `state`, `country` | Location data |
| `price`, `amount`, `salary` | Currency amount |
| `created_at`, `updated_at` | ISO datetime |
| `is_active`, `enabled` | Boolean (90% true) |
| `is_deleted` | Boolean (5% true) |
| `uuid`, `guid` | UUID v4 |
| `description`, `summary`, `bio` | Paragraph of text |
| `age` | Integer 18–80 |
| `rating`, `score`, `stars` | Integer 1–5 |

200+ field names are mapped. See `packages/faker/src/field-mappings.ts` for the complete list.

### Schema extensions

```typescript
{
  type: 'boolean',
  schmockTrueProbability: 0.8,   // 80% chance of true
}

{
  type: 'string',
  schmockNullable: true,         // ~5% chance of null
}
```

---

## Validation Plugin (`@schmock/validation`)

### `validationPlugin(options)`

Validate requests and responses using AJV.

```typescript
function validationPlugin(options: ValidationPluginOptions): Plugin

interface ValidationPluginOptions {
  request?: {
    body?: JSONSchema7
    query?: JSONSchema7
    headers?: JSONSchema7
  }
  response?: {
    body?: JSONSchema7
  }
  requestErrorStatus?: number    // default: 400
  responseErrorStatus?: number   // default: 500
}
```

Error response format:

```typescript
{
  error: "Request validation failed",
  code: "REQUEST_VALIDATION_ERROR",  // or QUERY_, HEADER_, RESPONSE_
  details: [{ path: "/name", message: "must be string", keyword: "type" }]
}
```

---

## Query Plugin (`@schmock/query`)

### `queryPlugin(options?)`

Pagination, sorting, and filtering for array responses.

```typescript
function queryPlugin(options?: QueryPluginOptions): Plugin

interface QueryPluginOptions {
  pagination?: {
    defaultLimit?: number       // default: 10
    maxLimit?: number           // default: 100
    pageParam?: string          // default: "page"
    limitParam?: string         // default: "limit"
  }
  sorting?: {
    allowed: string[]           // required: fields allowed for sorting
    default?: string
    defaultOrder?: 'asc' | 'desc'  // default: "asc"
    sortParam?: string          // default: "sort"
    orderParam?: string         // default: "order"
  }
  filtering?: {
    allowed: string[]           // required: fields allowed for filtering
    filterPrefix?: string       // default: "filter"
  }
}
```

Query parameters:

| Feature | Format | Example |
|---------|--------|---------|
| Pagination | `?page=N&limit=N` | `?page=2&limit=10` |
| Sorting | `?sort=field&order=asc\|desc` | `?sort=name&order=desc` |
| Filtering | `?filter[field]=value` | `?filter[role]=admin` |

Pagination response format:

```typescript
{
  data: [...],
  pagination: { page: 2, limit: 10, total: 50, totalPages: 5 }
}
```

---

## OpenAPI Plugin (`@schmock/openapi`)

### `openapi(options)`

Auto-register routes from an OpenAPI/Swagger spec.

```typescript
async function openapi(options: OpenApiOptions): Promise<Plugin>
```

```typescript
interface OpenApiOptions {
  spec: string | object              // file path or inline spec
  seed?: SeedConfig                  // seed data per resource
  validateRequests?: boolean         // validate request bodies (default: false)
  validateResponses?: boolean        // validate responses (default: false)
  security?: boolean                 // enforce security schemes (default: false)
  fakerSeed?: number                 // deterministic generation
  debug?: boolean                    // log CRUD detection (default: false)
  schemas?: Record<string, JSONSchema7>   // replace response schemas
  onSchema?: OnSchemaCallback        // dynamic schema modification
  resources?: Record<string, ResourceOverride>  // override CRUD detection
  queryFeatures?: {
    pagination?: boolean
    sorting?: boolean
    filtering?: boolean
  }
}

type SeedConfig = Record<string, SeedSource>
type SeedSource = unknown[] | string | { count: number }

type OnSchemaCallback = (
  schema: JSONSchema7,
  context: {
    method: string
    path: string
    params: Record<string, string>
    query: Record<string, string>
    headers: Record<string, string>
  },
) => JSONSchema7 | undefined

interface ResourceOverride {
  listWrapProperty?: string       // property holding items (e.g. "data")
  listFlat?: boolean              // force flat array response
  errorSchema?: JSONSchema7       // custom error response format
}
```

Supports Swagger 2.0, OpenAPI 3.0, and OpenAPI 3.1.

See the [OpenAPI guide](./openapi.md) for detailed usage.

---

## Express Adapter (`@schmock/express`)

### `toExpress(mock, options?)`

Convert a Schmock instance to Express middleware.

```typescript
function toExpress(mock: CallableMockInstance, options?: ExpressAdapterOptions): RequestHandler

interface ExpressAdapterOptions {
  passErrorsToNext?: boolean     // default: true
  errorFormatter?: (error: Error, req: Request) => any
  transformHeaders?: (headers: Request['headers']) => Record<string, string>
  transformQuery?: (query: Request['query']) => Record<string, string>
  beforeRequest?: (req: Request, res: Response) =>
    | { method?: string; path?: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> }
    | undefined | Promise<any>
  beforeResponse?: (response: Schmock.Response, req: Request, res: Response) =>
    | { status: number; body: any; headers: Record<string, string> }
    | undefined | Promise<any>
}
```

See the [Express guide](./express.md) for detailed usage.

---

## Angular Adapter (`@schmock/angular`)

### `createSchmockInterceptor(mock, options?)`

Create an Angular HTTP interceptor class.

```typescript
function createSchmockInterceptor(
  mock: CallableMockInstance,
  options?: AngularAdapterOptions,
): new () => HttpInterceptor
```

### `provideSchmockInterceptor(mock, options?)`

Returns a ready-to-use Angular provider.

```typescript
function provideSchmockInterceptor(
  mock: CallableMockInstance,
  options?: AngularAdapterOptions,
): { provide: InjectionToken; useClass: new () => HttpInterceptor; multi: true }
```

### `createSchmockInterceptorFromSpec(openapiOptions, adapterOptions?)`

Create interceptor from an OpenAPI spec.

### `provideSchmockInterceptorFromSpec(openapiOptions, adapterOptions?)`

Create provider from an OpenAPI spec.

```typescript
interface AngularAdapterOptions {
  baseUrl?: string              // only intercept requests starting with this URL
  passthrough?: boolean         // pass unmatched requests to real backend (default: true)
  errorFormatter?: (error: Error, request: HttpRequest<any>) => any
  transformRequest?: (request: HttpRequest<any>) => {
    method?: string; path?: string; headers?: Record<string, string>; body?: any; query?: Record<string, string>
  }
  transformResponse?: (response: Schmock.Response, request: HttpRequest<any>) => Schmock.Response
}
```

### Helper functions

```typescript
notFound(message?: string | object): [404, object]
badRequest(message?: string | object): [400, object]
unauthorized(message?: string | object): [401, object]
forbidden(message?: string | object): [403, object]
serverError(message?: string | object): [500, object]
created(body: object): [201, object]
noContent(): [204, null]
paginate<T>(items: T[], options?: { page?: number; pageSize?: number }): PaginatedResponse<T>
```

See the [Angular guide](./angular.md) for detailed usage.

---

## CLI (`@schmock/cli`)

### `createCliServer(options)`

Start a mock server programmatically.

```typescript
async function createCliServer(options: CliOptions): Promise<CliServer>

interface CliOptions {
  spec: string
  port?: number              // default: 3000
  hostname?: string          // default: '127.0.0.1'
  seed?: string              // path to JSON seed file
  cors?: boolean             // default: false
  debug?: boolean            // default: false
  fakerSeed?: number
  errors?: boolean           // enable request validation
  watch?: boolean            // watch spec for changes
  admin?: boolean            // enable admin API
}

interface CliServer {
  server: http.Server
  port: number
  hostname: string
  close(): void
}
```

### `parseCliArgs(args)`

Parse CLI arguments.

```typescript
function parseCliArgs(args: string[]): CliOptions & { help: boolean }
```

### `run(args)`

Entry point for the CLI binary. Parses args, starts server, handles SIGINT/SIGTERM.

```typescript
async function run(args: string[]): Promise<void>
```

See the [CLI guide](./cli.md) for detailed usage.
