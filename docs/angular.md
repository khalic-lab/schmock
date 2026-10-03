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
mock('POST /users', ({ body }) => [201, { id: 2, ...body }])

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

### `transformRequest`

Rewrite the request before Schmock matches it. Header names — both the
request's own and any the override supplies — are lowercased before reaching
handlers, so `{ 'X-Tenant': 'dev' }` arrives as `headers['x-tenant']`.

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

Skip manual route definitions — load everything from a spec. In the browser,
pass the spec as an object: a file path or URL throws `OPENAPI_NODE_ONLY` (see
[Running in a browser](./openapi.md#running-in-a-browser)).

```typescript
import { provideSchmockInterceptorFromSpec } from '@schmock/angular'

const spec: object = await fetch('/assets/api.json').then((res) => res.json())

export const appConfig = {
  providers: [
    provideHttpClient(withInterceptorsFromDi()),
    await provideSchmockInterceptorFromSpec(
      { spec, seed: { users: { count: 10 } } },
      { baseUrl: '/api' },
    ),
  ],
}
```

Or with `createSchmockInterceptorFromSpec` for class-based setup:

```typescript
import { createSchmockInterceptorFromSpec } from '@schmock/angular'

const InterceptorClass = await createSchmockInterceptorFromSpec(
  { spec: await fetch('/assets/api.json').then((res) => res.json()) },
  { baseUrl: '/api' },
)

providers: [
  // useFactory (not useClass): the interceptor class is generated at runtime,
  // so AOT apps without @angular/compiler can't DI-compile it. Manual `new`
  // avoids that — the class has no injected constructor deps.
  { provide: HTTP_INTERCEPTORS, useFactory: () => new InterceptorClass(), multi: true },
]
```

The spec helpers load `@schmock/openapi` through a specifier computed at
runtime, so an app that does not install it still bundles cleanly with
`ng build` and esbuild. When the peer is missing, or does not export an
`openapi()` factory, they reject with `SchmockError` code
`OPENAPI_PEER_UNAVAILABLE` and the import failure in `context.cause`.
Webpack-based builders may print a harmless
`Critical dependency: the request of a dependency is an expression` warning.

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
`mock.intercept()` patches. Leave `provideSchmockInterceptor` out of the
providers: it would answer first, and nothing would be reported.

What changes on this path:

- `mock.intercept()`'s `baseUrl` filters requests but does not strip the
  prefix, so routes use the full path: `GET /api/users`, not `GET /users`.
- `transformRequest` and `transformResponse` do not apply. Use the
  [`intercept()` options](./api.md#interceptoptions) `beforeRequest`,
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
npx schmock-devtools init public
```

```typescript
import { bootstrapApplication } from '@angular/platform-browser'
import { startServiceWorkerRelay } from '@schmock/devtools'
import { AppComponent } from './app/app.component'

startServiceWorkerRelay()
  .then(() => bootstrapApplication(AppComponent, appConfig))
  .catch((err) => console.error(err))
```

Under the relay, Angular's default XHR backend is relayed too, so
`withFetch()` is not strictly needed there. Keep it: if the relay falls back,
`fetch` is still mocked in the page and XHR is not mocked at all. Mocked
requests show as Network rows with Size `(ServiceWorker)`. See
[Network panel relay](./devtools.md#network-panel-relay).

## Helper Functions

Utility functions for building responses:

```typescript
import { notFound, badRequest, unauthorized, forbidden, serverError, created, noContent, paginate } from '@schmock/angular'

mock('GET /users/:id', ({ params }) => {
  const user = users.find(u => u.id === Number(params.id))
  return user || notFound('User not found')
})

mock('POST /users', ({ body }) => {
  if (!body?.name) return badRequest('name is required')
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
- Bodies are shaped to the request's `responseType`: `text` yields a string,
  `arraybuffer` an `ArrayBuffer`, `blob` a `Blob`. `json` passes the value
  through untouched — a route returning a pre-serialized string stays a string
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
rejected, not dropped, so write `code: error.code ?? null` or spread the
property conditionally. The out-of-band path, a throwing hook, is formatted the
same way.

Unsubscribing aborts pending Schmock work and unsubscribes any unmatched
passthrough request. No response is emitted after teardown.
