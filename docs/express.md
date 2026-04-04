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

### `errorFormatter`

Custom error response format:

```typescript
toExpress(mock, {
  errorFormatter: (error) => ({
    error: { message: error.message, code: error.code },
  }),
})
```

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
