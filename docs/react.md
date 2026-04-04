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

`SchmockProvider` patches `globalThis.fetch` on mount and restores it on unmount. Any `fetch()` call inside the tree — whether from your code, React Query, SWR, or axios — is intercepted automatically.

> **Strict Mode:** In React 18+ development mode, components mount → unmount → remount. `SchmockProvider` handles this correctly (it restores fetch on unmount and re-intercepts on remount), but there is a brief window between unmount and remount where fetch is unpatched. If you see intermittent failures in Strict Mode, this is why — they won't occur in production builds.

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
