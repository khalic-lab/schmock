# Schmock 🎭

> Schema-driven mock API generator with direct callable API and plugin pipeline

## Overview

Schmock is a mock API generator that allows you to quickly create predictable, schema-driven mock endpoints for frontend development. With its direct callable API, you can define mocks with minimal boilerplate and maximum expressiveness. 

## Features

- 🚀 **Quick Setup**: Get a mock API running in under 30 seconds
- ✨ **Direct API**: Callable instances with zero boilerplate
- 📋 **Schema-Driven**: Use JSON Schema to define your data structures
- 🎯 **Type-Safe**: Full TypeScript support with ambient types
- 🔄 **Stateful Mocks**: Maintain state between requests
- 🔧 **Plugin Pipeline**: Extensible `.pipe()` architecture

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

// Create a mock API with global configuration
const mock = schmock({ debug: true, namespace: '/api' })

// Define routes directly - no build() needed!
mock('GET /users', () => [
  { id: 1, name: 'John Doe', email: 'john@example.com' },
  { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
], { contentType: 'application/json' })

mock('GET /users/:id', ({ params }) => {
  const users = [
    { id: 1, name: 'John Doe', email: 'john@example.com' },
    { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
  ]
  return users.find(u => u.id === Number(params.id)) || [404, { error: 'User not found' }]
}, { contentType: 'application/json' })

// Make requests immediately
const response = await mock.handle('GET', '/api/users')
console.log(response.status) // 200
console.log(response.body) // [{ id: 1, name: 'John Doe', ... }, ...]

// With parameters
const userResponse = await mock.handle('GET', '/api/users/1')
console.log(userResponse.body) // { id: 1, name: 'John Doe', ... }
```

### Plugin Pipeline with .pipe()

```typescript
import { schmock } from '@schmock/core'
import { schemaPlugin } from '@schmock/schema'
import { validationPlugin } from '@schmock/validation'

const mock = schmock({ debug: true })

// Chain plugins with .pipe() - clean and expressive
mock('GET /users', userSchema, { contentType: 'application/json' })
  .pipe(schemaPlugin())
  .pipe(validationPlugin())
  .pipe(loggingPlugin())

mock('POST /users', createUserGenerator, { contentType: 'application/json' })
  .pipe(validationPlugin())
  .pipe(persistencePlugin())
```

### Stateful Mocks

```typescript
// Initialize mock with global state
const mock = schmock({ 
  state: { users: [] },
  debug: true 
})

mock('GET /users', ({ state }) => state.users, { 
  contentType: 'application/json' 
})

mock('POST /users', ({ body, state }) => {
  const newUser = { 
    id: Date.now(), 
    ...body, 
    createdAt: new Date().toISOString() 
  }
  state.users.push(newUser)
  return [201, newUser]
}, { contentType: 'application/json' })

mock('DELETE /users/:id', ({ params, state }) => {
  const index = state.users.findIndex(u => u.id === Number(params.id))
  if (index === -1) return [404, { error: 'User not found' }]
  state.users.splice(index, 1)
  return [204, null]
}, { contentType: 'application/json' })

// Use immediately
const created = await mock.handle('POST', '/users', {
  body: { name: 'Alice', email: 'alice@example.com' }
})
console.log(created.status) // 201
```

### Generator Functions vs Static Data

```typescript
const mock = schmock()

// Generator function - called on each request
mock('GET /time', () => ({ 
  timestamp: new Date().toISOString() 
}), { contentType: 'application/json' })

// Static JSON data - returned as-is
mock('GET /config', {
  version: '1.0.0',
  features: ['auth', 'api', 'websockets']
}, { contentType: 'application/json' })

// Schmock automatically detects the difference based on contentType validation
```

### Custom Status Codes and Headers

```typescript
const mock = schmock()

mock('POST /upload', ({ body }) => [
  201,
  { id: 123, filename: body.name },
  { 'Location': '/api/files/123' }
], { contentType: 'application/json' })

mock('GET /protected', ({ headers }) => {
  if (!headers.authorization) {
    return [401, { error: 'Unauthorized' }]
  }
  return { data: 'secret' }
}, { contentType: 'application/json' })
```

## Advanced Usage

### Query Parameters and Headers

```typescript
const mock = schmock()

mock('GET /search', ({ query }) => ({
  results: [],
  query: query.q,
  page: Number(query.page) || 1
}), { contentType: 'application/json' })

mock('GET /me', ({ headers }) => ({
  authenticated: !!headers.authorization,
  user: headers.authorization ? { id: 1, name: 'John' } : null
}), { contentType: 'application/json' })

// With query parameters
const search = await mock.handle('GET', '/search', {
  query: { q: 'typescript', page: '2' }
})
console.log(search.body) // { results: [], query: 'typescript', page: 2 }

// With headers
const me = await mock.handle('GET', '/me', {
  headers: { authorization: 'Bearer token123' }
})
console.log(me.body.authenticated) // true
```

### Schema-Based Generation

```typescript
import { schmock } from '@schmock/core'
import { schemaPlugin } from '@schmock/schema'

const mock = schmock()

// Define a route with JSON Schema instead of a generator
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
  .pipe(schemaPlugin())

// Generates realistic data automatically
const response = await mock.handle('GET', '/users')
// [{ id: 1, name: "John Doe", email: "john@example.com" }, ...]
```

### Complex Plugin Pipelines

```typescript
import { schmock } from '@schmock/core'
import { schemaPlugin } from '@schmock/schema'
import { validationPlugin } from '@schmock/validation'
import { cachingPlugin } from '@schmock/caching'

const mock = schmock({ 
  debug: true,
  namespace: '/api/v1'
})

// Complex pipeline: validation → schema generation → caching → response
mock('GET /users', userListSchema, { contentType: 'application/json' })
  .pipe(validationPlugin({ strict: true }))
  .pipe(schemaPlugin({ count: 10 }))
  .pipe(cachingPlugin({ ttl: 60000 }))
  
mock('POST /users', createUserHandler, { contentType: 'application/json' })
  .pipe(validationPlugin({ validateBody: true }))
  .pipe(persistencePlugin())
  .pipe(notificationPlugin())
```

### Express Integration

```typescript
import express from 'express'
import { toExpress } from '@schmock/express'

const app = express()
const mock = schmock()

mock('GET /users', () => [{ id: 1, name: 'John' }], {
  contentType: 'application/json'
})

// Convert to Express middleware
app.use('/api', toExpress(mock))
app.listen(3000)
// Now responds at http://localhost:3000/api/users
```

### Angular Integration

**Supports Angular 15-21** with automatic error handling and response helpers.

```typescript
import { ApplicationConfig } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { schmock } from '@schmock/core';
import { createSchmockInterceptor } from '@schmock/angular';

// Create your mock instance
const mock = schmock();

// Define routes with automatic error conversion
mock('GET /api/users/:id', ({ params }) => {
  if (params.id === '999') {
    return [404, { message: 'User not found' }];  // Auto-converts to HttpErrorResponse
  }
  return { id: params.id, name: 'John Doe' };
});

// Use the interceptor in your app config
export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(
      withInterceptors([createSchmockInterceptor(mock)])
    )
  ]
};

