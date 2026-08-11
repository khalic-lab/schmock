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

The CLI and the all-in-one package require a Node.js version supported by their
faker dependency: `^20.19.0 || ^22.13.0 || ^23.5.0 || >=24.0.0`.

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
function isNamedUser(value: unknown): value is { id: number; name: string } {
  return typeof value === 'object' && value !== null &&
    'id' in value && typeof value.id === 'number' &&
    'name' in value && typeof value.name === 'string'
}

function isUserInput(value: unknown): value is { name: string } {
  return typeof value === 'object' && value !== null &&
    'name' in value && typeof value.name === 'string'
}

mock('GET /health', { status: 'ok' })

mock('POST /users', ({ body }) => {
  if (!isUserInput(body)) return [400, { error: 'A name is required' }]
  return [201, { id: 1, name: body.name }]
})
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

type User = { id: number; name: string }

function isUser(value: unknown): value is User {
  return typeof value === 'object' && value !== null &&
    'id' in value && typeof value.id === 'number' &&
    'name' in value && typeof value.name === 'string'
}

function isUserState(
  state: Record<string, unknown>,
): state is { users: User[]; counter: number } {
  return Array.isArray(state.users) && state.users.every(isUser) &&
    typeof state.counter === 'number'
}

function isNewUser(value: unknown): value is { name: string } {
  return typeof value === 'object' && value !== null &&
    'name' in value && typeof value.name === 'string'
}

const api = schmock({ state: { users: [], counter: 0 } })
```

```typescript docs-run=stateful
api('GET /users/:id', ({ params, state }) => {
  if (!isUserState(state)) return [500, { error: 'Invalid user state' }]
  const user = state.users.find(u => u.id === Number(params.id))
  return user || [404, { error: 'Not found' }]
})
```

**Tuple responses** — control status codes and headers:

```typescript docs-run=stateful
api('POST /users', ({ body, state }) => {
  if (!isUserState(state)) return [500, { error: 'Invalid user state' }]
  if (!isNewUser(body)) return [400, { error: 'A name is required' }]
  state.counter += 1
  const user = { id: state.counter, name: body.name }
  state.users.push(user)
  return [201, user, { 'x-created-id': String(user.id) }]
})

const createdUser = await api.handle('POST', '/users', {
  body: { name: 'Alice' },
})
if (createdUser.status !== 201 || !isUser(createdUser.body) ||
    createdUser.headers['x-created-id'] !== '1') {
  throw new Error('User creation did not return a valid user')
}

const foundUser = await api.handle('GET', '/users/1')
if (foundUser.status !== 200 || !isUser(foundUser.body) ||
    foundUser.body.name !== 'Alice') {
  throw new Error('Created user could not be read back')
}
```

### 3. Handle requests

```typescript docs-run=basics
const health = await mock.handle('GET', '/health')
// → { status: 200, body: { status: 'ok' }, headers: { 'content-type': 'application/json' } }
if (health.status !== 200 || typeof health.body !== 'object' ||
    health.body === null || !('status' in health.body) ||
    health.body.status !== 'ok') {
  throw new Error('Health route did not return the expected response')
}

const abortController = new AbortController()
const created = await mock.handle('POST', '/users', {
  body: { name: 'Alice' },
  headers: { authorization: 'Bearer token' },
  query: { notify: 'true' },
  signal: abortController.signal,
})
if (created.status !== 201 || !isNamedUser(created.body) ||
    created.body.name !== 'Alice') {
  throw new Error('User creation did not return the expected response')
}
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
type StoredUser = { id: number; name: string }

function isStoredUser(value: unknown): value is StoredUser {
  return typeof value === 'object' && value !== null &&
    'id' in value && typeof value.id === 'number' &&
    'name' in value && typeof value.name === 'string'
}

function isStoredUserState(
  state: Record<string, unknown>,
): state is { users: StoredUser[]; nextId: number } {
  return Array.isArray(state.users) && state.users.every(isStoredUser) &&
    typeof state.nextId === 'number'
}

function isStoredUserInput(value: unknown): value is { name: string } {
  return typeof value === 'object' && value !== null &&
    'name' in value && typeof value.name === 'string'
}

const mock = schmock({ state: { users: [], nextId: 1 } })

mock('POST /users', ({ body, state }) => {
  if (!isStoredUserState(state)) return [500, { error: 'Invalid user state' }]
  if (!isStoredUserInput(body)) return [400, { error: 'A name is required' }]
  const user = { id: state.nextId++, name: body.name }
  state.users.push(user)
  return [201, user]
})

mock('GET /users', ({ state }) => {
  if (!isStoredUserState(state)) return [500, { error: 'Invalid user state' }]
  return state.users
})

mock('DELETE /users/:id', ({ params, state }) => {
  if (!isStoredUserState(state)) return [500, { error: 'Invalid user state' }]
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
const alice = await mock.handle('POST', '/users', { body: { name: 'Alice' } })
const bob = await mock.handle('POST', '/users', { body: { name: 'Bob' } })
if (alice.status !== 201 || !isStoredUser(alice.body) ||
    bob.status !== 201 || !isStoredUser(bob.body)) {
  throw new Error('Users were not created successfully')
}

if (!mock.called() || !mock.called('POST', '/users') ||
    mock.callCount('POST', '/users') !== 2) {
  throw new Error('Request history did not record both users')
}

const last = mock.lastRequest('POST', '/users')
// { method: 'POST', path: '/users', body: { name: 'Bob' }, timestamp: ..., response: { status: 201, body: ... } }
if (last === undefined || last.response.status !== 201 ||
    !isStoredUserInput(last.body) || last.body.name !== 'Bob') {
  throw new Error('The last request was not Bob')
}

const all = mock.history('POST', '/users')
// Array of all POST /users request records
if (all.length !== 2) throw new Error('Expected two POST /users records')
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
if (!routes.some(route => route.method === 'POST' && route.path === '/users')) {
  throw new Error('POST /users was not registered')
}
```

## Fetch Interception

Route `globalThis.fetch` through the mock without starting a server:

```typescript docs-run=basics
mock('GET /api/users', [{ id: 1, name: 'Alice' }])

const interception = mock.intercept({ baseUrl: '/api' })

try {
  const response = await fetch('/api/users')
  const users: unknown = await response.json()
  if (!response.ok || !Array.isArray(users) || users.length !== 1 ||
      !isNamedUser(users[0])) {
    throw new Error('Intercepted users response was invalid')
  }
} finally {
  // Release the explicit interception lease when its owner is done.
  interception.restore()
}
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
