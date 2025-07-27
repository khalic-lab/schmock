# Schmock 🎭

> Schema-driven mock API generator with business constraints

## Overview

Schmock is a powerful mock API generator that allows you to quickly create predictable, schema-driven mock endpoints for frontend development. Unlike traditional mock servers, Schmock is designed with extensibility in mind through its plugin system.

## Features

- 🚀 **Quick Setup**: Get a mock API running in under 30 seconds
- 📋 **Schema-Driven**: Use JSON Schema to define your data structures
- 🔌 **Plugin System**: Extend functionality with custom plugins
- 🎯 **Type-Safe**: Full TypeScript support with ambient types
- 🧪 **BDD/TDD Ready**: Built with testing in mind
- 🏗️ **Monorepo Structure**: Organized for scalability

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
import { Schmock } from '@schmock/core'

// Define your mock API configuration
const config = {
  routes: {
    '/api/users': {
      data: [
        { id: 1, name: 'John Doe', email: 'john@example.com' },
        { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
      ]
    },
    '/api/users/1': {
      data: { id: 1, name: 'John Doe', email: 'john@example.com' }
    }
  }
}

// Create a Schmock instance
const schmock = new Schmock(config)

// Make requests
const response = await schmock.get('/api/users')
console.log(response.status) // 200
console.log(response.body) // [{ id: 1, name: 'John Doe', ... }, ...]
```

### Simple String Response

```typescript
const schmock = new Schmock({
  routes: {
    '/api/status': 'OK',
    '/api/version': '1.0.0'
  }
})

const response = await schmock.get('/api/status')
console.log(response.body) // 'OK'
```

### Handling 404s

```typescript
const schmock = new Schmock({
  routes: {
    '/api/users': { data: [] }
  }
})

const response = await schmock.get('/api/unknown')
console.log(response.status) // 404
console.log(response.body) // { error: 'Not Found' }
```

## Advanced Usage

### With Express/HTTP Server (Coming Soon)

```typescript
import express from 'express'
import { createSchmockMiddleware } from '@schmock/express'

const app = express()
const schmock = new Schmock(config)

app.use('/mock', createSchmockMiddleware(schmock))
app.listen(3000)
```

### Schema-Based Generation (Coming Soon)

```typescript
import { Schmock } from '@schmock/core'
import { SchemaPlugin } from '@schmock/plugin-schema'

const schmock = new Schmock({
  routes: {
    '/api/users': {
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
  }
})

schmock.use(new SchemaPlugin())
```

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
│   ├── core/           # Core Schmock functionality
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
- [ ] Support for all HTTP methods (POST, PUT, DELETE, PATCH)
- [ ] Dynamic route patterns (e.g., `/api/users/:id`)
- [ ] Schema-based data generation
- [ ] Plugin system implementation
- [ ] Express middleware adapter
- [ ] Request validation
- [ ] Response delays and error simulation
- [ ] State management between requests
- [ ] GraphQL support

## License

MIT