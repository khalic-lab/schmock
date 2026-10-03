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

One trailing slash on `namespace` is ignored: `'/api/'` and `'/api'` are the
same namespace. Both serve `/api`, `/api/` and `/api/users`, and neither serves
`/api//users` (404) or `/apiv2/users`. `'/api/'` used to serve `/api//users`.
The namespace follows the same prefix rule as the fetch interceptor's
`baseUrl`; see [`parsePathPrefix()`](#path-prefixes).

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

A route that matches the same requests as an existing route of the same method
is a duplicate, including one that differs only in parameter names
(`GET /users/:id` then `GET /users/:userId`). The first registration wins,
`getRoutes()` lists only that one, and debug mode logs
`Duplicate route: GET /users/:userId matches the same requests as GET /users/:id — first registration wins`.

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

##### Path parameters

| Syntax | Meaning | Example |
|--------|---------|---------|
| `:name` | A parameter. Name characters are `[A-Za-z0-9_-]`; any other character ends the name and is literal. | `GET /files/:name.json` |
| `:a-:b` | Hyphens that end a name directly before another parameter are a literal separator. | `GET /range/:from-:to` on `/range/1-5` gives `{ from: '1', to: '5' }` |
| `:"name"` | A quoted name may contain other characters. | `GET /users/:"user.id"` gives `params['user.id']` |
| `\:` | A literal colon. | `POST /jobs/:job\:cancel` on `/jobs/abc:cancel` gives `{ job: 'abc' }` |

A hyphen inside a name that is not followed by another parameter still belongs
to the name: `:user-id` is one parameter. In JavaScript source the escaped
colon is written with a doubled backslash, `"POST /jobs/:job\\:cancel"`. A key
whose only colon is escaped is a static route: `POST /jobs\:batchGet` serves
`/jobs:batchGet`.

Two parameters with nothing between them (`/:a:b`) throw `RouteParseError`
(`ROUTE_PARSE_ERROR`) at definition time.

With several parameters in one segment, each one except the last stops at the
first character of the literal that follows it, as in Express: `:name.:ext` on
`a.tar.gz` gives name `'a'` and ext `'tar.gz'`. A single parameter before a
suffix stays greedy: `:name.json` on `report.v2.json` gives `'report.v2'`.
When the separator is a character that percent-encodes in the URL, such as a
non-ASCII letter, the earlier capture ends at the whole encoded separator and
may itself contain other encoded characters: `:aé:b` on `x%C3%A0%C3%A9y` gives
`{ a: 'xà', b: 'y' }`.

`getRoutes()` reports a route with parameters in its escaped spelling
(`/jobs/:job\:cancel`) and a route without parameters as its literal path
(`/jobs:batchGet`).

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

`pipe()` throws `SchmockError` `PLUGIN_INVALID` for a plugin that could never
work: a non-object, a missing or non-function `process`, or an `install`,
`beforeRequest` or `onExchange` set to a truthy non-function. Falsy hooks
(`onError: null`, `install: false`) are accepted. Piping the same plugin object
again is a no-op, and debug mode logs
`Plugin <name> is already piped into this mock — ignored`.
Distinct objects with the same name, such as two `openapi()` plugins, still
stack.

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
are detached snapshots created when a request completes. The recorded `body`,
`query`, `headers` and `params` are captured when the route matches, before any
plugin or the generator runs, so they show what the client sent even if a
generator edits `ctx.body` in place. The generator itself still receives the
caller's object by reference. A request or response
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

Events describe the mock's own handling: `request:end` fires before an
adapter's `beforeResponse` and `errorFormatter` run, and carries no bodies. For
what a caller finally received, use [`Plugin.onExchange`](#plugin-interface).

Event payloads and listener sets are immutable snapshots for each emission.
Listener failures are isolated from the request, and returned promises are
observed for rejection but are not awaited. A full reset clears listeners and
suppresses events from the retired request generation.

Every `request:start` is followed by exactly one `request:end`. A request
cancelled through its `signal` emits `request:end` with `status: 499` (client
closed request) before the promise rejects with the abort reason. It is still
not recorded in history.

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

The built-in server answers a request without a `Host` header
(`Missing Host header`), with a malformed `Host` header (`Malformed Host header`)
or with a malformed request target (`Malformed request target`) with 400
`BAD_REQUEST`. It answers a method outside
`HTTP_METHODS` with 405 `METHOD_NOT_ALLOWED` and
`Allow: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS`, the same as the CLI. The
request target is routed by its full path: `GET //users` is looked up as
`//users`, never as `/` or `/users`. A server-level `error` event after startup
(such as an accept `EMFILE`) is logged in the debug `server` category instead
of crashing the process.

Each request goes through [`serveNodeRequest()`](#servenoderequest), the same
bridge the CLI uses, so both answer client errors alike.

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
against the browser document base when available. A path-form base without a
leading slash is rooted: `'api'` behaves as `'/api'`. The base filters requests
but, unlike the Angular adapter's `baseUrl`, does not strip the matching prefix
before route lookup, so register routes with the full path (`GET /api/users`).

The interceptor creates one effective `Request`, including `RequestInit`
overrides, and snapshots it at admission. JSON bodies are parsed only for JSON
media types; unmatched passthrough receives the original effective body and
headers. Aborts settle pending request/response hooks, route generators, and
passthrough fetches.

With `passthrough: true` and no `beforeRequest` hook, a request that no route
matches is never read or parsed. The interceptor checks the mock's routes
first and forwards the original request untouched, while `request:start`,
`request:notfound` and `request:end` still fire. An unreadable body (malformed
multipart, an erroring stream) sent to an unmocked URL therefore reaches the
network instead of rejecting the fetch. A matched route still reads it, and a
failure there still rejects or goes to `errorFormatter`.

`errorFormatter(error, request)` receives the request as routed: the
`AdapterRequest` after `beforeRequest` once that hook has returned, the
pre-hook request when the hook threw, and the incoming request without a body
when the body itself could not be read. One-argument formatters still work.

An empty JSON body reaches the route as `undefined`. With `passthrough: false`,
a JSON body that does not parse gets 400
`{ error: 'Malformed JSON request body', code: 'MALFORMED_JSON' }` before any
route runs, and nothing enters history, as with the Node ingress. With
`passthrough: true` a matching route still receives the unparsed text.

A method outside `HTTP_METHODS` (`PROPFIND`, `PURGE`, …), including one a
`beforeRequest` hook produces, is a route miss: it passes through when
`passthrough` is `true` and gets 404 `ROUTE_NOT_FOUND` when it is `false`.

A mocked `Response` reports `response.url` as the request URL without its
fragment. `statusText` is `''`.

Interception is a lease, not a lock. A mock may hold any number of concurrent
leases — nested providers, separate roots, or an adapter alongside a manual
`intercept()` — and each one carries its own options and its own idempotent
`restore()`. Leases are consulted newest-first regardless of which mock owns
them, and the original `fetch` returns once the last lease is released. A mock
is consulted once per distinct effective method and path across its leases, so
its handler and lifecycle events run once per request it is asked.

A lease without `beforeRequest` claims a request before answering it, so an
older `passthrough: false` lease leaves an unmocked request, malformed JSON or
a non-standard method included, to the network once a newer lease has passed
it through. A lease with `beforeRequest` knows its effective request only after
the hook runs, so it still answers 400 `MALFORMED_JSON` before its hook.

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

A repeated query key resolves to its last value (`?tag=a&tag=b` gives `'b'`)
on every transport: the CLI, `mock.listen()`, `mock.intercept()` (React and
Vue), Express and Angular.

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
envelope: it is delivered whole as the body. Plugins that unwrap envelopes
should read the result with [`getResponseParts()`](#response-parts) and rewrite
it with `replaceResponseBody()`, which apply core's own rule, rather than
re-implement it. See [What gets validated](#what-gets-validated) for what the
rule means when a response schema is attached.

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
  install?(instance: CallableMockInstance): PluginHookResult
  uninstall?(instance: CallableMockInstance): PluginHookResult
  beforeRequest?(context: PluginContext): PluginResult | void | Promise<PluginResult | void>
  process(context: PluginContext, response?: unknown): PluginResult | Promise<PluginResult>
  onError?(error: Error, context: PluginContext): Error | ResponseResult | void | Promise<Error | ResponseResult | void>
  onExchange?(exchange: Exchange): void | Promise<void>
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

`install()` and `uninstall()` return `void | undefined` rather than `void`, so
an `async` hook is a compile error for both. Every synchronous hook still
satisfies the type, annotated or not. An async `uninstall()` used to compile
and was ignored at runtime.

A `process` hook that returns something other than a `PluginResult`, or a
`beforeRequest` hook that returns something other than a `PluginResult` or
nothing, fails with `PluginError` (`PLUGIN_ERROR`) and the message
`Plugin "<name>" failed: didn't return valid result`. `onError` hooks receive
that `PluginError`, and it is not wrapped a second time.

During `reset()`, `uninstall()` runs in reverse order after requests admitted
with that plugin generation have settled. It receives a read-only, expiring
instance: `history`, `called`, `callCount`, `lastRequest`, `getRoutes` and
`getState` work. Route registration, `pipe`, `handle`,
`reset`/`resetHistory`/`resetState`, `on`/`off` and `listen`/`close`/`intercept`
throw `PLUGIN_UNINSTALL_OPERATION_UNSUPPORTED`, and any use after the hook
returns throws `PLUGIN_UNINSTALL_SCOPE_EXPIRED`. Re-piping a plugin object
whose uninstall is still pending (a request was in flight at `reset()`) runs
that uninstall immediately, before the new `install()`.

Plugin lifecycle errors are `SchmockError`s with these codes:

| Code | Thrown when |
|------|-------------|
| `PLUGIN_INVALID` | `pipe()` receives a plugin that could never work |
| `PLUGIN_ASYNC_INSTALL_UNSUPPORTED` | `install()` returns a Promise |
| `PLUGIN_INSTALL_OPERATION_UNSUPPORTED` | the install instance is used for anything but route registration and reads |
| `PLUGIN_INSTALL_SCOPE_EXPIRED` | the install instance is used after `install()` returns |
| `PLUGIN_UNINSTALL_OPERATION_UNSUPPORTED` | the uninstall instance is used for anything but reads |
| `PLUGIN_UNINSTALL_SCOPE_EXPIRED` | the uninstall instance is used after `uninstall()` returns |

Static route data (a non-function generator) and `context.route` are
per-request copies. Editing them in place changes only the current response
and request, never the registered route or later requests. Static data is
copied deeply, but only its arrays and plain objects; Dates, binary values and
class instances are passed by reference. `context.route` is a shallow copy, so
custom route data nested inside it is shared.

`onExchange` observes what a fetch caller finally received. Core calls it once
for each request the mock settled through `mock.intercept()` (answered, failed,
or aborted while the mock was answering), after every adapter hook, in
`.pipe()` order and before the caller's `fetch` settles:

```typescript
type Exchange = AnsweredExchange | FailedExchange | AbortedExchange

interface ExchangeRequest {
  readonly method: string                             // as the client sent it, before beforeRequest
  readonly url: string                                // absolute, without the fragment
  readonly headers: Readonly<Record<string, string>>  // names lowercased
  readonly body?: unknown                             // as the mock read it; absent when none or never read
}

interface ExchangeResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>  // of the Response the client received
  readonly body?: unknown                             // before serialization; absent when none (HEAD, 204)
}

interface AnsweredExchange {
  readonly outcome: 'answered'
  readonly request: ExchangeRequest
  readonly response: ExchangeResponse   // after beforeResponse and errorFormatter
  readonly startTime: number            // performance.now() when the transport received the request
  readonly endTime: number              // performance.now() when the caller's outcome settled
}

interface FailedExchange {
  readonly outcome: 'failed'
  readonly request: ExchangeRequest
  readonly error: unknown               // exactly what the caller's fetch rejected with
  readonly startTime: number
  readonly endTime: number
}

interface AbortedExchange {
  readonly outcome: 'aborted'
  readonly request: ExchangeRequest
  readonly startTime: number
  readonly endTime: number
}
```

An answered exchange includes the 404 for an unrouted request and the 400 for
a malformed JSON body when `passthrough` is `false`. Requests passed on to the
network are not observed, nor are `mock.handle()` calls, nor requests that
reached the mock before the observer was piped or before the last `reset()`.
Each observer gets its own snapshot: the exchange, `request`, `response` and
both header records are frozen, and bodies are copies (`error` keeps its
identity). The return value is ignored and a promise is not awaited. A throw or
rejection is logged under the `PLUGIN` debug category and never reaches the
caller. See [Observing exchanges](./plugins.md#observing-exchanges).

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
| `InvalidHttpMethodError` | `INVALID_HTTP_METHOD` | `{ method }` |
| `InvalidResponseError` | `INVALID_RESPONSE` | `{ reason, ...details }` |
| `PluginError` | `PLUGIN_ERROR` | `{ pluginName, originalError }` |
| `SchemaValidationError` | `SCHEMA_VALIDATION_ERROR` | `{ schemaPath, issue, suggestion }` |
| `SchemaGenerationError` | `SCHEMA_GENERATION_ERROR` | `{ route, originalError, schema }` |
| `ResourceLimitError` | `RESOURCE_LIMIT_ERROR` | `{ resource, limit, actual, path? }` |

When a resource-limit breach has a location, `path` is the schema path
(`$.properties.a.properties.b` for a declared `minItems`,
`$.properties.a.faker` for a faker argument) and the message ends with
` at <path>`:
`Resource limit exceeded for array_max_items: limit=10000, actual=20000 at $.properties.a.properties.b`.

Plugin packages throw a plain `SchmockError` with their own code for invalid
options. `@schmock/devtools` uses `DEVTOOLS_CONFIG_INVALID`, with context
`{ option, received }`; see [DevTools](#devtools-schmockdevtools).

`HttpIngressError`, thrown by `collectBody()`, is the one exception: it extends
plain `Error`, not `SchmockError`. See
[Adapter-author utilities](#adapter-author-utilities).

`ResponseGenerationError` was removed: a failing generator now surfaces as the
same structured 500 (`INTERNAL_ERROR`) as any other unhandled exception, and a
non-`Error` throw keeps its own value in the response body (truncated at 200
characters) instead of being flattened to `Unknown error`.

### Constants

```typescript
HTTP_METHODS          // readonly ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
ROUTE_NOT_FOUND_CODE  // 'ROUTE_NOT_FOUND'
isHttpMethod(s)       // type guard → HttpMethod
toHttpMethod(s)       // normalize → HttpMethod (throws InvalidHttpMethodError on invalid)
toRouteKey(m, path)   // build a RouteKey, supplying the required leading slash
```

`toHttpMethod()` compares case-insensitively and throws `InvalidHttpMethodError`
(`INVALID_HTTP_METHOD`) for any other verb, with the message
`Invalid HTTP method: "<method>"`. It used to throw a plain `Error` with the same
message, so `err instanceof SchmockError` now catches it. With
`passErrorsToNext: false`, the Express adapter now renders a `beforeRequest`
that rewrites the method to an unsupported verb as a 500 with code
`INVALID_HTTP_METHOD` instead of `INTERNAL_ERROR`.

### Response helpers

```typescript
notFound(message?: string | object): [404, object]
badRequest(message?: string | object): [400, object]
unauthorized(message?: string | object): [401, object]
forbidden(message?: string | object): [403, object]
serverError(message?: string | object): [500, object]
created(body: object): [201, object]
noContent(): [204, null]
paginate<T>(items: readonly T[], options?: PaginateOptions): PaginatedResponse<T>

interface PaginateOptions { page?: number; pageSize?: number }
interface PaginatedResponse<T> { data: T[]; page: number; pageSize: number; total: number; totalPages: number }
```

`paginate()` normalizes its options: `page` and `pageSize` must be integers `>= 1`, and any other
value (`0`, negative, fractional, `NaN`, `Infinity`, missing) falls back to page `1` and page size
`10`. The returned envelope echoes the normalized values, so `data`, `page`, `pageSize` and
`totalPages` are always mutually consistent.

`@schmock/angular` re-exports these helpers.

### Adapter-author utilities

`@schmock/core` exports the pieces its own adapters and plugins are built from.
Application code does not need them. The request-admission protocol lives on a
separate entry, [`@schmock/core/adapter`](#schmockcoreadapter).

```typescript
isStatusTuple(v)            // v is [number, unknown] | [number, unknown, unknown]
isBinaryBody(v)             // v is ArrayBuffer | ArrayBufferView
isRouteNotFound(response)   // true for the mock's own route-miss 404
getResponseException(response)  // the Error an exception response was built from, or undefined

// Response results, for plugins
getResponseParts(response: unknown): ResponseParts
replaceResponseBody(response: unknown, body: unknown): unknown

// Path prefixes: the namespace and baseUrl rule
parsePathPrefix(prefix: string): PathPrefix
matchPathPrefix(prefix: PathPrefix, path: string): boolean

// Node ingress, as used by mock.listen() and the CLI
serveNodeRequest(req, res, options: ServeNodeRequestOptions): Promise<void>
parseNodeHeaders(req): Record<string, string>
parseNodeQuery(url: URL): Record<string, string>
collectBody(req, headers, maxBodySize?): Promise<unknown>  // default limit: 10 MiB
writeSchmockResponse(res, response, extraHeaders?): void
writeRejectedSchmockResponse(req, res, response, extraHeaders?): void

// Response shaping
withDefaultContentType(response: Response): Response
buildFormattedErrorResponse(options: FormattedErrorOptions): Response

// Headers
SENSITIVE_HEADER_NAMES: ReadonlySet<string>
redactHeaders(headers: Record<string, string>): Record<string, string>
getHeader(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined

createFetchInterceptor(handle, options?)  // deprecated here: import it from @schmock/core/adapter
```

`isStatusTuple(v)` checks only the length and the status, so its third element
is typed `unknown`. Check that it is a string record before reading it as
headers.

`isRouteNotFound(response)` tells a route miss apart from a 404 a route
returned on purpose. Adapters use it to decide whether to pass a request
through to the real backend.

`parseNodeHeaders()` keeps only string-valued headers. `parseNodeQuery()`
resolves a repeated key to its last value.

`collectBody()` returns the body in the shape the fetch interceptor gives the
same request, or `undefined` for an empty body:

| Content type | Body |
|--------------|------|
| `application/json`, `+json` | the parsed value |
| `application/x-www-form-urlencoded` | a flat object; a repeated key keeps its last value |
| `text/*` | a string |
| `multipart/*` | `FormData` |
| anything else, or none | an `ArrayBuffer` |

It reads `content-type` and `content-length` from `headers` case-insensitively.

It rejects with `HttpIngressError`, which carries `status` and `code`:

| Code | Status | Cause |
|------|--------|-------|
| `MALFORMED_JSON` | 400 | a JSON body that does not parse |
| `JSON_TOO_DEEP` | 400 | a JSON body nested more than 256 levels |
| `MALFORMED_MULTIPART` | 400 | a multipart body that does not parse |
| `PAYLOAD_TOO_LARGE` | 413 | a declared or received size above `maxBodySize` |

`HttpIngressError` extends `Error`, not `SchmockError`, so
`err instanceof SchmockError` does not catch it. `HttpIngressErrorCode` is
exported as a type.

`writeRejectedSchmockResponse()` writes an error response while the client may
still be uploading. It keeps the socket open until the upload ends, goes idle
or runs out of grace time, so the client reads the response instead of a
connection reset.

#### Response parts

```typescript
getResponseParts(response: unknown): ResponseParts
replaceResponseBody(response: unknown, body: unknown): unknown

interface ResponseParts {
  status: number                   // what core answers with; a plain null or undefined is 204
  body: unknown                    // the body element as carried; null stays null
  headers: Record<string, string>  // a copy; {} when the carried headers are not a string record
  kind: 'plain' | 'tuple' | 'object'
}
```

`getResponseParts()` splits a route or plugin result with the guards `handle()`
applies, so a plugin reads what core will deliver. A `[status, body]` or
`[status, body, headers]` tuple is `kind: 'tuple'`. A `{ status, body, headers? }`
object whose `headers` are absent or a string record is `kind: 'object'`.
Anything else, including an object whose `headers` are not a string record, is
`kind: 'plain'`, with the whole value as the body and status 200. A tuple whose
third element is not a string record reads as `headers: {}`, and core rejects
it as `INVALID_RESPONSE`.

`replaceResponseBody()` puts `body` in place of the carried body and keeps the
shape. A tuple keeps its length and headers, an envelope keeps its `status` and
`headers` (other properties are dropped, as core ignores them), and a plain
result is replaced by `body` itself. It never mutates `response`.

```typescript
import { getResponseParts, replaceResponseBody } from '@schmock/core'

const countPlugin: Schmock.Plugin = {
  name: 'count',
  process(context, response) {
    const { status, body } = getResponseParts(response)
    if (status >= 300 || !Array.isArray(body)) return { context, response }
    return {
      context,
      response: replaceResponseBody(response, { count: body.length, items: body }),
    }
  },
}
```

#### Path prefixes

```typescript
parsePathPrefix(prefix: string): PathPrefix
matchPathPrefix(prefix: PathPrefix, path: string): boolean

interface PathPrefix {
  origin: string | null  // the origin of an origin-form prefix, or null for a path prefix
  path: string           // canonical, without a trailing slash; '' for the root
}
```

These are the one prefix rule shared by `namespace`, the fetch interceptor's
`baseUrl` and the Angular adapter's `baseUrl`. `parsePathPrefix()`
canonicalizes the path the way request paths are (`'/café'` and `'/caf%C3%A9'`
are one prefix), adds a missing leading slash and drops one trailing slash. A
value containing `://` that is not a valid URL is read as a path.

| Input | `parsePathPrefix()` |
|-------|---------------------|
| `'/api'`, `'/api/'`, `'api'` | `{ origin: null, path: '/api' }` |
| `'/'`, `''` | `{ origin: null, path: '' }` |
| `'https://x.com/api/v1/'` | `{ origin: 'https://x.com', path: '/api/v1' }` |
| `'https://x.com'` | `{ origin: 'https://x.com', path: '' }` |

`matchPathPrefix()` canonicalizes `path` first, so a raw and an encoded spelling
match alike, and matches on a segment boundary. It compares the path only.
Checking `origin` against the request's origin is the caller's job.

```typescript
import { matchPathPrefix, parsePathPrefix } from '@schmock/core'

const prefix = parsePathPrefix('/api/')
matchPathPrefix(prefix, '/api')        // true
matchPathPrefix(prefix, '/api/users')  // true
matchPathPrefix(prefix, '/apiv2')      // false
```

#### `serveNodeRequest()`

```typescript
serveNodeRequest(req, res, options: ServeNodeRequestOptions): Promise<void>

interface ServeNodeRequestOptions {
  handle: MockRequestHandler  // mock.handle, or a request admission's handle
  maxBodySize?: number        // bytes; a larger body gets 413. Default 10 MiB, as mock.listen()
  answerBeforeBody?: (method: HttpMethod, path: string) => Response | undefined  // answer without reading the body
  extraHeaders?: (context: ServeNodeResponseContext) => Record<string, string> | undefined
  classifyError?: (error: unknown) => HttpErrorReply | undefined
}

interface ServeNodeResponseContext {
  isError: boolean            // true for an error answer serveNodeRequest writes itself
  path: string | undefined    // the request pathname; undefined when the request did not parse
}

interface HttpErrorReply {
  status: number
  code: string
  message: string
  headers?: Record<string, string>  // besides the content type, such as a 405's allow
}
```

`serveNodeRequest()` serves one Node request through a handler. It is the
bridge `mock.listen()` and the CLI run, and it fits any `http.createServer`
callback. `req` and `res` are typed structurally as `NodeRequestLike` and
`NodeResponseLike`, so no Node types appear in its declarations and a request
typed by any `@types/node` copy fits. `maxBodySize` defaults to 10 MiB, the
limit `mock.listen()` uses.

`answerBeforeBody(method, path)` runs after the `Host`, target and method
checks and before the body is read. A `Response` it returns is sent as is,
through `extraHeaders`, and the body is never read; `undefined` reads the body
and calls `handle`. A throw is answered 500 `SERVER_ERROR`. The CLI answers its
admin API and CORS preflights this way, so a stalled or oversized body never
delays or changes a 401.

Error answers are JSON `{ error: message, code }`:

| Status | Code | Cause |
|--------|------|-------|
| 400 | `BAD_REQUEST` | a missing or malformed `Host` header, or a malformed request target |
| 405 | `METHOD_NOT_ALLOWED` | a method outside `HTTP_METHODS`; the answer carries `allow` |
| 400 | `MALFORMED_JSON`, `JSON_TOO_DEEP`, `MALFORMED_MULTIPART` | a body that does not parse |
| 413 | `PAYLOAD_TOO_LARGE` | a body over `maxBodySize` |
| 500 | `SERVER_ERROR` | `handle` rejected; the message is the error's |

A body failure also sends `connection: close`, and a 413 is flushed while the
client may still be uploading. A target starting with `//` is a path, never a
host. `extraHeaders` runs for every answer, success and error, and its headers
replace any case variant of the same name. `classifyError` chooses the answer
for an error; returning `undefined` keeps the default. A client that goes away
aborts the `signal` passed to `handle`.

The returned promise never rejects. It settles once the response is handed to
Node, which is when a request admission can be released.

```typescript
import { createServer } from 'node:http'
import { schmock, serveNodeRequest } from '@schmock/core'

const mock = schmock()
mock('GET /users', [{ id: 1 }])

createServer((req, res) => {
  void serveNodeRequest(req, res, {
    handle: mock.handle,
    maxBodySize: 1024 * 1024,
    extraHeaders: ({ isError }) => (isError ? undefined : { 'x-served-by': 'schmock' }),
  })
}).listen(3000)
```

#### Response shaping

```typescript
withDefaultContentType(response: Response): Response
buildFormattedErrorResponse(options: FormattedErrorOptions): Response

interface FormattedErrorOptions {
  formatter: (error: Error) => unknown       // the errorFormatter; called exactly once
  error: Error
  inheritedHeaders?: Record<string, string>  // headers of the response being replaced
  method: string                             // a HEAD answer carries no body
}
```

`withDefaultContentType()` adds the content type a body implies when the
response has no `content-type` header, in any letter case:
`application/octet-stream` for a binary
body, and `application/json` for any other non-string body, `null` included. A
string or `undefined` body gets none. It never throws, never mutates its
argument and does not normalize the result.

`buildFormattedErrorResponse()` runs an `errorFormatter` and returns the
normalized 500 that carries its result, with `content-type: application/json`
and the inherited headers minus their content type. When the inherited headers
cannot be sent (a non-string value, a control character, a case-duplicate
name), it keeps the formatted body and sends only the JSON content type. When
the formatter throws or its result cannot be serialized, it sends
`{ error: 'Internal Server Error', code: 'INTERNAL_ERROR' }`. It never throws.

```typescript
import { buildFormattedErrorResponse } from '@schmock/core'

const response = buildFormattedErrorResponse({
  formatter: (error) => ({ message: error.message }),
  error: new Error('boom'),
  inheritedHeaders: { 'Retry-After': '5', 'Content-Type': 'text/plain' },
  method: 'GET',
})
// { status: 500, body: { message: 'boom' },
//   headers: { 'Retry-After': '5', 'content-type': 'application/json' } }
```

#### Header helpers

```typescript
SENSITIVE_HEADER_NAMES: ReadonlySet<string>
redactHeaders(headers: Record<string, string>): Record<string, string>
getHeader(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined
```

`SENSITIVE_HEADER_NAMES` holds the seven credential headers, in lowercase:
`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`,
`x-auth-token` and `x-schmock-admin-token`. Debug logs and the CLI's admin
history mask this set. `redactHeaders()` replaces their values with
`"[redacted]"`, matching names case-insensitively. It is copy-on-write: the
input is never mutated, and when nothing is sensitive the same object comes
back. `getHeader()` looks a header up case-insensitively and returns the first
match, or `undefined`.

```typescript
import { getHeader, redactHeaders } from '@schmock/core'

const headers = { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }
redactHeaders(headers)              // { Authorization: '[redacted]', 'Content-Type': 'text/plain' }
getHeader(headers, 'content-type')  // 'text/plain'
```

### `@schmock/core/adapter`

The low-level protocol for adapter authors: the pieces `mock.intercept()`, the
Express adapter and the CLI are built on. Application code uses
`mock.handle()`, `mock.listen()` and `mock.intercept()` instead.

```typescript
acquireRequestAdmission(mock: CallableMockInstance): RequestAdmission | undefined
awaitWithAbort<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T>
abortReason(signal: AbortSignal): unknown
createFetchInterceptor(
  handle: MockRequestHandler,
  options?: InterceptOptions,
  admitRequest?: () => RequestAdmission,
): InterceptHandle

type MockRequestHandler = (method: HttpMethod, path: string, options?: RequestOptions) => Promise<Response>

interface RequestAdmission {
  handle: MockRequestHandler  // call at most once
  release(): void             // call exactly once, after the request settles
  hasRoute?(method: HttpMethod, path: string): boolean  // exact route probe; absent on a hand-written admission
}
```

The entry also re-exports the `InterceptOptions`, `InterceptHandle` and
`CallableMockInstance` types, so it compiles when imported alone.

`hasRoute(method, path)` answers whether `handle` would match a route for that
method and path, against the same route table the admission pinned. A `false`
answer must be exact, because the fetch interceptor uses it to skip reading a
passthrough request's body; any other answer, or a throw, counts as a match.
Admissions from `schmock()` always carry it. An admission passed to
`createFetchInterceptor` without it has every request body read, and its
responses are normalized like a mock's own: hop-by-hop headers are dropped and
a HEAD body is stripped.
`RequestAdmission` and `MockRequestHandler` are also on the ambient `Schmock`
namespace.

`acquireRequestAdmission(mock)` pins one request to the mock's routes, plugins
and state as they are on arrival. Route it with `admission.handle`, then call
`admission.release()` once it settles, so a `mock.reset()` issued meanwhile
neither changes what the request sees nor uninstalls its plugins underneath it.
It returns `undefined` for a value that is not a `schmock()` instance, such as
a hand-written stub; route that through `mock.handle`. It throws `SchmockError`
`INVALID_REQUEST_ADMISSION` when the mock's admission factory returns something
else.

`awaitWithAbort(value, signal)` settles with `value`, or rejects with the
signal's abort reason as soon as it aborts. An already-aborted signal gives a
rejected promise rather than a synchronous throw. `abortReason(signal)` is the
signal's `reason`, or a generic `AbortError` on runtimes whose signals predate
`reason`.

`createFetchInterceptor(handle, options?, admitRequest?)` is the lease
`mock.intercept()` holds. Pass `admitRequest` to admit each fetch against the
mock on arrival.

```typescript
import { schmock } from '@schmock/core'
import { acquireRequestAdmission } from '@schmock/core/adapter'

const mock = schmock()
mock('GET /users', [{ id: 1 }])

async function serve(path: string): Promise<Schmock.Response> {
  const admission = acquireRequestAdmission(mock)
  if (!admission) return mock.handle('GET', path)
  try {
    return await admission.handle('GET', path)
  } finally {
    admission.release()
  }
}
```

### Deprecations

Each of these is planned for removal in the next major version.

| Deprecated | Use instead |
|------------|-------------|
| `createFetchInterceptor` from `@schmock/core` | `mock.intercept()`. Adapter authors import `createFetchInterceptor` from `@schmock/core/adapter`; the root export is the same function. |
| `ExpressAdapterOptions` from `@schmock/core` | `ExpressAdapterOptions` from `@schmock/express` |
| `AngularAdapterOptions` from `@schmock/core` | `AngularAdapterOptions` from `@schmock/angular` |

### Named types

These types are exported by name from `@schmock/core`. All but the last row are
also on the ambient `Schmock` namespace.

| Type | Describes |
|------|-----------|
| `PaginateOptions`, `PaginatedResponse<T>` | `paginate()`'s options and result |
| `SchmockEvent`, `SchmockEventMap` | the event names, and each event's payload, for `on()`/`off()` |
| `RequestStartEvent`, `RequestMatchEvent`, `RequestNotFoundEvent`, `RequestEndEvent` | one lifecycle event payload each |
| `OpenApiRefPolicy` | `OpenApiOptions.refs` |
| `OnSchemaCallback`, `OnSchemaContext` | `OpenApiOptions.onSchema` and its context |
| `ResponseParts`, `PathPrefix`, `FormattedErrorOptions` | the utility types above |
| `ServeNodeRequestOptions`, `ServeNodeResponseContext`, `HttpErrorReply`, `HttpIngressErrorCode` | `serveNodeRequest()` and `collectBody()` |
| `NodeRequestLike`, `NodeResponseLike` | the structural `req` and `res` `serveNodeRequest()` accepts |
| `Exchange`, `AnsweredExchange`, `FailedExchange`, `AbortedExchange`, `ExchangeRequest`, `ExchangeResponse` | what `Plugin.onExchange` receives (see [Plugin Interface](#plugin-interface)) |
| `PluginHookResult` | what `install()` and `uninstall()` may return: anything but a thenable |

---

## Faker Plugin (`@schmock/faker`)

### `fakerPlugin(options)`

Generate data from JSON schemas using faker.js.

```typescript
function fakerPlugin(options: FakerPluginOptions): Plugin

interface FakerPluginOptions {
  schema: Schmock.Schema            // draft-07 plus Schmock's keywords (see Schema extensions)
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
  schema: Schmock.Schema
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

### Override paths

A dotted key such as `'address.city'` sets a nested value. It enters an array
only by a canonical, in-range index: `'addresses.0.city': 'Paris'` edits the
first item alone, and the nested form `{ addresses: { 0: { city: 'Paris' } } }`
does the same. A path the generated value cannot hold is ignored:

- a non-index segment on an array (`addresses.city`)
- an out-of-range or non-canonical index (`addresses.5`, `addresses.01`)
- a segment below a generated primitive (`name.first` when `name` is a string)

A missing or `null` intermediate value is created as an object.

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
| `created_at`, `updated_at` | ISO-8601 UTC date-time |
| `birthday`, `dob`, `start_date`, `due_date`, `timestamp` | ISO-8601 UTC date-time |
| `username`, `login`, `nickname` | Username |
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

Every date mapping (`createdAt`, `updatedAt`, `deletedAt`, `publishedAt`,
`expiresAt`, `timestamp`/`ts`, `birthday`/`dob`/`birthdate`/`born`,
`startDate`/`beginDate`, `endDate`/`dueDate`/`deadline`) emits an ISO-8601 UTC
date-time string such as `"1990-05-12T08:31:44.000Z"`. A birthday is a
date-time too, not a `YYYY-MM-DD` date. The output does not depend on the
machine time zone, so seeded output is the same on every machine.

A primitive array item inherits the singular form of its property name when
that singular form maps: `emails: { type: 'array', items: { type: 'string' } }`
generates email addresses. Explicit keywords on the item still win.

#### Precedence

Explicit schema keywords always win over field-name heuristics. A property
that declares `default`, `const`, `enum`, `pattern`, `faker` or `$ref` is never
re-mapped by its name. Neither is one with a `format` the generator can
produce: `date-time`, `date`, `time`, `duration`, `email`, `idn-email`,
`hostname`, `idn-hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `iri`,
`iri-reference`, `json-pointer`, `relative-json-pointer`, `uuid` or `byte`. The
OpenAPI normalizer turns `example` into `default`, so an OpenAPI example also
wins. A declared `schmockTrueProbability` is never overwritten by the name
weighting: `active: { type: 'boolean', schmockTrueProbability: 0.1 }` is 10%
true, not 90%.

#### Matching rules

A keyword shorter than 5 characters matches inside a field name only when it
lines up with token edges (camelCase, snake_case or kebab-case), with an
optional plural `s` or `es`. `urls` maps to a URL, but `latency`, `population`
and `namespace` do not map to a latitude or a person's name.

A field whose last token is `type`, `status`, `format`, `code` or `kind` only
matches a mapping that names it exactly or ends with that token. `phoneType`,
`emailStatus` and `cityCode` get no phone number, email or city; `countryCode`
and `zipCode` still map through their own keywords.

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

Native nullability gets the same ~5% null roll without the marker:
`type: [T, 'null']`, or a two-branch `anyOf`/`oneOf` with a bare
`{ type: 'null' }` branch in either order. Set `schmockNullable: false` on a
node to opt out; json-schema-faker then picks between the union's types as
written.

Both extensions apply wherever the value is generated. Boolean weighting, from
`schmockTrueProbability` or from a field name such as `isDeleted`, also applies
inside `allOf`/`anyOf`/`oneOf` branches, `$ref` targets and
`additionalProperties` values. The null roll also applies through `$ref`,
`allOf`, `additionalProperties`/`patternProperties`, and the single
`anyOf`/`oneOf` branch a value matches.

`faker`, `schmockNullable` and `schmockTrueProbability` are Schmock's own
keywords and are not part of `JSONSchema7`. `fakerPlugin` and
`generateFromSchema` take a `Schmock.Schema` — draft-07 plus these three
keywords, applied recursively to nested subschemas — so a schema literal written
inline in their options may use them. A schema kept in a variable, for example
to share it with `validationPlugin`, still needs the `Schmock.Schema`
annotation; a `Schmock.Schema` can be passed wherever a `JSONSchema7` is
accepted:

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
rejects keywords it does not know. `@schmock/validation` registers all three
(`faker`, `schmockNullable` and `schmockTrueProbability`) as annotation-only
vocabulary on its own instance, so one schema can serve both `fakerPlugin` and
`validationPlugin`. To validate such a schema with your own AJV instance,
register them the same way:
`ajv.addVocabulary(['faker', 'schmockNullable', 'schmockTrueProbability'])`.

### Schema support

- `format: 'byte'` strings are valid padded base64, so they pass `ajv-formats`
  under `validateResponses`.
- `patternProperties` generate at least one key matching a pattern, and enough
  keys to reach `minProperties` without passing `maxProperties`.
- A lone `minimum`/`exclusiveMinimum` of 1000 or more, or a lone
  `maximum`/`exclusiveMaximum` of -1000 or less, generates in range.
- Union `type` arrays are checked member by member, and
  `type: ['array', 'null']` needs `items` like `type: 'array'`.
- The json-schema-faker `chance` keyword is not supported. It is rejected with
  `SCHEMA_VALIDATION_ERROR` at `<path>.chance`; use `faker` instead.
- A faker method string that resolves to an `Object.prototype` member
  (`person.toString`) or to a `_`-prefixed member is rejected.
- A map keyword (`properties`, `patternProperties`, `definitions`, `$defs`,
  `dependencies`, `dependentSchemas`) given as an array is walked by index, so
  a bad child there is rejected at its index path, such as
  `$.definitions.0.faker`.
- `unevaluatedProperties` and `unevaluatedItems` are stripped before
  generation. They are neither validated nor generated.

### Generation limits

Every limit is checked when the plugin is created, and again on the generated
value where the schema alone cannot decide. A breach throws
`ResourceLimitError` with the `resource` below. The exported constants come
from `@schmock/faker`.

| `resource` | Constant | Bound |
|------------|----------|-------|
| `array_size`, `array_max_items` | `MAX_ARRAY_SIZE` | 10,000 items |
| `schema_nesting_depth` | `MAX_NESTING_DEPTH` | 15 levels |
| `schema_nodes` | `MAX_SCHEMA_NODES` | 50,000 distinct schema nodes |
| `generated_nodes` | `MAX_GENERATED_NODES` | 1,000,000 generated JSON nodes |
| `object_properties` | `MAX_OBJECT_PROPERTIES` | 10,000 properties per object |
| `string_length` | `MAX_STRING_LENGTH` | 65,536 UTF-16 code units per string |
| `generated_chars` | not exported | 16,777,216 UTF-16 code units per response |
| `schema_composition_depth` | not exported | 200 composition frames |

`generated_chars` counts every string and object key in one response. At
creation it is checked against the least the schema can produce: each
`minLength` multiplied by its array counts. Nested arrays are bounded by
`generated_nodes`; there is no separate memory estimate.

Faker arguments that set a size are held to the string limit:

| Methods | Largest count |
|---------|---------------|
| `lorem.words`, `lorem.sentence`, `lorem.slug`, `word.words` (`count`) | 32,768 words |
| `lorem.sentences`, `lorem.lines`, `lorem.paragraph` | 9,362 sentences |
| `lorem.paragraphs` | 3,120 paragraphs |

`helpers.fake` placeholders are checked like direct calls. The expanded
`helpers.mustache` output and the explicit upper quantifier in
`helpers.fromRegExp` must fit in 65,536 characters, and a schema `pattern`
whose shortest match is longer than that is rejected at creation.

Limits inside `not`, `if` and unreferenced `$defs`/`definitions` do not reject a
schema, because nothing is generated from them. `then`/`else` and definitions
reached through `$ref` still count.

The limits are constants, not options. To generate less for one request,
return a trimmed schema from the `@schmock/openapi` `onSchema` callback.

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
    statuses?: '2xx' | readonly number[]  // default: every status
  }
  requestErrorStatus?: number    // default: 400
  responseErrorStatus?: number   // default: 500
}
```

`ValidationPluginOptions` and `ValidationRules` are exported from
`@schmock/validation` for typing shared configuration objects.

Request rules run before the route generator. Set `bodyRequired: true` when an
absent body must be rejected; supplied bodies are always validated.

Query and header values always arrive as strings, so their schemas coerce
scalar types: `'2'` satisfies `type: 'integer'`, `'25'` satisfies
`type: 'number'` with `maximum: 50`, and `'true'` satisfies `type: 'boolean'`.
A value coerced to a number must be a finite number in plain decimal notation:
an optional leading `-`, digits, an optional fraction, such as `-3`, `2.5` or
`007`. `Infinity`, `1e400`, exponents (`1e1`), hex, binary and octal literals
(`0x10`, `0b11`, `0o7`), a leading `+` or `.`, and padded values (`' 7 '`) are
rejected with the slot's validation error, so numeric range keywords such as
`minimum`/`maximum` hold for every accepted query and header value.
Coercion happens on a copy: the route and later plugins still receive the
original strings in `context.query`. Request and response bodies keep strict
typing, so `'3'` does not satisfy `type: 'integer'` in `request.body`.

Header schemas may spell names in any case (`'X-Api-Key'`). Incoming header
names are matched case-insensitively against every name declared in
`properties`, `required` and `dependencies` by the header schema itself, by its
`allOf`/`anyOf`/`oneOf`/`if`/`then`/`else`/`not` and schema-form `dependencies`
subschemas, and by the `$ref` targets those reach. Names inside property
schemas, and in `definitions`/`$defs` that no `$ref` reaches, are ignored. Two
names that differ only by case (`'X-Api-Key'` and `'x-api-key'`, or a property
`'x-api-key'` with `required: ['X-Api-Key']`) throw `SchmockError`
`VALIDATION_CONFIG_INVALID` with `context.option` `'request.headers'` at
creation time. Headers the schema names this way reach `patternProperties` and
`propertyNames` in the schema's own spelling (`X-Api-Key`); every other header
arrives lowercased. Write those patterns to match both, for example `^[Xx]-`
or `^[A-Za-z0-9-]+$`.

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
envelope. Validation reads the status and body through core's
`getResponseParts()`, so its envelope rule is core's by construction. An
envelope whose `headers` is present but is not a record of
strings is not a valid envelope: core delivers the whole object as the body,
and validation applies the schema to that same whole object — which normally
fails and returns `RESPONSE_VALIDATION_ERROR`.

`response.statuses` chooses which responses `response.body` applies to:

| `statuses` | Validated |
|------------|-----------|
| omitted | every response on every route, including error tuples and envelopes such as `[404, {...}]` and request rejections from other plugins (a guard's 401, openapi's 400/406/415) |
| `'2xx'` | statuses 200–299 |
| `[200, 201]` | only the listed statuses |

The status is read from `tuple[0]` or `envelope.status`. Any other bare body
counts as 200, and a bare `null` or `undefined` counts as 204. With the
default, a non-conforming error body becomes a 500 `RESPONSE_VALIDATION_ERROR`.
Scope the schema to successes, or keep the default and widen the schema with
`anyOf: [successSchema, { type: 'object', required: ['error'] }]`:

```typescript
validationPlugin({ response: { body: userSchema, statuses: '2xx' } })
```

An empty array, a non-integer, a value outside 100–599, or a string other than
`'2xx'` throws `VALIDATION_CONFIG_INVALID` with `context.option`
`'response.statuses'` at creation time. The list is copied when the plugin is
created.

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
parameter names must be non-empty strings, `allowed` must be an array of
field names that excludes `__proto__`, `constructor` and `prototype`,
`sorting.default` must be a non-empty string listed in `sorting.allowed`, and
`sorting.defaultOrder` must be exactly `'asc'` or `'desc'`. The error's
`context.option` names the offending option, such as `'sorting.default'`. A
`pagination.defaultLimit` above `maxLimit` (or above the default `maxLimit` of
100) is clamped to `maxLimit`, not rejected.

Only successful array responses are transformed. A tuple or envelope with a
status of 400 or more, whether a route's own error or another plugin's
`beforeRequest` rejection, passes through untouched. 2xx and 3xx arrays,
including a 2xx list served by a `beforeRequest` hook, are filtered, sorted and
paginated.

Query parameters:

| Feature | Format | Example |
|---------|--------|---------|
| Pagination | `?page=N&limit=N` | `?page=2&limit=10` |
| Sorting | `?sort=field&order=asc\|desc` | `?sort=name&order=desc` |
| Filtering | `?filter[field]=value` or `?filter.field=value` | `?filter[role]=admin` |

`page` and `limit` must be exact positive integers (`"2"`); anything else —
padded, signed, fractional, exponent notation or partially numeric — falls
back to the default rather than being coerced. The `order` value is matched
case-insensitively: `order=DESC` and `order=Desc` sort descending.

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

#### Pipeline order

- Pipe `queryPlugin` after whatever produces the array body: `fakerPlugin`,
  `openapi`, or a route generator. Piped before faker, it sees an undefined
  body and passes it through without paginating.
- A response validator piped after `queryPlugin` must describe the
  `PaginatedResult` envelope `{ data, pagination }`, not the raw array. One
  piped before it validates the raw array, and the envelope goes unvalidated.
- For the same list across page requests, give `fakerPlugin` a `seed` or back
  the list with state. Unseeded faker generates a different list on every
  request.

See [Ordering the built-in plugins](./plugins.md#ordering-the-built-in-plugins).

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
  maxBytes?: number        // default: 1_000_000, counted on the decoded body
}

type SeedConfig = Record<string, SeedSource>
type SeedSource = unknown[] | string | { count: number }

type OnSchemaCallback = (schema: JSONSchema7, context: OnSchemaContext) => JSONSchema7 | undefined

interface OnSchemaContext {
  method: string
  path: string
  params: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
}

interface ResourceOverride {
  listWrapProperty?: string       // property holding items (e.g. "data")
  listFlat?: boolean              // force flat array response
  errorSchema?: JSONSchema7       // custom error response format
}
```

An empty or omitted `allowedHosts` means any host, still minus loopback,
link-local, private and reserved addresses. That block applies to every
address a host resolves to, including hosts you list. `maxBytes` is enforced
while the body streams, counting decoded bytes. Only http(s) redirect targets
are followed, and each hop is checked against the policy again.

Callbacks are disabled by default and never issue implicit network requests.
The legacy `queryFeatures` option is unsupported and throws
`OPENAPI_UNSUPPORTED_OPTION` when supplied.

Invalid `seed` and `resources` options throw `SchmockError` when the plugin is
created, and so does a `spec` that is neither a path string nor a document
object (`OPENAPI_INVALID_SPEC`, context `{ spec: undefined }`):

| Code | Cause | Context |
|------|-------|---------|
| `OPENAPI_UNKNOWN_SEED_RESOURCE` | a `seed` key names no detected CRUD resource | `{ key, resources }` |
| `OPENAPI_UNKNOWN_RESOURCE_OVERRIDE` | a `resources` key names no detected CRUD resource | `{ key, resources }` |
| `OPENAPI_INVALID_OPTION` | `seed` is not an object, or an entry is not an array, a file path or `{ count }` | `{ option: 'seed', resource? }` |
| `OPENAPI_INVALID_OPTION` | while loading: a seed file that is not valid JSON or not a JSON array, a `{ count }` that is not a non-negative integer, or a `{ count }` for a resource with no schema | `{ option: 'seed', resource, file? }` |

The loading failures are thrown after the key and shape checks. `file` is set
for the two seed-file cases. They were plain `Error`s before; the messages are
unchanged.

`@schmock/openapi` exports these types by name, each an alias of the
`@schmock/core` ambient type: `OpenApiOptions`, `OpenApiRefPolicy`,
`ResourceOverride`, `CrudOperationMeta`, `OnSchemaCallback`, `OnSchemaContext`,
`OpenApiCallbackOptions`, `OpenApiCallbackRequest`, `SeedConfig` and
`SeedSource`.

Supports Swagger 2.0, OpenAPI 3.0, and OpenAPI 3.1.

See the [OpenAPI guide](./openapi.md) for detailed usage.

---

## React Adapter (`@schmock/react`)

```typescript
function SchmockProvider(props: SchmockProviderProps): ReactElement
function useSchmock(): CallableMockInstance

interface SchmockProviderProps {
  mock: CallableMockInstance
  options?: InterceptOptions   // passed to mock.intercept()
  children: ReactNode
}
```

`SchmockContext` is exported for custom hooks. `@schmock/react/testing`
exports `renderWithSchmock()`. The provider holds one `mock.intercept()` lease
for as long as it is mounted.

See the [React guide](./react.md) for detailed usage.

---

## Vue Adapter (`@schmock/vue`)

```typescript
const schmockPlugin: Plugin<SchmockPluginOptions>
function useSchmock(): CallableMockInstance
function restoreSchmockInterception(app: App): void

interface SchmockPluginOptions {
  mock: CallableMockInstance
  interceptOptions?: InterceptOptions   // passed to mock.intercept()
  options?: InterceptOptions            // alias of interceptOptions, as React names it
}
```

`options` is an alias of `interceptOptions`, the name React's `SchmockProvider`
uses. When both are given, `interceptOptions` wins.

In a browser, `app.use(schmockPlugin, { mock })` takes one `mock.intercept()`
lease for the app and releases it when the app unmounts or fails to mount.
Without a DOM it provides the mock but does not patch `fetch`.
`restoreSchmockInterception(app)` releases the lease early and is safe to call
for an app that never intercepted.

See the [Vue guide](./vue.md) for detailed usage.

---

## DevTools (`@schmock/devtools`)

### `devtoolsPlugin(options?)`

Report each request a mock answers through `mock.intercept()` to Chrome
DevTools: one collapsed console group and one Performance-panel track entry.

```typescript
function devtoolsPlugin(options?: DevtoolsPluginOptions): Plugin

interface DevtoolsPluginOptions {
  console?: boolean      // default: true
  performance?: boolean  // default: true
  track?: string         // track name and console badge; default: 'Schmock'
  trackGroup?: string    // Performance-panel track group; default: none
}
```

`DevtoolsPluginOptions` is exported from `@schmock/devtools`. The returned
plugin is named `devtools`. It has an identity `process` and an `onExchange`
hook, so it never changes a response. Options are validated and copied when the
plugin is created. Invalid ones throw `SchmockError` `DEVTOOLS_CONFIG_INVALID`
with context `{ option, received }`, naming the first failure in this order:
`options` must be an object, `console` and `performance` booleans, `track` and
`trackGroup` non-empty strings.

The Performance track needs Chrome 128 or later, a recording, and Capture
settings → **Show custom tracks**.

See the [DevTools guide](./devtools.md) for detailed usage.

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

Create interceptor from an OpenAPI spec. Node and test runners only:
`@schmock/openapi` is loaded through a runtime-computed specifier that bundlers
do not include, so a bundled browser app uses `mock.pipe(await openapi({ spec }))`
with `provideSchmockInterceptor(mock)` instead (see the
[Angular guide](./angular.md#openapi-driven-interceptor)). A missing or
malformed peer rejects with `SchmockError` `OPENAPI_PEER_UNAVAILABLE`.

```typescript
async function createSchmockInterceptorFromSpec(
  openapiOptions: OpenApiOptions,
  adapterOptions?: AngularAdapterOptions,
): Promise<new () => HttpInterceptor>
```

### `provideSchmockInterceptorFromSpec(openapiOptions, adapterOptions?)`

Create provider from an OpenAPI spec. Same `useFactory` shape, awaited, and the
same Node-only loading and `OPENAPI_PEER_UNAVAILABLE` rejection as
`createSchmockInterceptorFromSpec`.

```typescript
async function provideSchmockInterceptorFromSpec(
  openapiOptions: OpenApiOptions,
  adapterOptions?: AngularAdapterOptions,
): Promise<{ provide: InjectionToken; useFactory: () => HttpInterceptor; multi: true }>
```

```typescript
interface AngularAdapterOptions {
  baseUrl?: string              // intercept only this prefix (segment boundary) and strip it before routing
  passthrough?: boolean         // pass unmatched requests to real backend (default: true)
  errorFormatter?: (error: Error, request: HttpRequest<any>) => any
  transformRequest?: (request: HttpRequest<any>) => {
    method?: string; path?: string; headers?: Record<string, string>; body?: any; query?: Record<string, string>
  }
  transformResponse?: (response: Schmock.Response, request: HttpRequest<any>) => Schmock.Response
  beforeRequest?: (request: HttpRequest<unknown>) =>
    | Schmock.AdapterRequestOverride | void | Promise<Schmock.AdapterRequestOverride | undefined>
  beforeResponse?: (response: Schmock.Response, request: HttpRequest<unknown>) =>
    | Schmock.Response | void | Promise<Schmock.Response | undefined>
}
```

`baseUrl` intercepts only requests whose path starts with the prefix on a
segment boundary, and strips the prefix before routing: with `baseUrl: '/api'`,
a request to `/api/users` matches a route registered as `GET /users`. The
prefix is matched with [`matchPathPrefix()`](#path-prefixes), as in the fetch
interceptor: `'/café'` and `'/caf%C3%A9'` are the same prefix, `'api'` is
`'/api'`, and one trailing slash is ignored. The stripped remainder keeps the
request's spelling.

`beforeRequest` and `beforeResponse` are `transformRequest` and
`transformResponse` under the names the other adapters use. They may be async,
and returning nothing leaves the request or response unchanged. When both names
of a hook are set, `transformRequest` or `transformResponse` is used.

### Helper functions

`@schmock/angular` re-exports the core response helpers (`notFound`,
`badRequest`, `unauthorized`, `forbidden`, `serverError`, `created`,
`noContent`, `paginate`). See [Response helpers](#response-helpers).

See the [Angular guide](./angular.md) for detailed usage.

---

## CLI (`@schmock/cli`)

### `createCliServer(options)`

Start a mock server programmatically.

```typescript
async function createCliServer(options: CliOptions): Promise<CliServer>

// @schmock/cli exports `type CliOptions = Schmock.CliOptions`, with these fields
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

`CliOptions` is a type alias of the ambient `Schmock.CliOptions`, so it is not
open to declaration merging; augment `Schmock.CliOptions` instead. `CliServer`
is the CLI's own type, with the exact `node:http` `Server`.

`hostname` must be a non-blank string. `createCliServer({ hostname: '' })`
rejects instead of starting: an empty host binds every interface rather than
the documented `127.0.0.1` default.

Configuration errors are `SchmockError` with code `INVALID_CONFIG`. A blank
`hostname` carries context `{ option: 'hostname', value }`, and an unusable
`adminToken` carries `{ option: 'adminToken' }`, without the credential.

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

A flag value the CLI refuses, a second positional argument, and
`--admin-token` without `--admin` throw `SchmockError` with code
`INVALID_CONFIG` and context `{ flag, value }`. `--admin-token` errors carry
`{ flag }` only, and the extra-positional error carries `{ flag: '<spec>' }`.
An unknown flag throws Node's own `parseArgs` error.

### `run(args)`

Entry point for the CLI binary. Parses args, starts server, handles SIGINT/SIGTERM.

```typescript
async function run(args: string[]): Promise<void>
```

The returned promise settles when the server has shut down, not when it has
started: on `--help` or a missing `--spec` it resolves immediately, otherwise
it stays pending until `SIGINT`/`SIGTERM` arrives and the close completes (and
rejects if that close fails). Both signal handlers stay attached until the
close settles, so a repeat signal is acknowledged instead of killing the drain;
a signal that arrives after `shutdownGraceMs` has passed forces an exit. The
handlers are then removed, so a host process that calls `run` repeatedly does
not accumulate them.

### `loadSeedFile(path)`

Read and check a `--seed` manifest, returning the `seed` option for
`openapi()`.

```typescript
function loadSeedFile(seedPath: string): SeedConfig
```

File entries resolve relative to the manifest and may not leave its directory.
A manifest that is not a JSON object, an entry of an unrecognized shape, a
missing file and an entry that escapes the directory throw `SchmockError`
`OPENAPI_INVALID_OPTION` with context `{ option: 'seed', resource? }`, the code
`openapi()` raises for the same mistakes in its `seed` option. An oversized
manifest throws `ResourceLimitError`. See
[Manifest rules](./cli.md#manifest-rules).

See the [CLI guide](./cli.md) for detailed usage.