// Your HTTP calls work as normal
this.http.get('/api/users/1').subscribe({
  next: (user) => console.log(user),
  error: (err: HttpErrorResponse) => console.error(err)  // 404s handled automatically
});
```

**Response Helpers:**

```typescript
import {
  notFound, badRequest, unauthorized, forbidden, serverError,
  created, noContent, paginate
} from '@schmock/angular';

// Error responses (auto-convert to HttpErrorResponse)
mock('GET /api/users/:id', notFound('User not found'));
mock('POST /api/users', badRequest('Invalid email'));
mock('GET /api/protected', unauthorized('Token expired'));
mock('GET /api/admin', forbidden('Admin access required'));
mock('GET /api/error', serverError('Database connection failed'));

// Success responses
mock('POST /api/users', created({ id: 1, name: 'John' }));
mock('DELETE /api/users/:id', noContent());

// Pagination helper
const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
mock('GET /api/items', ({ query }) =>
  paginate(items, {
    page: parseInt(query.page || '1'),
    pageSize: parseInt(query.pageSize || '10')
  })
);
```

## API Reference

### Factory Function

```typescript
function schmock(config?: GlobalConfig): CallableMockInstance
```

**Global Configuration:**
```typescript
interface GlobalConfig {
  debug?: boolean;          // Enable debug logging
  namespace?: string;       // URL prefix for all routes
  state?: any;             // Initial shared state
  delay?: number | [number, number]; // Response delay (ms)
}
```

### Route Definition

Define routes by calling the mock instance directly:

```typescript
const mock = schmock()

