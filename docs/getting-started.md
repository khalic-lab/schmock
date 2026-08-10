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
bun install @schmock/schmock    # Core + non-framework plugins + CLI
```

## Core Concepts

### 1. Create a mock instance

```typescript docs-run=basics
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
  maxHistorySize: 1000,           // retain only the newest 1000 requests
})
```

### 2. Define routes

Routes are defined by calling the instance directly:

```typescript docs-run=basics
mock('GET /health', { status: 'ok' })
```

The first argument is a `RouteKey` in the format `METHOD /path`. The second is a **generator** — it can be:

**Static data** — returned as-is:

```typescript docs-run=basics
mock('GET /config', { version: '2.0', env: 'staging' })
```

**Generator function** — called on each request. These two read and write
`state`, so they need an instance created with it:

```typescript docs-run=stateful
import { schmock } from '@schmock/core'

const api = schmock({ state: { users: [], counter: 0 } })
```

```typescript docs-run=stateful
api('GET /users/:id', ({ params, state }) => {
  const user = state.users.find(u => u.id === Number(params.id))
  return user || [404, { error: 'Not found' }]
})
```

**Tuple responses** — control status codes and headers:

```typescript docs-run=stateful
api('POST /users', ({ body, state }) => {
  const user = { id: ++state.counter, ...body }
  state.users.push(user)
  return [201, user, { 'x-created-id': String(user.id) }]
})
```

### 3. Handle requests

```typescript docs-run=basics
const health = await mock.handle('GET', '/health')
// → { status: 200, body: { status: 'ok' }, headers: { 'content-type': 'application/json' } }

const abortController = new AbortController()
const created = await mock.handle('POST', '/users', {
  body: { name: 'Alice' },
  headers: { authorization: 'Bearer token' },
  query: { notify: 'true' },
  signal: abortController.signal,
})
```

Ordinary handling errors become response objects with appropriate status codes.
Cancellation rejects with the signal reason (or an `AbortError`) and does not
enter request history.

### 4. Use plugins

Plugins add behavior through a linear pipeline:

```typescript
import { validationPlugin } from '@schmock/validation'

mock.pipe(validationPlugin({
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
mock('POST /users', handler)
```

Plugins are global to the mock. Pre-request hooks can reject before route code;
response processors then run in `.pipe()` order after the generator.

## State Management

State is shared across all routes and persists between requests. Calling
`schmock()` without a state still creates one persistent empty state object:

```typescript docs-run=state
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
mock.resetState()   // replace shared state with an empty object
mock.resetHistory() // clear request history only
mock.reset()        // full reset: routes, state, history, plugins, stop server
```

`reset()` does not release an explicit `mock.intercept()` lease. Call the
returned handle's `restore()` method when the interceptor owner is unmounted or
finished. Requests admitted before reset finish against their original route,
state, and plugin snapshots; plugin cleanup waits for those requests to settle.
Resetting replaces internal state without mutating the state object originally
provided by the caller.

## Request Spying

Every request that matched a route is recorded for assertions, including one
that ended in a 500 — the recorded `response` carries that status. Route misses
and canceled requests are not recorded:

```typescript docs-run=state
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

History reads return detached snapshots. `resetHistory()` prevents pending
older requests from committing after the reset, and `maxHistorySize` applies
FIFO eviction when a bounded history is configured.

## Lifecycle Events

Subscribe to request lifecycle events:

```typescript docs-run=basics
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

Event payloads and listener sets are snapshotted for each emission. A throwing
or rejecting listener is logged and isolated from request processing. Full
reset clears listeners and suppresses stale events from older requests.

## Route Introspection

```typescript docs-run=basics
const routes = mock.getRoutes()
// [{ method: 'GET', path: '/users', hasParams: false },
//  { method: 'GET', path: '/users/:id', hasParams: true }]
```

## Fetch Interception

Route `globalThis.fetch` through the mock without starting a server:

```typescript docs-run=basics
mock('GET /api/users', [{ id: 1, name: 'Alice' }])

const interception = mock.intercept({ baseUrl: '/api' })

const response = await fetch('/api/users')

// Release the explicit interception lease when its owner is done.
interception.restore()
```

The interceptor honors `RequestInit` overrides and abort signals, resolves
browser-relative URLs, and passes unmatched requests through unchanged by
default. `baseUrl` filters requests but does not strip the prefix before route
lookup. A full `mock.reset()` keeps the explicit lease active so mounted UI
adapters can re-register routes without patching fetch again.

Interception is a lease, not a lock: a mock can hold several concurrent leases —
nested providers, or a framework adapter alongside a manual `intercept()` — each
with its own options and its own idempotent `restore()`. Leases are consulted
newest-first, and the original `fetch` returns only once the last one is
released. See the [API reference](./api.md#interceptoptions) for `update()` and
dispatch-order details.

## Standalone HTTP Server

Run any mock as a real HTTP server:

```typescript
const fixed = await mock.listen(3000)
// Listening on http://127.0.0.1:3000

// Use port 0 for a random available port (great for tests)
mock.close()
const random = await mock.listen(0)
console.log(`Running on port ${random.port}`)

// Stop the server
mock.close()
```

Server starts are reserved immediately, `close()` safely cancels a pending
start, and an immediate same-port restart waits for shutdown. Node ingress has
a 10 MiB request limit: malformed JSON returns structured 400
`MALFORMED_JSON`, oversized bodies return structured 413
`PAYLOAD_TOO_LARGE`, and neither reaches route code or history. Client
disconnects cancel admitted work.

## Next Steps

- [OpenAPI Auto-Mocking](./openapi.md) — the fastest way to get a realistic mock API
- [Testing Patterns](./testing.md) — real-world testing workflows
- [React Adapter](./react.md) — intercept fetch in React apps
- [Vue Adapter](./vue.md) — intercept fetch in Vue 3 apps
- [Express Adapter](./express.md) — use Schmock as Express middleware
- [Angular Adapter](./angular.md) — intercept Angular HTTP calls
- [API Reference](./api.md) — complete type and method reference
