# Express Adapter

Use Schmock as Express middleware. Unmatched routes pass through to the next middleware.

```sh
bun install @schmock/express
```

## Basic Usage

```typescript
import express from 'express'
import { schmock } from '@schmock/core'
import { toExpress } from '@schmock/express'

const app = express()
const mock = schmock()

mock('GET /users', [{ id: 1, name: 'Alice' }])
mock('POST /users', ({ body }) => {
  // The request body is typed `unknown`, so narrow it before spreading.
  const input = typeof body === 'object' && body !== null ? body : {}
  return [201, { id: 2, ...input }]
})

app.use(express.json())
app.use('/api', toExpress(mock))
app.listen(3000)
```

Routes not matched by Schmock automatically call `next()`, so you can stack Schmock middleware with real route handlers:

```typescript
app.use('/api', toExpress(mock))    // mock handles /api/users
app.get('/api/health', (req, res) => res.json({ ok: true }))  // real handler
```

## Options

```typescript
toExpress(mock, {
  passErrorsToNext: true,     // pass errors (SchmockError included) to Express's error handler when no errorFormatter is set (default: true)

  beforeRequest: (req, res) => ({
    headers: { 'x-request-id': req.get('x-request-id') || 'none' },
  }),

  beforeResponse: (response, req, res) => ({
    ...response,
    headers: { ...response.headers, 'x-powered-by': 'schmock' },
  }),

  errorFormatter: (error, req) => ({
    message: error.message,
    timestamp: new Date().toISOString(),
  }),

  transformHeaders: (headers) => { /* custom header normalization */ },
  transformQuery: (query) => { /* custom query normalization */ },
})
```

### `beforeRequest`

Modify request data before Schmock processes it. Return an object with any subset of `{ method, path, headers, body, query }`.
`headers` and `query` are merged onto the request's own, so returning one
header adds it and keeps the rest (`authorization` included); a header the
override names replaces the request's header of that name in any case.
An override header whose value is `undefined` is skipped, so the request's
header of that name, if any, is kept.
`method`, `path` and `body` replace the request's. Because of the merge, an
override cannot remove a header or a query key; to drop one (`authorization`,
say, to simulate an unauthenticated call), use `transformHeaders` or
`transformQuery`, which build the records the override is merged onto. This
differs from the fetch
interceptor's `beforeRequest` (React, Vue), which receives the request record
and returns the whole request.
A rewrite to a method Schmock does not route (`PURGE`, `PROPFIND`) is a miss,
like an incoming one: the request goes to `next()`, as the fetch interceptor
and the Angular adapter pass it on.

```typescript
toExpress(mock, {
  beforeRequest: (req) => ({
    // Add a tenant header from the subdomain; the client's headers are kept
    headers: { 'x-tenant': req.hostname.split('.')[0] },
  }),
})
```

### `beforeResponse`

Transform the Schmock response before sending to the client:

```typescript
toExpress(mock, {
  beforeResponse: (response) => ({
    ...response,
    headers: {
      ...response.headers,
      'cache-control': 'no-cache',
    },
  }),
})
```

### Hook-owned responses

A hook that sends — or begins sending — the response and returns normally owns
it. Once `res.headersSent` or `res.writableEnded` is true, the middleware stops:
it does not call the mock, does not run `errorFormatter`, and does not fall
through to `next()`.

```typescript
toExpress(mock, {
  beforeRequest: (req, res) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: 'unauthorized' })
      return // the mock never runs for this request
    }
  },
})
```

A hook that returns normally while owning the response is responsible for
ending it; the middleware will not end it on the hook's behalf. A throw changes
the ownership rule. If the response is already committed, the middleware never
runs `errorFormatter` or writes another body. With `passErrorsToNext: true`, it
immediately forwards the original error to Express error middleware. With
`passErrorsToNext: false`, it immediately ends the response without appending a
body if the response is still open.

### `errorFormatter`

Custom internal-error response format:

```typescript
import { SchmockError } from '@schmock/core'

toExpress(mock, {
  errorFormatter: (error) => ({
    error: {
      message: error.message,
      code: error instanceof SchmockError ? error.code : null,
    },
  }),
})
```

An `undefined`-valued property in the formatted body is rejected, not dropped:
the whole body falls back to `{ error: 'Internal Server Error', code:
'INTERNAL_ERROR' }`. A plain `Error` has no `code`, hence the `null`.

