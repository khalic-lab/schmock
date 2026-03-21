# Schmock

Mock APIs from OpenAPI specs or hand-crafted routes. Callable API, plugin pipeline, framework adapters.

```typescript
import { schmock } from '@schmock/core'
import { openapi } from '@schmock/openapi'

const mock = schmock({ state: {} })

mock.pipe(await openapi({
  spec: './petstore.yaml',
  seed: { pets: { count: 5 } }
}))

const res = await mock.handle('GET', '/pets')
// → { status: 200, body: [{ petId: 1, name: "Rex", ... }, ...] }
```

## Why Schmock?

- **OpenAPI-first**: Point at a spec, get a fully functional CRUD mock with stateful collections, seed data, security validation, and content negotiation
- **Callable API**: No HTTP server needed — call `mock.handle()` directly in tests
- **Plugin pipeline**: Chain plugins with `.pipe()` for validation, pagination, filtering, or custom logic
- **Framework adapters**: Drop into Express middleware or Angular HTTP interceptor
- **Smart data generation**: Field-name-aware faker generates realistic data from schemas

## Packages

| Package | Description |
|---------|-------------|
| [`@schmock/core`](./docs/getting-started.md) | Core mock builder, routing, and plugin pipeline |
| [`@schmock/openapi`](./docs/openapi.md) | Auto-register routes from OpenAPI/Swagger specs |
| [`@schmock/faker`](./docs/api.md#faker-plugin) | Faker-powered automatic data generation |
| [`@schmock/validation`](./docs/api.md#validation-plugin) | Request/response validation via AJV |
| [`@schmock/query`](./docs/api.md#query-plugin) | Pagination, sorting, and filtering |
| [`@schmock/express`](./docs/express.md) | Express middleware adapter |
| [`@schmock/angular`](./docs/angular.md) | Angular HTTP interceptor adapter |
| [`@schmock/cli`](./docs/cli.md) | Standalone CLI mock server |

## Quick Start

```sh
npm install @schmock/core
```

### Define routes, call them directly

```typescript
const mock = schmock()

mock('GET /users', [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
])

mock('GET /users/:id', ({ params }) => {
  const users = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]
  return users.find(u => u.id === Number(params.id)) || [404, { error: 'Not found' }]
})

const res = await mock.handle('GET', '/users/1')
// → { status: 200, body: { id: 1, name: 'Alice' }, headers: {...} }
```

### Stateful mocks with CRUD

```typescript
const mock = schmock({ state: { items: [] } })

mock('POST /items', ({ body, state }) => {
  const item = { id: state.items.length + 1, ...body }
  state.items.push(item)
  return [201, item]
})

mock('GET /items', ({ state }) => state.items)

await mock.handle('POST', '/items', { body: { name: 'Widget' } })
const list = await mock.handle('GET', '/items')
// list.body → [{ id: 1, name: 'Widget' }]
```

### Mock from an OpenAPI spec

```typescript
import { openapi } from '@schmock/openapi'

const mock = schmock({ state: {} })
mock.pipe(await openapi({
  spec: './petstore.yaml',
  seed: { pets: [{ petId: 1, name: 'Rex', tag: 'dog' }] },
  security: true,
}))

await mock.handle('GET', '/pets')           // list
await mock.handle('GET', '/pets/1')         // get by id
await mock.handle('POST', '/pets', {        // create
  body: { name: 'Buddy', tag: 'dog' },
  headers: { authorization: 'Bearer token' },
})
await mock.handle('DELETE', '/pets/1')      // delete
```

### Request spying

```typescript
await mock.handle('POST', '/items', { body: { name: 'A' } })
await mock.handle('POST', '/items', { body: { name: 'B' } })

mock.called('POST', '/items')       // true
mock.callCount('POST', '/items')    // 2
mock.lastRequest('POST', '/items')  // { body: { name: 'B' }, ... }
```

### Plugin pipeline

```typescript
import { validationPlugin } from '@schmock/validation'
import { queryPlugin } from '@schmock/query'

mock('GET /users', ({ state }) => state.users)
  .pipe(validationPlugin({ request: { query: querySchema } }))
  .pipe(queryPlugin({
    pagination: { defaultLimit: 20 },
    sorting: { allowed: ['name', 'created_at'] },
    filtering: { allowed: ['role'] },
  }))

// GET /users?filter[role]=admin&sort=name&page=2&limit=10
```

### Framework adapters

**Express:**
```typescript
import { toExpress } from '@schmock/express'
app.use('/api', toExpress(mock))
```

**Angular:**
```typescript
import { provideSchmockInterceptor } from '@schmock/angular'
providers: [provideSchmockInterceptor(mock, { baseUrl: '/api' })]
```

### CLI server

```sh
npm install -g @schmock/cli
schmock petstore.yaml --port 8080 --cors --seed seed.json
```

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](./docs/getting-started.md) | Installation, core concepts, first mock |
| [OpenAPI](./docs/openapi.md) | Auto-mocking, CRUD, seed data, Prefer header, security, schema patching |
| [Testing](./docs/testing.md) | Unit tests, integration tests, Angular & Express testing patterns |
| [Express Adapter](./docs/express.md) | Express middleware setup and options |
| [Angular Adapter](./docs/angular.md) | Angular interceptor, helpers, TestBed setup |
| [CLI](./docs/cli.md) | Command-line mock server |
| [Plugin Development](./docs/plugins.md) | Writing custom plugins |
| [API Reference](./docs/api.md) | Complete type and method reference |
| [Debug Mode](./docs/debug-mode.md) | Request lifecycle logging |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and workflow.

## License

MIT
