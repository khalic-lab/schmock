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
  maxHistorySize?: number              // FIFO history limit; unbounded by default
}
```

`maxHistorySize` must be a non-negative integer. `0` disables history; omitting
it leaves history unbounded. Any other value — negative (which once meant
unbounded), fractional, `NaN` or `Infinity` — throws a `SchmockError`
(`INVALID_CONFIG`) from `schmock()`.

Each mock keeps one persistent state object from creation. A supplied state
object is used until reset; when `state` is omitted, the default is one empty
object rather than a new object per request.

### `CallableMockInstance`

#### Route definition (callable)

```typescript
mock(route: RouteKey, generator: Generator, config?: RouteConfig): CallableMockInstance
```

- `route` — `"METHOD /path"` format (e.g. `"GET /users/:id"`); the path must
  start with `/`
- `generator` — a function called per request, or static data returned verbatim
- `config` — optional route-specific config

```typescript
type RouteKey = `${HttpMethod} /${string}`
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'

type Generator = GeneratorFunction | StaticData
type GeneratorFunction = (ctx: RequestContext) => ResponseResult | Promise<ResponseResult>
type StaticData =
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, unknown>
  | unknown[]
  | ArrayBuffer
  | ArrayBufferView

interface RouteConfig {
  contentType?: string         // MIME type (auto-detected if omitted)
  delay?: number | [number, number]  // per-route delay override
  [key: string]: unknown       // custom route-specific data
}
```

A route key without a leading slash is a compile error and is rejected at
definition time with `RouteParseError`. Build keys from untyped strings with
`toRouteKey(method, path)`, which supplies the slash.

There is no schema arm: a JSON Schema passed as the generator is static data
and is serialized back to the client as a literal schema document. Schema-driven
responses come from a plugin — `.pipe(fakerPlugin({ schema }))`.

Only an object *literal* satisfies `StaticData`. A variable declared as
`JSONSchema7` (or `Schmock.Schema`) has no index signature and no longer
typechecks as a generator — inline it, or widen it to
`Record<string, unknown>`.

`contentType` is auto-detected from the **generator's shape**, not the body's:
a function generator defaults to `application/json`, a static string, number or
boolean defaults to `text/plain`, static binary values default to
`application/octet-stream`, and everything else defaults to
`application/json`.

#### `.handle(method, path, options?)`

Handle a request. Ordinary route, plugin, and response failures become response
objects. Cancellation rejects with the signal reason (or an `AbortError`) and
does not commit the request to history.

```typescript
handle(method: HttpMethod, path: string, options?: RequestOptions): Promise<Response>