// Basic route definition
mock('GET /users', generatorFunction, routeConfig)
mock('POST /users', staticData, routeConfig)
mock('PUT /users/:id', schemaObject, routeConfig)
mock('DELETE /users/:id', generatorFunction, routeConfig)
```

**Route Configuration:**
```typescript
interface RouteConfig {
  contentType: string;      // 'application/json', 'text/plain', etc.
  // Additional route-specific options...
}
```

### Response Types

Generator functions can return:
- **Direct value**: Returns as 200 OK
- **`[status, body]`**: Custom status code
- **`[status, body, headers]`**: Custom status, body, and headers

### Context Object

Generator functions receive a context with:
- `state`: Shared mutable state
- `params`: Path parameters (e.g., `:id`)
- `query`: Query string parameters
- `body`: Request body
- `headers`: Request headers
- `method`: HTTP method
- `path`: Request path

### Plugin Pipeline

Chain plugins using `.pipe()`:

```typescript
mock('GET /users', generator, config)
  .pipe(plugin1())
  .pipe(plugin2())
  .pipe(plugin3())
```

## Development

This project uses a monorepo structure with Bun workspaces and automated Git hooks for quality assurance.

### Initial Setup

```sh
# Install dependencies
bun install

# Configure Git hooks (recommended for contributors)
bun run setup

# Build packages
bun run build
```

### Testing Commands

```sh
# Run all tests (262 total: 101 unit + 161 BDD)
bun test

# Run comprehensive test suite with typecheck (recommended before commits)
bun test:all

# Run unit tests only (all packages)
bun test:unit

# Run BDD tests only
bun test:bdd

# Type checking
bun run typecheck

# Linting
bun run lint
bun run lint:fix  # Auto-fix issues
```

### Git Hooks (Automated Quality Assurance)

After running `bun run setup`, Git hooks will automatically:

- **Pre-commit**: Run linting and comprehensive tests before allowing commits
- **Commit-msg**: Enforce conventional commit message format

```sh
# Bypass hooks if needed (not recommended)
git commit --no-verify
```

### Project Structure

```
schmock/
├── packages/
│   ├── core/           # Core Schmock functionality with callable API
│   ├── schema/         # Schema plugin for JSON Schema generation
│   ├── express/        # Express middleware adapter
│   └── angular/        # Angular HTTP interceptor adapter
├── features/           # BDD feature files
├── types/              # Shared TypeScript types
├── docs/               # API documentation
└── examples/           # Usage examples
```

## Contributing

We use GitHub Flow with automated quality checks:

### Getting Started
1. **Clone and setup**:
   ```sh
   git clone <repo>
   cd schmock
   bun install
   bun run setup  # Configure Git hooks
   ```

2. **Create feature branch**:
   ```sh
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-feature-name
   ```

3. **Development workflow**:
   - Make your changes with tests
   - Git hooks automatically run linting and tests on commit
   - BDD tests may fail during development (expected for TDD)

4. **Create PR**:
   - Push feature branch to GitHub
   - Create PR from feature → develop
   - CI runs comprehensive checks
   - All tests must pass for main branch PRs

5. **After review**: Merge to develop, then periodically develop → main

### Quality Standards
- **Automatic**: Git hooks enforce linting and test standards
- **Manual override**: Use `git commit --no-verify` only when necessary
- **Comprehensive testing**: BDD for consistent DX, unit and integration

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines and project architecture.


## Trivia

This is a project developped to test LLM agents capabilities using BDD as framework and decided to release the result. It's used for development on a daily basis by me

## Roadmap

- [x] Basic static mocking with GET requests
- [x] Support for all HTTP methods (POST, PUT, DELETE, PATCH)
- [x] Dynamic route patterns (e.g., `/api/users/:id`)
- [x] State management between requests
- [x] Direct callable API with zero boilerplate
- [x] Custom status codes and headers
- [x] Plugin pipeline with `.pipe()` chaining
- [x] Schema-based data generation
- [x] Express middleware adapter
- [x] Angular HTTP interceptor adapter
- [ ] Runtime content-type validation
- [ ] Request/response validation plugins
- [ ] Response delays and error simulation
- [ ] Caching plugin
- [ ] Persistence plugin
- [ ] GraphQL support
- [ ] WebSocket support

## License

MIT
