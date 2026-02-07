# Schmock

TypeScript HTTP mocking library. Callable API, plugin pipeline, framework adapters.

## Install

```sh
bun add @schmock/core
```

Optional packages:

```sh
bun add @schmock/schema    # JSON Schema data generation
bun add @schmock/express   # Express middleware adapter
bun add @schmock/angular   # Angular HTTP interceptor
```

## Usage

```typescript
import { schmock } from '@schmock/core'

const mock = schmock({ namespace: '/api' })

// Static data
mock('GET /config', { version: '1.0.0' }, { contentType: 'application/json' })

// Generator function — receives params, query, headers, body, state
mock('GET /users/:id', ({ params }) => {
  return { id: params.id, name: 'John' }
}, { contentType: 'application/json' })

// Custom status codes via tuple return
mock('POST /users', ({ body }) => [201, { id: 1, ...body }], {
  contentType: 'application/json'
})

const response = await mock.handle('GET', '/api/users/42')
// { status: 200, body: { id: "42", name: "John" }, headers: { ... } }
```

### Stateful mocks

```typescript
const mock = schmock({ state: { users: [] } })

mock('POST /users', ({ body, state }) => {
  state.users.push({ id: Date.now(), ...body })
  return [201, state.users.at(-1)]
}, { contentType: 'application/json' })

mock('GET /users', ({ state }) => state.users, {
  contentType: 'application/json'
})
```

### Plugin pipeline

```typescript
import { schemaPlugin } from '@schmock/schema'

mock('GET /users', null, { contentType: 'application/json' })
  .pipe(schemaPlugin({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string', faker: 'person.fullName' },
          email: { type: 'string', format: 'email' }
        }
      }
    },
    count: 5
  }))
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

## Packages

| Package | Description |
|---------|-------------|
| `@schmock/core` | Mock builder, route handling, plugin pipeline |
| `@schmock/schema` | JSON Schema data generation via faker |
| `@schmock/express` | Express middleware adapter |
| `@schmock/angular` | Angular HTTP interceptor adapter |

## Documentation

- [API Reference](docs/api.md)
- [Plugin Development](docs/plugin-development.md)
- [Debug Mode](docs/debug-mode.md)
- [Coding Standards](docs/coding-standards.md)

## Development

```sh
bun install
bun run setup    # Git hooks (lint + tests on commit)
bun test:all     # Typecheck + unit + BDD
bun test:bdd     # BDD only
bun lint         # Lint
```

Branches: `feature/*` -> `develop` -> `main`. See [CLAUDE.md](./CLAUDE.md) for full workflow.

## Trivia

This project was built to test LLM agent capabilities using BDD as a development framework. The result turned out useful so it got released. Used daily.

## License

MIT