interface RequestOptions {
  headers?: Record<string, string>
  body?: unknown
  query?: Record<string, string>
  signal?: AbortSignal
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

Every request that matched a route is recorded, including one whose generator
or plugin threw — the recorded `response` carries the resulting 500. Route
misses and canceled requests are not recorded. Records
are detached snapshots created when a request completes. A request or response
body that cannot be structured-cloned is stored as an `unavailable` descriptor
instead of retaining a mutable application reference. `resetHistory()` is also
a barrier: requests admitted before it cannot later repopulate the cleared
history. The `path` filter accepted by `history()`, `called()`, `callCount()`
and `lastRequest()` is percent-encoded and trailing-slash-normalized before
comparison, so either spelling matches: `called('GET', '/users/José')` and
`called('GET', '/users/Jos%C3%A9')` both find the same record. History stores
the namespace-stripped path, so filter on the route-relative form.

#### Lifecycle

```typescript
reset(): void           // clear routes, state, history, plugins, listeners; stop Node server
resetHistory(): void    // clear request history only
resetState(): void      // replace shared state with an empty object
getState(): Record<string, unknown>
getRoutes(): RouteInfo[]  // [{ method, path, hasParams }]
```

`reset()` and `resetState()` replace internal state without mutating the object
originally passed by the caller. A full reset retires the current request
generation: admitted requests finish against their original route, state, and
plugin snapshots, but cannot emit stale events or enter the new history.
Explicit fetch-interception leases remain active until restored by their owner.

#### Events

```typescript
on<E extends SchmockEvent>(event: E, listener: (data: SchmockEventMap[E]) => void): CallableMockInstance
off<E extends SchmockEvent>(event: E, listener: (data: SchmockEventMap[E]) => void): CallableMockInstance
```

| Event | Data |
|-------|------|
| `request:start` | `{ method, path, headers }` |
| `request:match` | `{ method, path, routePath, params }` |
| `request:notfound` | `{ method, path }` |
| `request:end` | `{ method, path, status, duration }` |

Event payloads and listener sets are immutable snapshots for each emission.
Listener failures are isolated from the request, and returned promises are
observed for rejection but are not awaited. A full reset clears listeners and
suppresses events from the retired request generation.

#### HTTP server

```typescript
listen(port?: number, hostname?: string): Promise<ServerInfo>  // default: port 0, hostname '127.0.0.1'
close(): void  // idempotent

interface ServerInfo { port: number; hostname: string }
```

Server start is reserved synchronously: a second pending or running start
throws `SERVER_ALREADY_RUNNING`. `close()` is idempotent, cancels a
pending start with `SERVER_START_CANCELLED`, stops accepting requests before
closing connections, and permits an immediate same-port restart after the
close barrier.

Node ingress accepts at most 10 MiB per request, checked against both declared
`Content-Length` and observed stream bytes. Oversized payloads return a
structured 413 `PAYLOAD_TOO_LARGE`; malformed JSON for `application/json` or
`+json` media types returns a structured 400 `MALFORMED_JSON`. Ingress failures
close the connection and do not execute a route or enter history. Client
disconnects abort admitted work.

#### `.intercept(options?)`

Patch `globalThis.fetch` and route matching requests through the mock:

```typescript
mock('GET /api/users', [{ id: 1, name: 'Alice' }])

const interception = mock.intercept({
  baseUrl: '/api',
  passthrough: true,
})

await fetch('/api/users')

interception.update({ baseUrl: '/api', passthrough: false })
interception.restore()
```

```typescript
interface InterceptHandle {
  restore(): void                          // release this lease
  update(options?: InterceptOptions): void // reconfigure it in place
  readonly active: boolean
}
```

`baseUrl` accepts either a pathname prefix or an absolute origin with an
optional path. Path prefixes enforce segment boundaries. Relative URLs resolve
against the browser document base when available. The base filters requests but
does not strip the matching prefix before route lookup.

The interceptor creates one effective `Request`, including `RequestInit`
overrides, and snapshots it at admission. JSON bodies are parsed only for JSON
media types; unmatched passthrough receives the original effective body and
headers. Aborts settle pending request/response hooks, route generators, and
passthrough fetches.

Interception is a lease, not a lock. A mock may hold any number of concurrent
leases — nested providers, separate roots, or an adapter alongside a manual
`intercept()` — and each one carries its own options and its own idempotent
`restore()`. Leases are consulted newest-first regardless of which mock owns
them, and the original `fetch` returns once the last lease is released.

`update(options?)` reconfigures a lease without re-registering it, so it keeps
its position in the dispatch order: an adapter can apply new hooks without
stealing precedence from a mock that registered later. Options are replaced
wholesale — omitted fields fall back to their defaults, so `update({})` restores
`passthrough: true`. Calling it on a released lease does nothing.

Restoration does not overwrite a later third-party fetch replacement, and
`reset()` does not release an explicit interception lease.

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
  pluginState?: Map<string, unknown> // per-request plugin state (same Map as PluginContext.state)
  readonly signal?: AbortSignal     // request cancellation
}
```

`pluginState` is the channel a generator uses to hand request-scoped data to the
plugins that post-process its response — `@schmock/openapi` stages CRUD
mutations there and commits them once the final status is known. It is absent
when a generator is called outside the request pipeline.

### Response Result

Generator functions can return:

```typescript
type ResponseResult =
  | ResponseBody                                    // plain value → 200
  | [number, unknown]                               // [status, body]
  | [number, unknown, Record<string, string>]       // [status, body, headers]
  | { status: number, body: unknown, headers?: Record<string, string> }
