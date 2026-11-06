# React Adapter

Intercept fetch calls in React apps with Schmock. Works in both tests (Node/jsdom) and browser (dev-time).

```sh
bun install @schmock/react
```

## Basic Usage

```typescript
import { schmock } from '@schmock/core'
import { SchmockProvider } from '@schmock/react'

const mock = schmock()
mock('GET /api/users', [{ id: 1, name: 'Alice' }])
mock('POST /api/users', ({ body }) => {
  // The request body is typed `unknown`, so narrow it before spreading.
  const input = typeof body === 'object' && body !== null ? body : {}
  return [201, { id: 2, ...input }]
})

function App() {
  return (
    <SchmockProvider mock={mock}>
      <YourApp />
    </SchmockProvider>
  )
}
```

`SchmockProvider` patches `globalThis.fetch` while it renders and restores it on unmount. Any client that uses `globalThis.fetch` — including React Query or SWR when configured with fetch — is intercepted automatically. Clients using another transport are not intercepted. The installer commits before descendant layout effects, so a child may safely fetch from `useLayoutEffect` on its first mount. On unmount, fetch is restored after the descendants' `useEffect` and `useLayoutEffect` cleanups run, so a logout or analytics call made from one is still intercepted. Rendering on the server installs nothing: without a DOM the provider only supplies the mock through context.

The DOM check runs when the provider renders and commits, not when the module
is imported. A test that registers jsdom or happy-dom after its hoisted imports
still intercepts. Environments with no `document` at all (React Native,
`react-test-renderer` under Node) install nothing, by design.

If another library replaces `globalThis.fetch`, a later Schmock provider wraps
that current implementation as its passthrough boundary. Cleanup never
overwrites a third-party replacement it no longer owns.

### Ownership and precedence

The provider takes an interception lease per mounted provider, and a mock can
back several leases at once. Nesting a provider inside another provider for the
same mock is allowed, as is `renderWithSchmock({ mock })` under an outer
provider.

Every lease of the same mock applies its own `baseUrl` and `beforeRequest`.
The mock is then asked each distinct resulting request (method and path) once,
newest lease first. An outer provider whose `beforeRequest` strips `/api`
therefore keeps serving its routes under a nested provider or
`renderWithSchmock({ mock })`. When two leases produce the same method and
path, the newest lease's `passthrough`, `beforeResponse` and `errorFormatter`
apply to it. An older `passthrough: false` lease does not turn a newer
`passthrough: true` lease's miss into a 404.

Changing `options` (including a fresh inline `beforeRequest` on every render)
reconfigures the existing lease in place; it does not re-register it. The
provider therefore keeps the dispatch position it acquired at mount, so
reconfiguring one root never promotes it above a root that mounted later.
Interception is re-acquired only when the `mock` prop itself changes — a new
owner legitimately takes a new position at the front.

A Suspense boundary above the provider that hides content it already showed
(a plain, non-transition update that suspends) does not release the lease: the
provider keeps intercepting while the fallback shows, and keeps its dispatch
position when the content is revealed.

An `<Activity>` boundary is different. Hiding it runs the provider's effect
cleanups, as an unmount does, so the provider releases its lease while hidden.
Showing it again takes a new lease at the front, ahead of any lease another
root or a manual `mock.intercept()` took after the provider first mounted.

Calling `mock.reset()` while the provider is mounted clears routes, state,
history, plugins, and listeners but preserves the provider's explicit
interception lease. Re-register routes on the same mock without remounting the
provider.

### Render-time interception

`SchmockProvider` takes its interception lease while it renders, so a fetch
started during render is intercepted on the first mount. This covers Suspense
data fetching (TanStack `useSuspenseQuery`, SWR with `suspense`, `use()` over a
promise created in render), and `renderWithSchmock` gets the same guarantee.

> **Strict Mode:** The provider holds exactly one lease under `StrictMode`. A render that React discards without committing (a suspended first mount, a render that throws) releases its lease one task later, through `setTimeout(0)`.

A Suspense boundary above the provider keeps it from committing until the
render's promise settles. The render's lease still covers a promise chain that
awaits mocked responses and fetches again (a token, then the data), as long as
the chain finishes within that task. A fetch issued after a timer or another
task boundary (a route `delay`, a retry back-off) can be missed. Put the
Suspense boundary inside the provider, or call `mock.intercept()` before the
first render, if you depend on that case.

One more gap remains. In a time-sliced (transition) render, a fetch started in
a later render slice, before the provider commits, can be missed. If you depend
on that case, call `mock.intercept()` before the first render.

## Options

```typescript
<SchmockProvider
  mock={mock}
  options={{
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
  }}
>
  <YourApp />
</SchmockProvider>
```

### `passthrough`

When `true` (default), requests that don't match any Schmock route are forwarded to the real `fetch`. Set to `false` to return errors for unmatched requests — useful in tests to catch unexpected API calls.

### `baseUrl`

Only intercept requests whose pathname starts with this string. Non-matching requests go straight to real `fetch` without being processed.

`baseUrl` only filters which requests are mocked. It does not strip the
prefix, so register routes with the full path (`GET /api/users`). The Angular
adapter's `baseUrl` strips the prefix instead.

