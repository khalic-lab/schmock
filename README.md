# Schmock 🎭

🚧 under development, wait for v1 for usage

> Schema-driven mock API generator with fluent API and plugin system

## Overview

Schmock is a powerful mock API generator that allows you to quickly create predictable, schema-driven mock endpoints for frontend development. With its new fluent API, you can define complex mock behaviors in a clean, readable way.

## Features

- 🚀 **Quick Setup**: Get a mock API running in under 30 seconds
- ✨ **Fluent API**: Clean, chainable syntax for defining mocks
- 📋 **Schema-Driven**: Use JSON Schema to define your data structures
- 🎯 **Type-Safe**: Full TypeScript support with ambient types
- 🔄 **Stateful Mocks**: Maintain state between requests

## Installation

```sh
# Using bun (recommended)
bun add @schmock/core

# Using npm
npm install @schmock/core

# Using yarn
yarn add @schmock/core
```

## Quick Start

### Basic Usage

```typescript
import { schmock } from '@schmock/core'

// Create a mock API with fluent syntax
const mock = schmock()
  .routes({
    'GET /api/users': {
      response: () => [
        { id: 1, name: 'John Doe', email: 'john@example.com' },
        { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
      ]
    },
    'GET /api/users/:id': {
      response: ({ params }) => {
        const users = [
          { id: 1, name: 'John Doe', email: 'john@example.com' },
          { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
        ]
        return users.find(u => u.id === Number(params.id)) || [404, { error: 'User not found' }]
      }
    }
  })
  .build()

// Make requests
const response = await mock.handle('GET', '/api/users')
console.log(response.status) // 200
console.log(response.body) // [{ id: 1, name: 'John Doe', ... }, ...]

// With parameters
const userResponse = await mock.handle('GET', '/api/users/1')
console.log(userResponse.body) // { id: 1, name: 'John Doe', ... }
```

### Stateful Mocks

```typescript
const mock = schmock()
  .state({ users: [] })
  .routes({
    'GET /api/users': {
      response: ({ state }) => state.users
    },
    'POST /api/users': {
      response: ({ body, state }) => {
        const newUser = { 
          id: Date.now(), 
          ...body, 
          createdAt: new Date().toISOString() 
        }
        state.users.push(newUser)
        return [201, newUser]
      }
    },
    'DELETE /api/users/:id': {
      response: ({ params, state }) => {
        const index = state.users.findIndex(u => u.id === Number(params.id))
        if (index === -1) return [404, { error: 'User not found' }]
        state.users.splice(index, 1)
        return [204, null]
      }
    }
  })
  .build()

// Create a user
const created = await mock.handle('POST', '/api/users', {
  body: { name: 'Alice', email: 'alice@example.com' }
})
console.log(created.status) // 201

// List users
const list = await mock.handle('GET', '/api/users')
console.log(list.body) // [{ id: 123456, name: 'Alice', ... }]
```

### Custom Status Codes and Headers

```typescript
const mock = schmock()
  .routes({
    'POST /api/upload': {
      response: ({ body }) => [
        201,
        { id: 123, filename: body.name },
        { 'Location': '/api/files/123' }
      ]
    },
    'GET /api/protected': {
      response: ({ headers }) => {
        if (!headers.authorization) {
          return [401, { error: 'Unauthorized' }]
        }
        return { data: 'secret' }
      }
    }
  })
  .build()

// Response with custom headers
const upload = await mock.handle('POST', '/api/upload', {
  body: { name: 'document.pdf' }
})
console.log(upload.status) // 201
console.log(upload.headers.Location) // '/api/files/123'
```

### Configuration Options

```typescript
const mock = schmock()
  .config({ 
    namespace: '/api/v2',  // Prefix all routes
    delay: [100, 500]      // Random delay between 100-500ms
  })
  .routes({
    'GET /users': {  // Actually responds to /api/v2/users
      response: () => [{ id: 1, name: 'John' }]
    }
  })
  .build()
```

## Advanced Usage

### Query Parameters and Headers

```typescript
const mock = schmock()
  .routes({
    'GET /api/search': {
      response: ({ query }) => ({
        results: [],
        query: query.q,
        page: Number(query.page) || 1
      })
    },
    'GET /api/me': {
      response: ({ headers }) => ({
        authenticated: !!headers.authorization,
        user: headers.authorization ? { id: 1, name: 'John' } : null
      })
    }
  })
  .build()

// With query parameters
const search = await mock.handle('GET', '/api/search', {
  query: { q: 'typescript', page: '2' }
})
console.log(search.body) // { results: [], query: 'typescript', page: 2 }

// With headers
const me = await mock.handle('GET', '/api/me', {
  headers: { authorization: 'Bearer token123' }
})
console.log(me.body.authenticated) // true
```

### With Express/HTTP Server (Coming Soon)

```typescript
import express from 'express'
import { toExpress } from '@schmock/express'

const app = express()

const mock = schmock()
  .routes({
    'GET /api/users': {
      response: () => [{ id: 1, name: 'John' }]
    }
  })
  .build()

app.use('/mock', toExpress(mock))
app.listen(3000)
```

### Schema-Based Generation (Coming Soon)

```typescript
import { schmock } from '@schmock/core'
import { schemaPlugin } from '@schmock/plugin-schema'

const mock = schmock()
  .use(schemaPlugin())
  .routes({
    'GET /api/users': {
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
      }
    }
  })
  .build()
```

## API Reference

### Route Definition

Routes use the format `'METHOD /path'` as keys:

```typescript
schmock().routes({
  'GET /users': { response: () => [] },
  'POST /users': { response: ({ body }) => [201, body] },
  'PUT /users/:id': { response: ({ params, body }) => ({ ...body, id: params.id }) },
  'DELETE /users/:id': { response: () => [204, null] }
})
```

### Response Types

Response functions can return:
- **Direct value**: Returns as 200 OK
- **`[status, body]`**: Custom status code
- **`[status, body, headers]`**: Custom status, body, and headers

### Context Object

Response functions receive a context with:
- `state`: Shared mutable state
- `params`: Path parameters (e.g., `:id`)
- `query`: Query string parameters
- `body`: Request body
- `headers`: Request headers
- `method`: HTTP method
- `path`: Request path

## Development

This project uses a monorepo structure with Bun workspaces.

### Setup

```sh
# Install dependencies
bun install

# Run tests
bun test

# Run BDD tests
bun test:bdd

# Build
bun run build
```

### Project Structure

```
schmock/
├── packages/
│   ├── core/           # Core Schmock functionality with fluent API
│   ├── core/           # Core Schmock functionality (legacy)
│   ├── express/        # Express middleware (planned)
│   └── plugin-schema/  # Schema plugin (planned)
├── features/           # BDD feature files
├── types/              # Shared TypeScript types
└── project/            # Documentation and examples
```

## Contributing

We use GitHub Flow for development:

1. Create a feature branch from `develop`
2. Make your changes with tests
3. Create a PR to `develop`
4. After review, merge to `develop`
5. Periodically, `develop` is merged to `main`

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines.

## Roadmap

- [x] Basic static mocking with GET requests
- [x] Support for all HTTP methods (POST, PUT, DELETE, PATCH)
- [x] Dynamic route patterns (e.g., `/api/users/:id`)
- [x] State management between requests
- [x] Fluent API with core functionality
- [x] Custom status codes and headers
- [ ] Schema-based data generation
- [ ] Plugin system implementation
- [ ] Express middleware adapter
- [ ] Request validation
- [ ] Response delays and error simulation
- [ ] GraphQL support
- [ ] WebSocket support

## License

MIT
