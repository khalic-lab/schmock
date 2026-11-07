# Angular Adapter

Intercept Angular HTTP calls with Schmock. Unmatched requests pass through to the real backend.

```sh
bun install @schmock/angular
```

## Basic Usage

```typescript
import { schmock } from '@schmock/core'
import { provideSchmockInterceptor } from '@schmock/angular'
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http'

const mock = schmock()
mock('GET /users', [{ id: 1, name: 'Alice' }])
mock('POST /users', ({ body }) => {
  // The request body is typed `unknown`, so narrow it before spreading.
  const input = typeof body === 'object' && body !== null ? body : {}
  return [201, { id: 2, ...input }]
})

export const appConfig = {
  providers: [
    provideHttpClient(withInterceptorsFromDi()),
    provideSchmockInterceptor(mock, { baseUrl: '/api' }),
  ],
}
```

Your Angular services call the API normally — Schmock intercepts matching requests:

```typescript
@Injectable({ providedIn: 'root' })
export class UserService {
  constructor(private http: HttpClient) {}

  getUsers() {
    return this.http.get<User[]>('/api/users')
  }

  createUser(user: Partial<User>) {
    return this.http.post<User>('/api/users', user)
  }
}
```

## Options

```typescript
provideSchmockInterceptor(mock, {
  baseUrl: '/api',           // only intercept requests starting with this URL
  passthrough: true,         // pass unmatched requests to the real backend (default: true)

  transformRequest: (request) => ({
    headers: { 'x-tenant': 'dev' },
  }),

  transformResponse: (response, request) => ({
    ...response,
    headers: { ...response.headers, 'x-mock': 'true' },
  }),

  errorFormatter: (error, request) => ({
    message: error.message,
  }),
})
```

### `passthrough`

When `true` (default), requests that don't match any Schmock route are forwarded to the real backend. Set to `false` to return errors for unmatched requests — useful in tests to catch unexpected API calls.

### `baseUrl`

Only intercept requests whose path starts with this prefix, on a segment
boundary. The prefix is stripped before matching:

```typescript
// With baseUrl: '/api'
// Request to /api/users → Schmock matches route /users
provideSchmockInterceptor(mock, { baseUrl: '/api' })
```

The prefix is matched the way the fetch interceptor matches it:

- canonically, so `'/café'` and `'/caf%C3%A9'` are the same prefix, and a
  non-ASCII base also matches an absolute request URL, whose path Angular
  percent-encodes;
- with a leading slash implied: `'api'` is `'/api'` and strips `/api/users` to
  `/users`;
- ignoring one trailing slash: `'/api/'` is `'/api'`.

The stripped remainder keeps the spelling the request used.

`baseUrl` and a mock's `namespace` do not compose. With
`schmock({ namespace: '/api' })` and `baseUrl: '/api'`, the adapter strips
`/api` and the namespace then requires it again, so every request misses
(a 404 with `passthrough: false`). For a namespaced mock, leave `baseUrl`
unset: the namespace already maps `/api/users` to the route `GET /users`, as
it does under `mock.intercept()`, `mock.listen()`, Express and the CLI. That
makes `namespace` the portable choice for a mock shared with those transports,
such as the DevTools setup below.

### `transformRequest`

Rewrite the request before Schmock matches it. Return any subset of
`{ method, path, headers, body, query }`. `headers` and `query` are merged onto
the request's own, so `{ headers: { 'x-tenant': 'dev' } }` adds one header and
keeps the rest (`authorization` included); `method`, `path` and `body`
replace. Header names — both the request's own and any the override supplies —
are lowercased before reaching handlers, so `{ 'X-Tenant': 'dev' }` arrives as
`headers['x-tenant']`, and an override header replaces the request's header of
that name whatever its case. Because of the merge, an override cannot remove a
header or a query key the request carries. To simulate an unauthenticated
call, send the request without `authorization` instead.

`transformRequest` runs per subscription, inside the interceptor's error
boundary: if it throws, the subscriber receives a 500 `HttpErrorResponse`
shaped by `errorFormatter` rather than a bare `Error`.

### `beforeRequest` and `beforeResponse`

The same two hooks under the names the fetch interceptor, React, Vue and
Express use. Unlike `transformRequest` and `transformResponse`, they may be
async, and returning nothing leaves the request or response unchanged:

```typescript
provideSchmockInterceptor(mock, {
  beforeRequest: async (request) => {
    if (!request.headers.has('authorization')) return
    return { headers: { 'x-user': 'dev' } }
  },
  beforeResponse: (response) => ({
    ...response,
    headers: { ...response.headers, 'x-mock': 'true' },
  }),
})
```

