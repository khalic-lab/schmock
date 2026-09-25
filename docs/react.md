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
mock('POST /api/users', ({ body }) => [201, { id: 2, ...body }])

function App() {
  return (
    <SchmockProvider mock={mock}>
      <YourApp />
    </SchmockProvider>
  )
}
```

`SchmockProvider` patches `globalThis.fetch` while it renders and restores it on unmount. Any client that uses `globalThis.fetch` — including React Query or SWR when configured with fetch — is intercepted automatically. Clients using another transport are not intercepted. The installer commits before descendant layout effects, so a child may safely fetch from `useLayoutEffect` on its first mount. Rendering on the server installs nothing: without a DOM the provider only supplies the mock through context.

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

Calling `mock.reset()` while the provider is mounted clears routes, state,
history, plugins, and listeners but preserves the provider's explicit
interception lease. Re-register routes on the same mock without remounting the
provider.

### Render-time interception

`SchmockProvider` takes its interception lease while it renders, so a fetch
started during render is intercepted on the first mount. This covers Suspense
data fetching (TanStack `useSuspenseQuery`, SWR with `suspense`, `use()` over a
promise created in render), and `renderWithSchmock` gets the same guarantee.

> **Strict Mode:** The provider holds exactly one lease under `StrictMode`. A render that React discards without committing (a suspended first mount, a render that throws) releases its lease at the next microtask.

One gap remains. In a time-sliced (transition) render, a fetch started in a
later render slice, before the provider commits, can be missed. If you depend
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

### `errorFormatter`

`errorFormatter(error)` formats core-marked internal exceptions — an error
thrown by a route generator or a plugin — and errors thrown by the
`beforeRequest`/`beforeResponse` hooks, matching the Express and Angular
adapters. It does not reinterpret an ordinary user-defined 500 route response
such as `[500, { error: 'domain failure' }]`.

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