```

The object envelope is equivalent to the tuple forms and is what plugin error
recovery produces.

> **Ambiguity:** both the tuple and the envelope are detected by shape. A plain
> length-2 numeric array whose first element falls in the HTTP-status range
> (100–599) — e.g. `[200, 300]` as a coordinate pair — is indistinguishable
> from a `[status, body]` tuple, and any returned object carrying a numeric
> `status` alongside a `body` is unwrapped as an envelope rather than delivered
> as the payload. If your data can match either shape, nest it
> (`{ value: [200, 300] }`, `{ value: { status, body } }`) or return the
> envelope you actually mean as an explicit `[status, body]` tuple.

An object whose `headers` is present but is not a record of strings is *not* an
envelope: it is delivered whole as the body. Plugins that unwrap envelopes must
apply the same rule — see [What gets validated](#what-gets-validated) for what
that means when a response schema is attached.

Final response statuses must be finite integers from 200 through 599. Bodies are
removed for HEAD, 204, 205, and 304 responses. Other bodies must be strings,
binary values, or losslessly JSON-compatible values. Nested `undefined`, sparse
arrays, maps, promises, and nested binary values are rejected rather than
silently altered; unsupported values return a structured `INVALID_RESPONSE`
500 response. Header names are unique case-insensitively and transport-invalid
control characters are rejected.
Transport framing headers are adapter-owned and removed from ordinary
responses; HEAD may retain an explicit representation `Content-Length`, and
304 representation metadata is preserved.

A string returned in a bare status tuple such as `[200, "hello"]` is emitted as
raw, untyped text. Add an explicit JSON content type when the string should be
JSON encoded.

Advanced adapter authors can import `normalizeResponse()` and
`serializeResponseBody()` from `@schmock/core` to apply this same contract.

### Plugin Interface

```typescript
interface Plugin {
  name: string
  version?: string
  install?(instance: CallableMockInstance): void
  uninstall?(instance: CallableMockInstance): void
  beforeRequest?(context: PluginContext): PluginResult | void | Promise<PluginResult | void>
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
  requestShortCircuited?: boolean          // response came from beforeRequest
  routeState?: Record<string, unknown>     // route-level persistent state
  readonly signal?: AbortSignal            // request cancellation
}

interface PluginResult {
  context: PluginContext
  response?: unknown
}
```

`install()` receives a synchronous, installation-scoped callable. Routes it
registers are committed atomically only after the hook returns successfully;
the callable must not be retained. Promise-returning installs are rejected.
During `reset()`, `uninstall()` runs in reverse order after requests admitted
with that plugin generation have settled.

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
| `InvalidResponseError` | `INVALID_RESPONSE` | `{ reason, ...details }` |
| `PluginError` | `PLUGIN_ERROR` | `{ pluginName, originalError }` |
| `SchemaValidationError` | `SCHEMA_VALIDATION_ERROR` | `{ schemaPath, issue, suggestion }` |
| `SchemaGenerationError` | `SCHEMA_GENERATION_ERROR` | `{ route, originalError, schema }` |
| `ResourceLimitError` | `RESOURCE_LIMIT_ERROR` | `{ resource, limit, actual }` |

`ResponseGenerationError` was removed: a failing generator now surfaces as the
same structured 500 (`INTERNAL_ERROR`) as any other unhandled exception, and a
non-`Error` throw keeps its own value in the response body (truncated at 200
characters) instead of being flattened to `Unknown error`.

### Constants

```typescript
HTTP_METHODS          // readonly ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
ROUTE_NOT_FOUND_CODE  // 'ROUTE_NOT_FOUND'
isHttpMethod(s)       // type guard → HttpMethod
toHttpMethod(s)       // normalize → HttpMethod (throws on invalid)
toRouteKey(m, path)   // build a RouteKey, supplying the required leading slash
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
  overrides?: Record<string, unknown> // field overrides (supports templates)
  seed?: number                     // deterministic generation
}
```

### `generateFromSchema(options)`

Direct schema-to-data generation (used internally and available for standalone
use). It is asynchronous — `await` the result. A rejected promise never throws
synchronously, so assert on it with `await expect(...).rejects` rather than
`expect(() => ...).toThrow()`.

```typescript
async function generateFromSchema(options: SchemaGenerationContext): Promise<unknown>

