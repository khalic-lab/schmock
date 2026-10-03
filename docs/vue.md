# Vue Adapter

Intercept fetch calls in Vue 3.5+ apps with Schmock. Works in both tests (Node/jsdom) and browser (dev-time).

```sh
bun install @schmock/vue
```

## Basic Usage

```typescript
import { createApp } from 'vue'
import { schmock } from '@schmock/core'
import { schmockPlugin } from '@schmock/vue'

const mock = schmock()
mock('GET /api/users', [{ id: 1, name: 'Alice' }])
mock('POST /api/users', ({ body }) => [201, { id: 2, ...body }])

const app = createApp(App)
app.use(schmockPlugin, { mock })
app.mount('#app')
```

`schmockPlugin` patches `globalThis.fetch` in the browser when the plugin is installed and restores it when the app unmounts. Calls from your code, Pinia actions, or other clients are intercepted only when they use `globalThis.fetch`; clients using another transport are not intercepted.

Calling `mock.reset()` while the app is mounted clears routes, state, history,
plugins, and listeners but preserves the Vue plugin's explicit interception
lease. Re-register routes on the same mock without reinstalling the plugin.

### Releasing interception

Unmounting the app releases its lease. For an app that never reaches an
unmount — one that is never mounted, or whose `mount()` throws — release it
explicitly:

```typescript
import { restoreSchmockInterception } from '@schmock/vue'

const app = createApp(App)
app.use(schmockPlugin, { mock })

// ...never mounted, or torn down some other way
restoreSchmockInterception(app)
```

`restoreSchmockInterception(app)` is idempotent and safe for an app that never
intercepted. A `mount()` that throws releases the lease before rethrowing, so a
failed startup does not leave `globalThis.fetch` patched.

Several apps may share one mock: each `app.use(schmockPlugin, { mock })` takes
its own lease, and the newest one is consulted first. A manual
`mock.intercept()` stacks the same way, and `globalThis.fetch` is restored only
once the last lease of any kind is released.

### Server-side rendering

With no `document` — SSR, or any server render — the plugin does **not** patch
`globalThis.fetch`. A server's `fetch` is shared by every concurrent request, so
patching it would leak one render's mock into another's. `app.provide` still
runs, so `useSchmock()` works during SSR; only fetch interception is skipped.
Mock your data layer directly on the server, or intercept at the transport your
server actually uses.

## Options

```typescript
app.use(schmockPlugin, {
  mock,
  interceptOptions: {
    baseUrl: '/api',         // only intercept URLs starting with this prefix
    passthrough: true,       // pass unmatched routes to real fetch (default: true)

    beforeRequest: (request) => ({
      ...request,
      headers: { ...request.headers, 'x-tenant': 'dev' },
    }),

    beforeResponse: (response) => ({
      ...response,
      headers: { ...response.headers, 'x-mock': 'true' },
    }),

    errorFormatter: (error) => ({
      message: error.message,
      timestamp: new Date().toISOString(),
    }),
  },
})
```

`options` is accepted as an alias of `interceptOptions`, the name React's
`SchmockProvider` uses, so `app.use(schmockPlugin, { mock, options: { baseUrl: '/api' } })`
works too. When both are given, `interceptOptions` wins.

### `passthrough`

When `true` (default), requests that don't match any Schmock route are forwarded to the real `fetch`. Set to `false` to return errors for unmatched requests — useful in tests to catch unexpected API calls.

### `baseUrl`

Only intercept requests whose pathname starts with this string. Non-matching requests go straight to real `fetch` without being processed.

`baseUrl` only filters which requests are mocked. It does not strip the
prefix, so register routes with the full path (`GET /api/users`). The Angular
adapter's `baseUrl` strips the prefix instead.

### `errorFormatter`

`errorFormatter(error, request)` formats core-marked internal exceptions — an
error thrown by a route generator or a plugin — and errors thrown by the
`beforeRequest`/`beforeResponse` hooks, matching the Express and Angular
adapters. It does not reinterpret an ordinary user-defined 500 route response
such as `[500, { error: 'domain failure' }]`.

The second argument is the request as routed: the `AdapterRequest` after
`beforeRequest` once that hook has returned, the pre-hook request when the hook
threw, and the incoming request without a body when the body could not be
read. A one-argument formatter still works.

On the core-marked exception path, provenance is captured before
`beforeResponse` runs, so a hook that clones the response with
`{ ...response }` does not suppress the formatter. The post-hook status gates
the replacement: a `beforeResponse` that rewrites an exception into a `503` (or
a `200`) is honoured and the formatter is not invoked. That response keeps the
post-hook response headers — `retry-after` and friends survive — with
`content-type` forced to `application/json`, and a formatter that throws, or
that returns a body which cannot be serialized, yields
`{ error: 'Internal Server Error', code: 'INTERNAL_ERROR' }` without being
invoked a second time.