To register routes without the prefix, give the mock a `namespace`:
`schmock({ namespace: '/api' })` serves `mock('GET /users', ...)` at
`/api/users`. That works the same under `intercept()`, `mock.listen()`,
Express and the CLI, so it is the portable way to leave the prefix out of
route keys. Do not also set the Angular adapter's `baseUrl` to it: see
[`baseUrl`](./angular.md#baseurl) in the Angular guide.

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

### OpenAPI cookie API keys

The mock never sees the browser's `Cookie` header: page code cannot set it,
and the provider answers before the browser attaches its cookie jar. So with
`@schmock/openapi`'s `security: true`, an operation secured only by a cookie
API key answers 401 even when the browser holds the cookie. Add the cookie in
`beforeRequest`, as [Security Validation](./openapi.md#security-validation)
shows; only its presence is checked.

## `useSchmock` Hook

Access the mock instance from any component inside the provider:

```typescript
import { useSchmock } from '@schmock/react'

function DevTools() {
  const mock = useSchmock()

  return (
    <div>
      <p>Requests: {mock.callCount()}</p>
      <button onClick={() => mock.resetHistory()}>Clear</button>
    </div>
  )
}
```

Throws if used outside a `SchmockProvider`.

## Seeing mocked requests in Chrome DevTools

Requests the provider mocks never reach the network, so Chrome's Network panel
does not list them. Pipe `devtoolsPlugin()` from `@schmock/devtools` into the
mock to log each one as a collapsed console group and a Performance-panel
track entry:

```typescript
import { schmock } from '@schmock/core'
import { devtoolsPlugin } from '@schmock/devtools'
import { SchmockProvider } from '@schmock/react'

const mock = schmock()
mock.pipe(devtoolsPlugin())
mock('GET /api/users', [{ id: 1, name: 'Alice' }])

function App() {
  return (
    <SchmockProvider mock={mock}>
      <YourApp />
    </SchmockProvider>
  )
}
```

The provider needs no extra prop: the plugin observes the lease it already
takes. This is unrelated to the `DevTools` component above, which is your own
UI reading the mock. The plugin writes to the browser's DevTools instead.
`mock.reset()` removes the plugin while the lease stays, so pipe it again after
a reset. See the [DevTools guide](./devtools.md).

To list mocked requests in the Network panel itself, XHR included, start the
service-worker relay before the first render. Copy the worker script once with
`npx @schmock/devtools init public`, then:

```typescript
import { createRoot } from 'react-dom/client'
import { startServiceWorkerRelay } from '@schmock/devtools'

await startServiceWorkerRelay()

createRoot(document.getElementById('root')!).render(
  <SchmockProvider mock={mock}>
    <App />
  </SchmockProvider>,
)
```

The relay routes every lease of the page's current interception, the provider's
included, so the provider needs no new prop (a lease taken before another
library wrapped `fetch` is not routed; see [Hazards](./devtools.md#hazards), "A
lease behind another `fetch` wrapper"). Mocked requests then show as Network
rows with Size `(ServiceWorker)`. A relay that cannot start warns once, and the
provider keeps answering `fetch` in the page. See
[Network panel relay](./devtools.md#network-panel-relay).

## Testing

### With SchmockProvider directly

```typescript
import { render, screen, waitFor } from '@testing-library/react'
import { schmock } from '@schmock/core'
import { SchmockProvider } from '@schmock/react'

it('loads users', async () => {
  const mock = schmock()
  mock('GET /api/users', [{ id: 1, name: 'Alice' }])

  render(
    <SchmockProvider mock={mock}>
      <UserList />
    </SchmockProvider>
  )

  await waitFor(() => {
    expect(screen.getByText('Alice')).toBeDefined()
  })

  expect(mock.called('GET', '/api/users')).toBe(true)
})
```

### With `renderWithSchmock` shorthand

A convenience wrapper that creates the mock, registers routes, and wraps your component:

```typescript
import { renderWithSchmock } from '@schmock/react/testing'

it('loads users', async () => {
  const { mock } = renderWithSchmock(<UserList />, {
    routes: [
      ['GET /api/users', [{ id: 1, name: 'Alice' }]],
    ],
  })

  await waitFor(() => {
    expect(screen.getByText('Alice')).toBeDefined()
  })

  expect(mock.callCount()).toBe(1)
})
```

`renderWithSchmock` returns the standard `@testing-library/react` `RenderResult` plus a `mock` property for assertions.

The testing entry imports the same provider context as the package root, so
`useSchmock()` from `@schmock/react` works inside
`renderWithSchmock()` from `@schmock/react/testing`.

> **Note:** `renderWithSchmock` requires `@testing-library/react` as a peer dependency. It is exported from `@schmock/react/testing` (a separate entry point) so projects that don't use Testing Library are not affected.

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

render(
  <SchmockProvider mock={mock}>
    <UserManager />
  </SchmockProvider>
)
```

## Helper Functions

Response helpers are available from `@schmock/core`:

```typescript
import { notFound, badRequest, created, noContent } from '@schmock/core'

// State and request bodies are typed `unknown`, so narrow them before use.
type User = { id: number; name: string }
const isUsers = (value: unknown): value is User[] => Array.isArray(value)

mock('GET /api/users/:id', ({ params, state }) => {
  const users = isUsers(state.users) ? state.users : []
  const user = users.find((u) => u.id === Number(params.id))
  return user || notFound('User not found')
})

mock('POST /api/users', ({ body }) => {
  if (typeof body !== 'object' || body === null || !('name' in body)) {
    return badRequest('name is required')
  }
  return created({ id: 3, ...body })
})

mock('DELETE /api/users/:id', () => noContent())
```
