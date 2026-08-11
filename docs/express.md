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
mock('POST /users', ({ body }) => [201, { id: 2, ...body }])

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
  passErrorsToNext: true,     // pass non-Schmock errors to Express error handler (default: true)

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

Modify request data before Schmock processes it. Return an object with any subset of `{ method, path, headers, body, query }`:

```typescript
toExpress(mock, {
  beforeRequest: (req) => ({
    // Add tenant header from URL
    headers: { 'x-tenant': req.params.tenant },
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
toExpress(mock, {
  errorFormatter: (error) => ({
    error: { message: error.message, code: error.code },
  }),
})
```

The formatter receives core-marked internal exceptions and errors thrown by
adapter hooks or request handling before the Express response is committed. It
does not reinterpret an ordinary user-defined 500 route response.

Exception provenance is captured before `beforeResponse` runs, so a hook that
clones the response with `{ ...response }` does not suppress the formatter.
The formatted response keeps the (post-hook) response headers — `retry-after`
and friends survive — with `content-type` forced to `application/json`. A
post-hook header that cannot be transported (a non-string value, a control
character in the value, or a case-duplicate name) is dropped rather than
discarding the formatted body. If
`beforeResponse` rewrites an exception to a non-500 status, that response is
sent as-is and the formatter is not called.

## Response Behavior

- Final statuses must be integers from 200 through 599.
- HEAD, 204, 205, and 304 responses are sent without a body.
- Ordinary response framing headers are adapter-owned. HEAD may retain an
  explicit representation `Content-Length`, and 304 headers are preserved.
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