A hook that *throws* is handled separately: that response inherits no headers
beyond `content-type: application/json`, and a formatter that throws while
handling it propagates, rejecting the `fetch` call. If the formatter returns a
body the transport cannot serialize (a `BigInt`, a circular object, an
`undefined` leaf), the response falls back to a 500
`{ error: 'Internal Server Error', code: 'INTERNAL_ERROR' }`, the same fallback
the core-marked exception path uses.

## `useSchmock` Composable

Access the mock instance from any component via Vue's injection system:

```typescript
import { useSchmock } from '@schmock/vue'

const mock = useSchmock()
console.log(mock.callCount())
```

Throws if used outside an app with `schmockPlugin` installed.

## Seeing mocked requests in Chrome DevTools

Requests the plugin mocks never reach the network, so Chrome's Network panel
does not list them. Pipe `devtoolsPlugin()` from `@schmock/devtools` into the
mock to log each one as a collapsed console group and a Performance-panel
track entry:

```typescript
import { createApp } from 'vue'
import { schmock } from '@schmock/core'
import { devtoolsPlugin } from '@schmock/devtools'
import { schmockPlugin } from '@schmock/vue'

const mock = schmock()
mock.pipe(devtoolsPlugin())
mock('GET /api/users', [{ id: 1, name: 'Alice' }])

const app = createApp(App)
app.use(schmockPlugin, { mock })
app.mount('#app')
```

`schmockPlugin` needs no extra option: the DevTools plugin observes the lease
it already takes. `mock.reset()` removes the DevTools plugin while the lease
stays, so pipe it again after a reset. See the [DevTools guide](./devtools.md).

To list mocked requests in the Network panel itself, XHR included, start the
service-worker relay before mounting. Copy the worker script once with
`npx schmock-devtools init public`, then:

```typescript
import { startServiceWorkerRelay } from '@schmock/devtools'

const app = createApp(App)
app.use(schmockPlugin, { mock })

await startServiceWorkerRelay()
app.mount('#app')
```

The relay routes the lease `schmockPlugin` takes, so the plugin needs no new
option. Mocked requests then show as Network rows with Size `(ServiceWorker)`.
A relay that cannot start warns once, and `fetch` stays mocked in the page.
See [Network panel relay](./devtools.md#network-panel-relay).

## Testing with `@vue/test-utils`

```typescript
import { mount, flushPromises } from '@vue/test-utils'
import { schmock } from '@schmock/core'
import { schmockPlugin } from '@schmock/vue'

it('loads users', async () => {
  const mock = schmock()
  mock('GET /api/users', [{ id: 1, name: 'Alice' }])

  const wrapper = mount(UserList, {
    global: {
      plugins: [[schmockPlugin, { mock }]],
    },
  })

  await flushPromises()

  expect(wrapper.text()).toContain('Alice')
  expect(mock.called('GET', '/api/users')).toBe(true)

  wrapper.unmount()
})
```

### Test isolation

Create a fresh mock per test to avoid shared state:

```typescript
describe('UserList', () => {
  let mock: ReturnType<typeof schmock>

  beforeEach(() => {
    mock = schmock()
  })

  it('renders users', async () => {
    mock('GET /api/users', [{ id: 1, name: 'Alice' }])
    const wrapper = mount(UserList, {
      global: { plugins: [[schmockPlugin, { mock }]] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Alice')
    wrapper.unmount()
  })

  it('shows empty state', async () => {
    mock('GET /api/users', [])
    const wrapper = mount(UserList, {
      global: { plugins: [[schmockPlugin, { mock }]] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('No users')
    wrapper.unmount()
  })
})
```

### OpenAPI specs in jsdom and happy-dom

A file-path `spec` passed to `@schmock/openapi` (`'./petstore.yaml'`), and any
relative external `$ref`s it has with `refs: { external: true }`, is read from
disk in jsdom and happy-dom test environments too, not fetched relative to
`window.location`. See
[OpenAPI-Based Tests](./testing.md#openapi-based-tests).

## Stateful Mocking

Combine with Schmock's state management for realistic CRUD flows:

```typescript
const mock = schmock({
  state: { users: [{ id: 1, name: 'Alice' }], nextId: 2 },
})

mock('GET /api/users', ({ state }) => (state as any).users)
mock('POST /api/users', ({ body, state }) => {
  const s = state as any
  const user = { id: s.nextId++, ...body as object }
  s.users.push(user)
  return [201, user]
})
mock('DELETE /api/users/:id', ({ params, state }) => {
  const s = state as any
  s.users = s.users.filter((u: any) => u.id !== Number(params.id))
  return [204, null]
})
```

## Helper Functions

Response helpers are available from `@schmock/core`:

```typescript
import { notFound, badRequest, created, noContent } from '@schmock/core'

mock('GET /api/users/:id', ({ params, state }) => {
  const user = state.users.find(u => u.id === Number(params.id))
  return user || notFound('User not found')
})

mock('POST /api/users', ({ body }) => {
  if (!body?.name) return badRequest('name is required')
  return created({ id: 3, ...body })
})

mock('DELETE /api/users/:id', () => noContent())
```