interface SchemaGenerationContext {
  schema: JSONSchema7
  count?: number
  overrides?: Record<string, unknown>
  params?: Record<string, string>
  state?: Record<string, unknown>
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
Unconstrained strings without a recognized field name use non-empty lorem text;
explicit constraints such as `minLength: 0` remain authoritative. Draft 7 tuple
schemas are normalized recursively, including tuples behind `$ref` definitions.

### Schema extensions

```typescript
{
  type: 'boolean',
  schmockTrueProbability: 0.8,   // 80% chance of true
}

{
  type: ['string', 'null'],      // null-permitting union, emitted by the
  schmockNullable: true,         // OpenAPI normalizer for `nullable: true`
}                                // ~5% chance of null at generation time
```

`schmockNullable` marks a field for the ~5% null roll during generation. When
the OpenAPI plugin normalizes `nullable: true` it emits the marker **alongside**
a schema that actually permits `null` — `type: [T, 'null']`, or
`anyOf: [{ type: 'null' }, …]` when the schema is composition-only
(`allOf`/`oneOf`/`anyOf`/`$ref` with no local `type`) — so a generated `null`
passes request and response validation. The generation path collapses the union
back to the non-null shape, so json-schema-faker does not treat it as a 50/50
type choice.

`faker`, `schmockNullable` and `schmockTrueProbability` are Schmock's own
keywords and are not part of `JSONSchema7`, so a schema literal that uses them
fails to typecheck against it. Declare such schemas as `Schmock.Schema` — draft-07
plus these three keywords, applied recursively to nested subschemas — and pass
them wherever a `JSONSchema7` is accepted:

```typescript
const userSchema: Schmock.Schema = {
  type: 'object',
  properties: {
    name: { type: 'string', faker: 'person.fullName' },
    nickname: { type: ['string', 'null'], schmockNullable: true },
    active: { type: 'boolean', schmockTrueProbability: 0.8 },
  },
}

mock.pipe(fakerPlugin({ schema: userSchema }))
```

Only `@schmock/*` packages understand these keywords, and AJV in strict mode
rejects keywords it does not know. `@schmock/validation` registers
`schmockNullable` and `schmockTrueProbability` on its own instance
(`ajv.addVocabulary([...])`), but **not** `faker`: handing a `faker`-carrying
schema to `validationPlugin` throws `strict mode: unknown keyword: "faker"` at
plugin construction. Keep the generation schema and the validation schema
separate, or register the keyword on your own AJV instance the same way.

---

## Validation Plugin (`@schmock/validation`)

### `validationPlugin(options)`

Validate requests and responses using AJV.

```typescript
function validationPlugin(options: ValidationPluginOptions): Plugin

interface ValidationPluginOptions {
  request?: {
    body?: JSONSchema7
    bodyRequired?: boolean       // default: false
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

`ValidationPluginOptions` and `ValidationRules` are exported from
`@schmock/validation` for typing shared configuration objects.

Request rules run before the route generator. Set `bodyRequired: true` when an
absent body must be rejected; supplied bodies are always validated.

Error response format:

```typescript
{
  error: "Request validation failed",
  code: "REQUEST_VALIDATION_ERROR",  // or QUERY_, HEADER_, RESPONSE_
  details: [{
    instancePath: "/name",
    schemaPath: "#/properties/name/type",
    keyword: "type",
    params: { type: "string" },
    message: "must be string"
  }]
}
```

`details` entries are raw Ajv `ErrorObject`s — the instance location is
`instancePath`, not `path`. The one exception is the `bodyRequired` rejection,
which emits a synthetic detail carrying only `instancePath: ""`, `keyword` and
`message`. Note that `@schmock/openapi` reshapes Ajv errors to `{ path, ... }`,
so the two packages' `details` differ despite similar error codes.

#### What gets validated

Validation judges **own properties only**, enumerable or not. A property
inherited from a prototype neither satisfies `required` nor trips
`additionalProperties: false`. A non-enumerable own property still counts for
`required` and `properties` even though `JSON.stringify` omits it from the
wire, so return plain objects from generators rather than objects carrying
hand-defined property descriptors.

`response.body` targets the **semantic body** — the value the generator and
plugins produced — not the serialized transport payload. Content-type
conversion runs after the plugin pipeline, so a route configured with
`contentType: 'text/plain'` validates the object and then delivers its JSON
string form. Write response schemas against the value you return, not against
the bytes the client receives.

Tuple (`[status, body]`) and object (`{ status, body, headers? }`) response
envelopes are unwrapped so the schema applies to the body rather than the
envelope. An envelope whose `headers` is present but is not a record of
strings is not a valid envelope: core delivers the whole object as the body,
and validation applies the schema to that same whole object — which normally
fails and returns `RESPONSE_VALIDATION_ERROR`.

#### Schema trust boundary

Schemas passed to `validationPlugin` are **trusted configuration**, on the same
footing as route handler code. They are compiled once at plugin construction,
and `pattern`/`patternProperties` become native regular expressions with no
safety screening — a catastrophically backtracking pattern will block the
event loop on request-controlled input. Never build schemas from untrusted
input, and when exposing a mock over a network (the CLI or the Express
adapter), treat the spec and its schemas as part of the trusted deployment.

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

`PaginationOptions`, `SortingOptions`, `FilteringOptions`,
`QueryPluginOptions` and `PaginatedResult` are exported from `@schmock/query`.

Every section is optional — `queryPlugin()` with no options passes responses
through untouched. Invalid options throw a `SchmockError`
(`QUERY_CONFIG_INVALID`) at creation time: limits must be positive integers,
parameter names must be non-empty strings, and `allowed` must be an array of
field names that excludes `__proto__`, `constructor` and `prototype`.

Query parameters:

| Feature | Format | Example |
|---------|--------|---------|
| Pagination | `?page=N&limit=N` | `?page=2&limit=10` |
| Sorting | `?sort=field&order=asc\|desc` | `?sort=name&order=desc` |
| Filtering | `?filter[field]=value` or `?filter.field=value` | `?filter[role]=admin` |

`page` and `limit` must be exact positive integers (`"2"`); anything else —
padded, signed, fractional, exponent notation or partially numeric — falls
back to the default rather than being coerced.

Filters must use a prefixed form. The plain `?field=value` form is not
honoured, so a filterable field named `page` can never collide with the
pagination control.

Filtering and sorting read **own properties only**, on both the query and the
item side: a value that lives on a prototype or on a class-instance getter is
invisible to both. Enumerability is not consulted — a non-enumerable own field
on an item is still filtered and sorted on even though `JSON.stringify` drops
it from the serialized response. Return plain objects from generators if you
filter or sort on them.

Mixed-type sort fields are grouped by type before being compared — finite
numbers, then non-finite numbers, then strings, then booleans, then everything
else — so the result never depends on the input order. Items missing the sort
field always come last, in either direction.

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
  strict?: boolean                   // validate the spec at load time (default: false)
  refs?: OpenApiRefPolicy            // external $ref policy (external refs off by default)
  callbacks?: {
    dispatch(request: OpenApiCallbackRequest): void | Promise<void>
  }
}

interface OpenApiRefPolicy {
  external?: boolean       // resolve $refs outside the root document (default: false)
  allowHttp?: boolean      // also resolve http(s) refs (default: false)
  allowedHosts?: string[]  // hosts an http ref may target (default: any public host)
  timeoutMs?: number       // default: 5000
  redirects?: number       // default: 0
  maxBytes?: number        // default: 1_000_000
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

Callbacks are disabled by default and never issue implicit network requests.
The legacy `queryFeatures` option is unsupported and throws
`OPENAPI_UNSUPPORTED_OPTION` when supplied.

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
): { provide: InjectionToken; useFactory: () => HttpInterceptor; multi: true }
```

`useFactory`, not `useClass`: the interceptor class is built at runtime, so
Angular's AOT compiler never sees it and `useClass` would fail with NG0204
("needs JIT compiler") in AOT builds.

### `createSchmockInterceptorFromSpec(openapiOptions, adapterOptions?)`

Create interceptor from an OpenAPI spec.

```typescript
async function createSchmockInterceptorFromSpec(
  openapiOptions: OpenApiOptions,
  adapterOptions?: AngularAdapterOptions,
): Promise<new () => HttpInterceptor>
```

### `provideSchmockInterceptorFromSpec(openapiOptions, adapterOptions?)`

Create provider from an OpenAPI spec. Same `useFactory` shape, awaited.

```typescript
async function provideSchmockInterceptorFromSpec(
  openapiOptions: OpenApiOptions,
  adapterOptions?: AngularAdapterOptions,
): Promise<{ provide: InjectionToken; useFactory: () => HttpInterceptor; multi: true }>
```

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

`paginate()` normalizes its options: `page` and `pageSize` must be integers `>= 1`, and any other
value (`0`, negative, fractional, `NaN`, `Infinity`, missing) falls back to page `1` and page size
`10`. The returned envelope echoes the normalized values, so `data`, `page`, `pageSize` and
`totalPages` are always mutually consistent.

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
  watch?: boolean            // watch spec for changes (honored here, not only by the binary)
  admin?: boolean            // enable admin API
  adminToken?: string        // bearer token for /schmock-admin/* (generated when omitted)
  adminHistoryLimit?: number // requests retained for the admin history (default: 500)
  strict?: boolean           // validate the spec at startup (--strict)
  refsExternal?: boolean     // resolve $refs outside the spec (--refs-external)
  refsAllowHttp?: string[]   // hosts an http $ref may target (--refs-allow-http)
  shutdownGraceMs?: number   // close() waits this long for in-flight requests (default: 5000)
}

interface CliServer {
  server: http.Server
  port: number
  hostname: string
  adminToken?: string        // present only when admin is enabled
  close(): Promise<void>
}
```

`hostname` must be a non-blank string. `createCliServer({ hostname: '' })`
rejects instead of starting: an empty host binds every interface rather than
the documented `127.0.0.1` default.

`watch: true` starts the spec watcher here, not only under the `--watch` flag,
and the promise rejects if the watcher cannot be created — nothing is left
bound when it does.

`close()` stops accepting first, then stops the watcher, and resolves once the
socket is released. In-flight requests — and a watcher reload still parsing —
get `shutdownGraceMs` to finish; whatever is still open then is destroyed, so
a half-sent request cannot keep the process alive.
It is memoized — calling it twice returns the same promise and both callers
resolve — and it never calls `process.exit()`.

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

The returned promise settles when the server has shut down, not when it has
started: on `--help` or a missing `--spec` it resolves immediately, otherwise
it stays pending until `SIGINT`/`SIGTERM` arrives and the close completes (and
rejects if that close fails). Both signal handlers are removed as shutdown
begins, so a host process that calls `run` repeatedly does not accumulate them.

See the [CLI guide](./cli.md) for detailed usage.