The formatter receives core-marked internal exceptions and errors thrown by
adapter hooks or request handling before the Express response is committed. It
does not reinterpret an ordinary user-defined 500 route response. A thrown
value that is not an `Error` arrives wrapped in one, with the value as its
`cause`. Without a formatter, and with `passErrorsToNext: false`, the 500 body
is the one `mock.handle()` answers: the failure's message (a thrown string as
is, a plain object as its JSON text) and its code when it is a `SchmockError`,
otherwise `INTERNAL_ERROR`.

Exception provenance is captured before `beforeResponse` runs, so a hook that
clones the response with `{ ...response }` does not suppress the formatter.
The formatted response keeps the (post-hook) response headers — `retry-after`
and friends survive — with `content-type` forced to `application/json`. If any
post-hook header cannot be transported (a non-string value, a control
character in the value, or a case-duplicate name), the formatted body is kept
but every inherited header is dropped, `retry-after` included: the 500 carries
only `content-type: application/json`. If
`beforeResponse` rewrites an exception to a non-500 status, that response is
sent as-is and the formatter is not called.

### Query parameters

By default the adapter re-reads the query string of `req.url`, the same URL
`req.path` comes from, with the same parser as the CLI, so the mock sees the
same query whatever `app.set('query parser', ...)` is. A URL rewrite by earlier
middleware moves path and query together, and a router mount keeps the query.
Keys stay literal (`filter[name]`, `sort[]`), and a repeated key resolves to
its last value. Express 4's default `qs` "extended" parser therefore no longer
turns `filter[name]=rex` into `[object Object]`. The default ignores a
`req.query` that earlier middleware assigned or redefined (coercion or
sanitizer middleware, for example). Pass `transformQuery` to receive `req.query`
as Express, or that middleware, left it; its return value replaces the default.

### Routed path

The mock routes the path of `req.url` (the URL `req.path` comes from, so a
mount point or an earlier rewrite still applies) with its dot segments
resolved, as `mock.listen()` and the CLI route it: `/a/../pets` is routed as
`/pets`, `/a/%2e%2e/pets` too, and `/pets/..` as `/`. Express's own `req.path`
keeps them raw under Node, so the sibling Express routes of the same app still
match the raw path. Under Bun, `node:http` resolves them before Express runs.
Under a mount, the dot segments are resolved with the mount path in front: with
`app.use('/api', toExpress(mock))`, `/api/a/../pets` is routed as `/pets`, while
`/api/../pets` resolves to `/pets` outside the mount, so the mock does not
answer it and the request goes to `next()` (under Bun it never reaches the
mount).

## Response Behavior

- Final statuses must be integers from 200 through 599.
- HEAD, 204, 205, and 304 responses are sent without a body.
- Ordinary response framing headers are adapter-owned. HEAD may retain an
  explicit representation `Content-Length`, and 304 headers are preserved.
- Route headers are sent verbatim. A route's `content-type: application/json`
  is not rewritten to `application/json; charset=utf-8`.
- A body that declares no content type gets the one it implies:
  `application/octet-stream` for binary and `application/json` for any other
  non-string body. A `null` body, from `beforeResponse` for example, is sent as
  `null` with `application/json`, as `mock.listen()` and the CLI send it. It
  used to get no content type.
- A mock whose request-admission factory returns something that is not an
  admission fails with `SchmockError` `INVALID_REQUEST_ADMISSION` (message
  `Schmock returned an invalid request admission`). With
  `passErrorsToNext: false` and no `errorFormatter`, the 500 body carries that
  code instead of `INTERNAL_ERROR`, and with `passErrorsToNext: true`, `next()`
  receives the `SchmockError`.
- If the client disconnects, pending adapter-hook awaits settle early and core
  plugins, delays, and route generators receive an aborted signal. Adapter
  hooks do not receive the signal directly, and no response is written.

## OpenAPI with Express

Serve an OpenAPI spec as Express middleware:

```typescript
import { openapi } from '@schmock/openapi'

const mock = schmock({ state: {} })
mock.pipe(await openapi({
  spec: './api.yaml',
  seed: { users: { count: 10 } },
  security: true,
}))

app.use('/api', toExpress(mock))
```

## Development Proxy Pattern

Use Schmock for routes that aren't built yet, pass through to the real backend for everything else:

```typescript
import { createProxyMiddleware } from 'http-proxy-middleware'

const mock = schmock({ state: {} })
mock.pipe(await openapi({ spec: './api.yaml' }))

// Schmock handles mocked routes, proxy handles the rest
app.use('/api', toExpress(mock))
app.use('/api', createProxyMiddleware({ target: 'http://localhost:8080' }))
```