When both names of a hook are set, `transformRequest` or `transformResponse`
is used. The deprecated `AngularAdapterOptions` copy on `@schmock/core` lists
the same `beforeRequest`/`beforeResponse` aliases. `beforeRequest` receives Angular's `HttpRequest`, not the
`AdapterRequest` a fetch-interceptor hook gets, so a React or Vue hook that
spreads its argument (`{ ...request, headers }`) does not port verbatim: return
only the fields to override. A `transformRequest` or `transformResponse` that
returns a promise is awaited as well, but only the `before*` hooks are typed
for it.

## OpenAPI-Driven Interceptor

Skip manual route definitions — load everything from a spec. In an app, pipe
the OpenAPI plugin into a mock before bootstrapping, and provide the
interceptor for that mock:

```typescript
// main.ts
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http'
import { bootstrapApplication } from '@angular/platform-browser'
import { schmock } from '@schmock/core'
import { openapi } from '@schmock/openapi'
import { provideSchmockInterceptor } from '@schmock/angular'
import { AppComponent } from './app/app.component'

const mock = schmock({ state: {} })

fetch('/assets/api.json')
  .then((res) => res.json())
  .then((spec: object) => openapi({ spec, seed: { users: { count: 10 } } }))
  .then((plugin) => {
    mock.pipe(plugin)
    return bootstrapApplication(AppComponent, {
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideSchmockInterceptor(mock, { baseUrl: '/api' }),
      ],
    })
  })
  .catch((err) => console.error(err))
```

