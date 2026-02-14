# Schmock

Schema-driven mock API generator with a direct callable API and plugin pipeline.

## Packages

| Package | Description |
|---------|-------------|
| `@schmock/core` | Core mock builder, routing, and plugin pipeline |
| `@schmock/faker` | Faker-powered automatic data generation |
| `@schmock/validation` | Request/response validation via AJV |
| `@schmock/query` | Pagination, sorting, and filtering for list endpoints |
| `@schmock/openapi` | Auto-register routes from OpenAPI/Swagger specs |
| `@schmock/express` | Express middleware adapter |
| `@schmock/angular` | Angular HTTP interceptor adapter |
| `@schmock/cli` | Standalone CLI server from OpenAPI specs |

## Install

```sh
npm install @schmock/core
```

## Usage

### Define routes, call them immediately

```typescript
import { schmock } from '@schmock/core'

const mock = schmock({ namespace: '/api' })

mock('GET /users', () => [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' }
], { contentType: 'application/json' })

mock('GET /users/:id', ({ params }) => {
  const users = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]
  return users.find(u => u.id === Number(params.id)) || [404, { error: 'Not found' }]
}, { contentType: 'application/json' })

const response = await mock.handle('GET', '/api/users')
// { status: 200, body: [{ id: 1, name: 'Alice' }, ...], headers: { ... } }

const user = await mock.handle('GET', '/api/users/1')
// { status: 200, body: { id: 1, name: 'Alice' }, headers: { ... } }
```

### Stateful mocks

```typescript
const mock = schmock({ state: { users: [] } })

mock('POST /users', ({ body, state }) => {
  const user = { id: Date.now(), ...body }
  state.users.push(user)
  return [201, user]
}, { contentType: 'application/json' })

mock('GET /users', ({ state }) => state.users, {
  contentType: 'application/json'
})

await mock.handle('POST', '/users', { body: { name: 'Alice' } })
const list = await mock.handle('GET', '/users')
// list.body => [{ id: ..., name: 'Alice' }]
```

### Plugin pipeline

```typescript
import { fakerPlugin } from '@schmock/faker'
import { validationPlugin } from '@schmock/validation'
import { queryPlugin } from '@schmock/query'

mock('GET /users', userSchema, { contentType: 'application/json' })
  .pipe(fakerPlugin())
  .pipe(validationPlugin())
  .pipe(queryPlugin())
```

### Schema-based generation with faker

```typescript
import { schmock } from '@schmock/core'
import { fakerPlugin } from '@schmock/faker'

const mock = schmock()

mock('GET /users', {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string', faker: 'person.fullName' },
      email: { type: 'string', format: 'email' }
    }
  }
}, { contentType: 'application/json' })
  .pipe(fakerPlugin())

const response = await mock.handle('GET', '/users')
// Generates realistic fake data from the schema
```

### Request history and spying

```typescript
const mock = schmock()
mock('POST /users', ({ body }) => [201, body], { contentType: 'application/json' })

await mock.handle('POST', '/users', { body: { name: 'Alice' } })
await mock.handle('POST', '/users', { body: { name: 'Bob' } })

mock.called('POST', '/users')       // true
mock.callCount('POST', '/users')    // 2
mock.lastRequest('POST', '/users')  // { method: 'POST', path: '/users', body: { name: 'Bob' }, ... }
mock.history('POST', '/users')      // all recorded POST /users requests
```

### Lifecycle and reset

```typescript
mock.resetHistory()  // clear request history only
mock.resetState()    // reset state to initial values only
mock.reset()         // full reset: routes, history, state, and stop server
```

### OpenAPI auto-mock

Point Schmock at a Swagger/OpenAPI spec and get a fully functional CRUD mock API. Supports Swagger 2.0, OpenAPI 3.0, and 3.1.

```typescript
import { schmock } from '@schmock/core'
import { openapi } from '@schmock/openapi'

const mock = schmock({ state: {} })

mock.pipe(await openapi({
  spec: './petstore.yaml',
  seed: {
    pets: [
      { petId: 1, name: 'Rex', tag: 'dog' },
      { petId: 2, name: 'Whiskers', tag: 'cat' }
    ]
  }
}))

await mock.handle('GET', '/pets')           // list all
await mock.handle('GET', '/pets/1')         // get by id
await mock.handle('POST', '/pets', {        // create
  body: { name: 'Buddy', tag: 'dog' }
})
await mock.handle('DELETE', '/pets/2')      // delete
```

### CLI

Start a mock server from the command line:

```sh
npm install -g @schmock/cli

schmock petstore.yaml
schmock petstore.yaml --port 8080 --cors --seed seed.json
```

Or programmatically:

```typescript
import { createCliServer } from '@schmock/cli'

const server = await createCliServer({
  spec: './petstore.yaml',
  port: 8080,
  cors: true,
  seed: './seed.json'
})
// server.port, server.hostname, server.close()
```

### Standalone HTTP server

Run any mock as a real HTTP server without Express:

```typescript
const mock = schmock()
mock('GET /health', () => ({ status: 'ok' }), { contentType: 'application/json' })

const info = await mock.listen(3000)
// http://127.0.0.1:3000/health

mock.close()
```

### Express adapter

```typescript
import express from 'express'
import { toExpress } from '@schmock/express'

const app = express()
const mock = schmock()

mock('GET /users', () => [{ id: 1, name: 'Alice' }], {
  contentType: 'application/json'
})

app.use('/api', toExpress(mock))
app.listen(3000)
```

### Angular adapter

```typescript
import { schmock } from '@schmock/core'
import { createSchmockInterceptor } from '@schmock/angular'

const mock = schmock()
mock('GET /api/users', () => [{ id: 1, name: 'Alice' }])

export const appConfig = {
  providers: [
    provideHttpClient(
      withInterceptors([createSchmockInterceptor(mock)])
    )
  ]
}
```

### Validation

```typescript
import { validationPlugin } from '@schmock/validation'

mock('POST /users', handler, { contentType: 'application/json' })
  .pipe(validationPlugin({
    requestBody: {
      type: 'object',
      required: ['name', 'email'],
      properties: {
        name: { type: 'string', minLength: 1 },
        email: { type: 'string', format: 'email' }
      }
    }
  }))

// Invalid request body returns 400 with AJV validation errors
// Invalid response body returns 500
```

### Query features

```typescript
import { queryPlugin } from '@schmock/query'

mock('GET /users', ({ state }) => state.users, {
  contentType: 'application/json'
}).pipe(queryPlugin({ defaultLimit: 20, maxLimit: 100 }))

// Pagination:  GET /users?page=2&limit=10
// Sorting:     GET /users?sort=name    or    GET /users?sort=-name
// Filtering:   GET /users?filter[role]=admin
```

## API Reference

See [docs/api.md](./docs/api.md) for the complete API reference covering all packages, types, plugin system, and error hierarchy.

## Trivia

This project was developed to test LLM agent capabilities using BDD as a framework. The result turned out to be useful enough to release. It's used for development on a daily basis.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing, and workflow.

## License

MIT
