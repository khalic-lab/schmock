# Getting Started

## Installation

```sh
bun install @schmock/core
```

Optional packages:

```sh
bun install @schmock/react      # React Provider + hook
bun install @schmock/vue        # Vue 3 Plugin + composable
bun install @schmock/express    # Express middleware adapter
bun install @schmock/angular    # Angular HTTP interceptor
bun install @schmock/openapi    # Auto-mock from OpenAPI specs
bun install @schmock/faker      # Schema-based data generation
bun install @schmock/validation # Request/response validation
bun install @schmock/query      # Pagination, sorting, filtering
bun install @schmock/cli        # Standalone CLI server
```

## Core Concepts

### 1. Create a mock instance

```typescript
import { schmock } from '@schmock/core'

const mock = schmock()
```

With options:

```typescript
const mock = schmock({
  namespace: '/api/v1',           // prefix all routes
  state: { users: [], counter: 0 }, // shared mutable state
  delay: 100,                     // simulate latency (ms)
  debug: true,                    // log request lifecycle
})
```

### 2. Define routes

Routes are defined by calling the instance directly:

```typescript
mock('GET /health', { status: 'ok' })
```

The first argument is a `RouteKey` in the format `METHOD /path`. The second is a **generator** — it can be:

**Static data** — returned as-is:

```typescript
mock('GET /config', { version: '2.0', env: 'staging' })
```

**Generator function** — called on each request:

```typescript
mock('GET /users/:id', ({ params, state }) => {
  const user = state.users.find(u => u.id === Number(params.id))
  return user || [404, { error: 'Not found' }]
})
```

**Tuple responses** — control status codes and headers:

```typescript
mock('POST /users', ({ body, state }) => {
  const user = { id: ++state.counter, ...body }
  state.users.push(user)
  return [201, user, { 'x-created-id': String(user.id) }]
})
```

### 3. Handle requests

```typescript
const res = await mock.handle('GET', '/health')
// → { status: 200, body: { status: 'ok' }, headers: { 'content-type': 'application/json' } }

const res = await mock.handle('POST', '/users', {
  body: { name: 'Alice' },
  headers: { authorization: 'Bearer token' },
  query: { notify: 'true' },
})
```

`handle()` never throws — errors become response objects with appropriate status codes.

### 4. Use plugins

Plugins add behavior through a linear pipeline:

```typescript
import { validationPlugin } from '@schmock/validation'

mock('POST /users', handler)
  .pipe(validationPlugin({
    request: {
      body: {
        type: 'object',
        required: ['name', 'email'],
        properties: {
          name: { type: 'string', minLength: 1 },
          email: { type: 'string', format: 'email' },
        },
      },
    },
  }))
```

Plugins execute in `.pipe()` order. The first plugin to set a response becomes the generator; later plugins can transform it.

## State Management

State is shared across all routes and persists between requests:

```typescript
const mock = schmock({ state: { users: [], nextId: 1 } })

mock('POST /users', ({ body, state }) => {
  const user = { id: state.nextId++, ...body }
  state.users.push(user)
  return [201, user]
})

mock('GET /users', ({ state }) => state.users)

mock('DELETE /users/:id', ({ params, state }) => {
  const idx = state.users.findIndex(u => u.id === Number(params.id))
  if (idx === -1) return [404, { error: 'Not found' }]
  state.users.splice(idx, 1)
  return [204, null]
})
```

Reset state without clearing routes:

```typescript
mock.resetState()   // reset state to initial config values
mock.resetHistory() // clear request history only
mock.reset()        // full reset: routes, state, history, plugins, stop server
```

## Request Spying

Every request is recorded for assertions:

```typescript
await mock.handle('POST', '/users', { body: { name: 'Alice' } })
await mock.handle('POST', '/users', { body: { name: 'Bob' } })

mock.called()                   // true (any request was made)
mock.called('POST', '/users')   // true
mock.callCount('POST', '/users') // 2

const last = mock.lastRequest('POST', '/users')
// { method: 'POST', path: '/users', body: { name: 'Bob' }, timestamp: ..., response: { status: 201, body: ... } }

const all = mock.history('POST', '/users')
// Array of all POST /users request records
```

## Lifecycle Events

Subscribe to request lifecycle events:

```typescript
mock.on('request:start', ({ method, path }) => {
  console.log(`→ ${method} ${path}`)
})

mock.on('request:end', ({ method, path, status, duration }) => {
  console.log(`← ${method} ${path} ${status} (${duration}ms)`)
})

mock.on('request:notfound', ({ method, path }) => {
  console.warn(`No route for ${method} ${path}`)
})
```

## Route Introspection

```typescript
const routes = mock.getRoutes()
// [{ method: 'GET', path: '/users', hasParams: false },
//  { method: 'GET', path: '/users/:id', hasParams: true }]
```

## Standalone HTTP Server

Run any mock as a real HTTP server:

```typescript
const info = await mock.listen(3000)
// Listening on http://127.0.0.1:3000

// Use port 0 for a random available port (great for tests)
const info = await mock.listen(0)
console.log(`Running on port ${info.port}`)

// Stop the server
mock.close()
```

## Next Steps

- [OpenAPI Auto-Mocking](./openapi.md) — the fastest way to get a realistic mock API
- [Testing Patterns](./testing.md) — real-world testing workflows
- [React Adapter](./react.md) — intercept fetch in React apps
- [Vue Adapter](./vue.md) — intercept fetch in Vue 3 apps
- [Express Adapter](./express.md) — use Schmock as Express middleware
- [Angular Adapter](./angular.md) — intercept Angular HTTP calls
- [API Reference](./api.md) — complete type and method reference
