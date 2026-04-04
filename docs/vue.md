# Vue Adapter

Intercept fetch calls in Vue 3 apps with Schmock. Works in both tests (Node/jsdom) and browser (dev-time).

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

`schmockPlugin` patches `globalThis.fetch` when the plugin is installed and restores it when the app unmounts. Any `fetch()` call — whether from your code, pinia actions, or any HTTP library — is intercepted automatically.

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

### `passthrough`

When `true` (default), requests that don't match any Schmock route are forwarded to the real `fetch`. Set to `false` to return errors for unmatched requests — useful in tests to catch unexpected API calls.

### `baseUrl`

Only intercept requests whose pathname starts with this string. Non-matching requests go straight to real `fetch` without being processed.

## `useSchmock` Composable

Access the mock instance from any component via Vue's injection system:

```typescript
import { useSchmock } from '@schmock/vue'

const mock = useSchmock()
console.log(mock.callCount())
```

Throws if used outside an app with `schmockPlugin` installed.

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
    mock('GET /api/users', [{ id: 1, name: 'Alice' }])
  })

  it('renders users', async () => {
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
