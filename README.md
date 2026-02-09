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
- 📄 **OpenAPI Auto-Mock**: Throw a swagger.json at it and let it manage the rest

## Packages

| Package | Description |
|---------|-------------|
| `@schmock/core` | Core mock builder, routing, and plugin pipeline |
| `@schmock/faker` | JSON Schema-based response generation plugin |
| `@schmock/validation` | Request/response validation via AJV |
| `@schmock/query` | Pagination, sorting, and filtering for list endpoints |
| `@schmock/openapi` | Auto-register routes from OpenAPI/Swagger specs |
| `@schmock/express` | Express middleware adapter |
| `@schmock/angular` | Angular HTTP interceptor adapter |

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
import { fakerPlugin } from '@schmock/faker'
import { validationPlugin } from '@schmock/validation'

const mock = schmock({ debug: true })

// Chain plugins with .pipe() - clean and expressive
mock('GET /users', userSchema, { contentType: 'application/json' })
  .pipe(fakerPlugin())
  .pipe(validationPlugin())

mock('POST /users', createUserHandler, { contentType: 'application/json' })
  .pipe(validationPlugin())
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
import { fakerPlugin } from '@schmock/faker'

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
  .pipe(fakerPlugin())

// Generates realistic data automatically
const response = await mock.handle('GET', '/users')
// [{ id: 1, name: "John Doe", email: "john@example.com" }, ...]
```

### Request History & Spying

```typescript
const mock = schmock()

mock('GET /users', () => [{ id: 1 }], { contentType: 'application/json' })
mock('POST /users', ({ body }) => [201, body], { contentType: 'application/json' })

await mock.handle('GET', '/users')
await mock.handle('POST', '/users', { body: { name: 'Alice' } })
await mock.handle('GET', '/users')

// Check if a route was called
mock.called('GET', '/users')        // true
mock.callCount('GET', '/users')     // 2

// Get the last request details
mock.lastRequest('POST', '/users')  // { method: 'POST', path: '/users', body: { name: 'Alice' }, ... }

// Full history
mock.history()                      // all recorded requests
mock.history('GET', '/users')       // filtered by method + path
```

### Reset & Lifecycle

```typescript
const mock = schmock({ state: { count: 0 } })

mock.resetHistory()  // clear request history, keep routes and state
mock.resetState()    // reset state to initial values, keep routes and history
mock.reset()         // full reset: routes, history, and state
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

### OpenAPI Auto-Mock

Throw a Swagger/OpenAPI spec at Schmock and get a fully functional CRUD mock API with zero boilerplate. Supports Swagger 2.0, OpenAPI 3.0, and 3.1.

```sh
bun add @schmock/openapi
```

```typescript
import { schmock } from '@schmock/core'
import { openapi } from '@schmock/openapi'

const mock = schmock({ state: {} })

// One line — all routes auto-registered with CRUD behavior
mock.pipe(await openapi({
  spec: './petstore.yaml',
  seed: {
    pets: [
      { petId: 1, name: 'Rex', tag: 'dog' },
      { petId: 2, name: 'Whiskers', tag: 'cat' },
    ]
  }
}))

// Full CRUD lifecycle works out of the box
const created = await mock.handle('POST', '/pets', {
  body: { name: 'Buddy', tag: 'dog' }
})
console.log(created.status) // 201
console.log(created.body)   // { petId: 3, name: 'Buddy', tag: 'dog' }

const list = await mock.handle('GET', '/pets')
console.log(list.body.length) // 3

const read = await mock.handle('GET', '/pets/1')
console.log(read.body.name) // 'Rex'

await mock.handle('DELETE', '/pets/2')
const updated = await mock.handle('GET', '/pets')
console.log(updated.body.length) // 2
```

Stress tested with real-world specs: Petstore, Train Travel API, Scalar Galaxy, and Stripe's 5.8MB API spec (415 endpoints).

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
mock('GET /users', userSchema, { contentType: 'application/json' })
  .pipe(fakerPlugin())
  .pipe(validationPlugin())
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
# Run all tests
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
│   ├── core/           # Core mock builder, routing, plugin pipeline
│   ├── schema/         # JSON Schema-based response generation
│   ├── validation/     # Request/response validation (AJV)
│   ├── query/          # Pagination, sorting, filtering
│   ├── openapi/        # OpenAPI/Swagger auto-mock plugin
│   ├── express/        # Express middleware adapter
│   └── angular/        # Angular HTTP interceptor adapter
├── features/           # BDD feature files
├── types/              # Shared TypeScript types (ambient)
└── docs/               # API documentation
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

This is a project developed to test LLM agents capabilities using BDD as framework and decided to release the result. It's used for development on a daily basis by me

## Roadmap

- [x] Basic static mocking with GET requests
- [x] Support for all HTTP methods (POST, PUT, DELETE, PATCH)
- [x] Dynamic route patterns (e.g., `/api/users/:id`)
- [x] State management between requests
- [x] Direct callable API with zero boilerplate
- [x] Custom status codes and headers
- [x] Plugin pipeline with `.pipe()` chaining
- [x] Schema-based data generation (`@schmock/faker`)
- [x] Express middleware adapter (`@schmock/express`)
- [x] Angular HTTP interceptor adapter (`@schmock/angular`)
- [x] Request spy/history tracking (`called()`, `callCount()`, `lastRequest()`)
- [x] Reset/lifecycle management (`reset()`, `resetHistory()`, `resetState()`)
- [x] Request/response validation plugin (`@schmock/validation`)
- [x] Pagination, sorting, filtering plugin (`@schmock/query`)
- [x] OpenAPI/Swagger auto-mock plugin (`@schmock/openapi`)
- [x] Response delays and error simulation
- [ ] GraphQL support
- [ ] WebSocket support

## License

MIT