Your bundler resolves the `@schmock/openapi` import like any other, and picks
its browser build through the `browser` export condition. Pass the spec as an
object, fetched or imported as JSON: in the browser a file path or URL throws
`OPENAPI_NODE_ONLY` (see
[Running in a browser](./openapi.md#running-in-a-browser)).

### The `FromSpec` helpers

`provideSchmockInterceptorFromSpec` and `createSchmockInterceptorFromSpec`
build that mock for you. Hand them your own `openapi` import as the third
argument and they work wherever that import does, a bundled app included:

```typescript
import { openapi } from '@schmock/openapi'
import { provideSchmockInterceptorFromSpec } from '@schmock/angular'

const provider = await provideSchmockInterceptorFromSpec(
  { spec, seed: { users: { count: 10 } } },
  { baseUrl: '/api' },
  { openapi },
)
```

Without it they load `@schmock/openapi` through a specifier computed at
runtime, which is for Node and test runners only. A bundler leaves that import
in place, so in a bundled browser app (`ng build`, Karma or another browser
test runner) they reject with `SchmockError` code `OPENAPI_PEER_UNAVAILABLE`
even when the package is installed. Under a Node test runner they work, and
a spec file path is read from disk, but only when the runner loads the Node
build of `@schmock/openapi`, as Vitest's default `node` environment does. A
runner that resolves the `browser` export condition loads the browser build,
where a file path throws `OPENAPI_NODE_ONLY`: Jest's jsdom environment sets
that condition by default, and a DOM environment that bundles or transforms
the adapter can pick it too. There, pass the spec imported as JSON and the
`{ openapi }` argument, as [the testing guide](./testing.md#openapi-driven-angular-tests)
shows. Under Vitest's `node` environment:

```typescript
import { provideSchmockInterceptorFromSpec } from '@schmock/angular'

beforeEach(async () => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptorsFromDi()),
      await provideSchmockInterceptorFromSpec(
        { spec: './src/assets/api.json', seed: { users: { count: 10 } } },
        { baseUrl: '/api' },
      ),
    ],
  })
})
```

Or with `createSchmockInterceptorFromSpec` for class-based setup:

```typescript
import { createSchmockInterceptorFromSpec } from '@schmock/angular'

const InterceptorClass = await createSchmockInterceptorFromSpec(
  { spec: './src/assets/api.json' },
  { baseUrl: '/api' },
)

providers: [
  // useFactory (not useClass): the interceptor class is generated at runtime,
  // so AOT apps without @angular/compiler can't DI-compile it. Manual `new`
  // avoids that — the class has no injected constructor deps.
  { provide: HTTP_INTERCEPTORS, useFactory: () => new InterceptorClass(), multi: true },
]
```

The computed specifier is also why an app that does not install
`@schmock/openapi` still bundles cleanly with `ng build` and esbuild. When the
peer cannot be loaded, or does not export an `openapi()` factory, the helpers
reject with `OPENAPI_PEER_UNAVAILABLE` and the import failure in
`context.cause`. Webpack-based builders may print a harmless
`Critical dependency: the request of a dependency is an expression` warning.

### Cookie API keys

The interceptor never sees the browser's cookie jar: the browser attaches its
cookies to the request on the wire, and the interceptor answers before
anything reaches the wire. So with `security: true`, an operation secured only
by a cookie API key answers 401 even when the browser holds the cookie. A
`Cookie` header set on the `HttpRequest` itself is a different matter: the
interceptor, and so the mock, does see it, although the browser would drop it
before a real server could. Add the cookie in `beforeRequest`; only its
presence is checked (see
[Security Validation](./openapi.md#security-validation)):

```typescript
provideSchmockInterceptor(mock, {
  baseUrl: '/api',
  beforeRequest: () => ({ headers: { cookie: 'session_key=present' } }),
})
```

## Chrome DevTools

`@schmock/devtools` reports the requests a mock answers through
`mock.intercept()`. `provideSchmockInterceptor` answers through `mock.handle()`
inside Angular's interceptor chain instead, so its requests are not reported.
To see them in the console and the Performance panel, switch `HttpClient` to
the fetch backend and intercept `fetch`:

```typescript
import { provideHttpClient, withFetch } from '@angular/common/http'
import { schmock } from '@schmock/core'
import { devtoolsPlugin } from '@schmock/devtools'

const mock = schmock()
mock.pipe(devtoolsPlugin())
mock('GET /api/users', [{ id: 1, name: 'Alice' }])
mock.intercept({ baseUrl: '/api' })

export const appConfig = {
  providers: [provideHttpClient(withFetch())],
}
```

`withFetch()` sends every request through `globalThis.fetch`, which
`mock.intercept()` patches. From Angular 22 the fetch backend is the default
and `withFetch()` is deprecated, so `provideHttpClient()` alone does the same;
keep `withFetch()` on Angular 21 and earlier. Leave `provideSchmockInterceptor`
out of the providers: it would answer first, and nothing would be reported.

What changes on this path:

- `mock.intercept()`'s `baseUrl` filters requests but does not strip the
  prefix, so routes use the full path: `GET /api/users`, not `GET /users`. To
  keep route keys without the prefix on both paths, give the mock
  `namespace: '/api'` and leave the Angular adapter's `baseUrl` unset.
- `transformRequest` and `transformResponse` do not apply. Use the
  [`intercept()` options](./api.md#interceptoptions-at) `beforeRequest`,
  `beforeResponse` and `errorFormatter`, whose hooks receive an
  `AdapterRequest` rather than Angular's `HttpRequest`.
- With `passthrough: false`, an unrouted request gets
  `{ error: 'No matching mock route found', code: 'ROUTE_NOT_FOUND' }` instead
  of `{ message: 'No matching mock route found' }`.

See the [DevTools guide](./devtools.md).

### Network panel relay

The service-worker relay lists mocked requests in the Network panel itself. It
routes requests to `mock.intercept()` leases, so it needs the lease setup
above: with `provideSchmockInterceptor`, the request is answered inside
Angular and never reaches the worker. Copy the worker script once into the
directory your app serves at the site root, then start the relay before
bootstrapping:

```sh
npx @schmock/devtools init public
```

```typescript
import { bootstrapApplication } from '@angular/platform-browser'
import { startServiceWorkerRelay } from '@schmock/devtools'
import { AppComponent } from './app/app.component'

startServiceWorkerRelay()
  .then(() => bootstrapApplication(AppComponent, appConfig))
  .catch((err) => console.error(err))
```

Under the relay, an XHR backend (Angular 21 and earlier without
`withFetch()`) is relayed too, so the fetch backend is not strictly needed
there. Use it anyway: if the relay falls back, `fetch` is still mocked in the
page and XHR is not mocked at all. Mocked
requests show as Network rows with Size `(ServiceWorker)`. See
[Network panel relay](./devtools.md#network-panel-relay).

## Helper Functions

Utility functions for building responses:

```typescript
import { notFound, badRequest, unauthorized, forbidden, serverError, created, noContent, paginate } from '@schmock/angular'

// State and request bodies are typed `unknown`, so narrow them before use.
type User = { id: number; name: string }
const isUsers = (value: unknown): value is User[] => Array.isArray(value)

mock('GET /users/:id', ({ params, state }) => {
  const users = isUsers(state.users) ? state.users : []
  const user = users.find((u) => u.id === Number(params.id))
  return user || notFound('User not found')
})

mock('POST /users', ({ body }) => {
  if (typeof body !== 'object' || body === null || !('name' in body)) {
    return badRequest('name is required')
  }
  return created({ id: 3, ...body })
})

mock('DELETE /users/:id', () => noContent())

mock('GET /admin', () => forbidden('Admin access only'))
```

### `paginate(items, options?)`

Paginate an array:

```typescript
mock('GET /users', () => {
  return paginate(allUsers, { page: 1, pageSize: 10 })
})
// → { data: [...], page: 1, pageSize: 10, total: 50, totalPages: 5 }
```

## Testing with TestBed

```typescript
import { TestBed } from '@angular/core/testing'
import { HttpClient, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http'
import { HTTP_INTERCEPTORS } from '@angular/common/http'
import { schmock } from '@schmock/core'
import { createSchmockInterceptor } from '@schmock/angular'

describe('UserService', () => {
  let http: HttpClient
  let mock: Schmock.CallableMockInstance

  beforeEach(() => {
    mock = schmock()
    mock('GET /api/users', [{ id: 1, name: 'Alice' }])

    const SchmockInterceptor = createSchmockInterceptor(mock)

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        {
          provide: HTTP_INTERCEPTORS,
          useFactory: () => new SchmockInterceptor(),
          multi: true,
        },
      ],
    })

    http = TestBed.inject(HttpClient)
  })

  it('fetches users', (done) => {
    http.get<any[]>('/api/users').subscribe({
      next: (users) => {
        expect(users).toHaveLength(1)
        done()
      },
    })
  })

  it('handles errors', (done) => {
    mock('GET /api/error', () => [500, { message: 'Server error' }])

    http.get('/api/error').subscribe({
      error: (err) => {
        expect(err.status).toBe(500)
        done()
      },
    })
  })
})
```

## Response Behavior

- A request the mock answers first emits `{ type: HttpEventType.Sent }`, as
  every Angular backend does, so `observe: 'events'` sees `Sent` before the
  response or error. It arrives once the route's `delay` has run, not when
  the request is handed to the mock. A request handed to the mock that fails
  there (a rejected `handle()`) also emits `Sent` before its error, but a
  request hook that throws fails the request before dispatch, so that error
  comes without `Sent`. A passthrough request gets its events from the real
  backend instead. No progress events are emitted, even with
  `reportProgress`: a mocked body never crosses the wire
- Final 2xx status → Emitted as an Angular `HttpResponse`
- 3xx through 5xx status → Emitted through `error` as an `HttpErrorResponse`
- HEAD, 204, 205, and 304 → Body removed before Angular conversion. 204 emits
  `null`; HEAD, 205, and 304 emit the empty value of the requested
  `responseType` (see below)
- ROUTE_NOT_FOUND + `passthrough: true` → Request forwarded to the real backend
- ROUTE_NOT_FOUND + `passthrough: false` → 404 `HttpErrorResponse`
- Request header names are lowercased before reaching handlers, so a handler
  always reads `headers.authorization` however the caller spelled it. A header
  the caller set more than once arrives as all of its values joined with `, `
  in Angular's order, not as the first value alone
- Handlers receive the request as Angular's backends send it, although an
  interceptor runs before them: the `Accept` header
  (`application/json, text/plain, */*`) and the detected `Content-Type` the
  backends add when the caller set none are added (`multipart/form-data` for a
  `FormData` body, which the browser labels itself; no boundary is invented,
  since the body arrives as the `FormData`), and the body is serialized
  with `HttpRequest.serializeBody()`, then decoded by its content type as
  `mock.listen()` and the fetch interceptor decode it, with the same table and
  JSON parser from `@schmock/core/adapter`. JSON is parsed, a urlencoded form
  (an `HttpParams` body included) becomes a flat object, `text/*` a string,
  `FormData` and a `multipart/form-data`-labelled string or `Blob` arrive as
  `FormData`, and anything else is an `ArrayBuffer`, including a string or
  `Blob` labelled with another multipart subtype (`multipart/mixed`,
  `multipart/related`), which arrives as the bytes sent. A `FormData` body
  arrives as the `FormData` whatever `Content-Type` the caller set. The urlencoded object
  keeps the last value of a repeated name, and the whole form arrives beside
  it as [`form`](./api.md#request-context), every field included, unless a
  `transformRequest` or `beforeRequest` hook replaced the body, which drops
  `form`. A bodyless request has no
  body (`undefined`, not `null`). A JSON-labelled body that does not parse, or
  nests deeper than 256 levels, is refused as `mock.listen()` refuses it: with
  `passthrough: false` the request gets a 400 `HttpErrorResponse` whose body is
  `{ error, code }` with code `MALFORMED_JSON` or `JSON_TOO_DEEP`, after `Sent`
  and before any hook or route runs; with `passthrough: true` its text is
  routed instead, as the fetch interceptor routes it. A
  `multipart/form-data` body the platform cannot parse (a missing boundary)
  fails the request with a 500.
  With `passthrough: true` and no `transformRequest` or `beforeRequest` hook,
  a request no route answers is passed to the real backend without its body
  being read, so such a body only fails a request the mock would answer.
  Angular labels a `URLSearchParams` body `application/json`, as its backends
  do, so a strict interceptor refuses it like any JSON body that does not
  parse; set `Content-Type: application/x-www-form-urlencoded` to receive its
  fields
- Bodies are shaped to the request's `responseType`: `text` yields a string,
  `arraybuffer` an `ArrayBuffer`, `blob` a `Blob`. `json` passes the value
  through untouched — a route returning a pre-serialized string stays a string,
  so `'true'` and `'{"a":1}'` arrive as strings. The one exception is a string
  under a JSON content type (`application/json` or `+json`) that is a JSON
  string literal, quotes included: it is decoded, as `HttpClient` decodes it
  from a real backend. That is what a route returning a `Date` (or any value
  whose `toJSON()` yields a string) produces, since core sends it as JSON text,
  so such a route gives Angular code the ISO string
- A body that never reaches the wire — `[200, null]`, a HEAD request, or a 205
  or 304 — emits the *empty* value of that type: `''`, an empty `ArrayBuffer`,
  an empty `Blob` labelled from the response's content type (`json` emits
  `null`). This matches `HttpXhrBackend`, which nulls the body only at 204, so
  `res.trim()` behaves the same against the mock as against a real backend. On
  the error channel `HttpErrorResponse` maps a falsy body to `null`, so an
  empty `text` error body arrives as `null` there — again as it does in Angular
- Emitted `HttpResponse` and `HttpErrorResponse` report `request.urlWithParams`,
  so serialized `HttpParams` appear on `.url`
- The query is read from the URL string first, then from `HttpParams`, the
  order Angular writes them into `urlWithParams`. A repeated key resolves to its
  last value, as in the other adapters and the CLI
- A URL fragment is dropped before routing, as Angular's backends never send
  it: `/api/users#top` is routed as `/api/users`, and `?a=1#top` gives `a` the
  value `1`
- Dot segments are resolved before `baseUrl` is matched and routing begins, as
  the browser resolves them before it sends the request:
  `/api/v1/../users` is routed as `/api/users`, `%2e%2e` included. In a
  relative URL the rest of the path keeps the spelling the request used; an
  absolute URL is read with `new URL()`, as before
- A protocol-relative URL (`//api.example.com/users`) names a host, as the
  browser reads it: it is resolved against the page (`document.baseURI`, then
  `location.href`), so it is routed as `/users` and matches an origin-form
  `baseUrl` of `https://api.example.com` on an https page

`errorFormatter` formats core-marked internal exceptions and thrown handling
errors. It does not reinterpret an ordinary route response such as
`[500, { error: 'domain failure' }]`. Exception provenance is captured before
`transformResponse` runs, so a hook that clones the response with
`{ ...response }` does not suppress the formatter.

Formatter output for a core-marked 500 is normalized like any other response.
A HEAD request gets no body, and `Date` values arrive as ISO strings. The
`HttpErrorResponse` carries `content-type: application/json` and keeps the
route's other headers. Output that cannot be serialized, such as an embedded
`Error` or an `undefined`-valued property, falls back to
`{ error: 'Internal Server Error', code: 'INTERNAL_ERROR' }`; `undefined` is
rejected, not dropped, so write
`code: error instanceof SchmockError ? error.code : null` or spread the
property conditionally. The out-of-band path, a throwing hook, is formatted the
same way. There a thrown value that is not an `Error` reaches the formatter
wrapped in one, with the value as its `cause`. Without a formatter, or when it
throws, the body is the one `mock.handle()` answers a failure with: the
failure's message and its code when it is a `SchmockError`, otherwise
`INTERNAL_ERROR`.

Unsubscribing aborts pending Schmock work and unsubscribes any unmatched
passthrough request. No response is emitted after teardown. Once the mock has
emitted its response the request's `signal` stays live, as on every other
transport, so work a route or an OpenAPI callbacks dispatcher started without
awaiting it is not cancelled when the Observable completes.

Each request is admitted against the mock's routes and plugins as they are
when it is intercepted, as `mock.listen()`, Express and the fetch interceptor
admit theirs: a `mock.reset()` while its body is decoded or a request hook
runs neither changes the routes it sees nor uninstalls its plugins before it
settles. A request passed to the real backend is released before it goes.
