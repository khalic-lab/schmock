# OpenAPI Auto-Mocking

The `@schmock/openapi` plugin parses an OpenAPI (or Swagger 2.0) spec and auto-registers routes with CRUD behavior, schema-generated responses, security validation, and more.

```sh
bun install @schmock/openapi
```

## Basic Usage

```typescript
import { schmock } from '@schmock/core'
import { openapi } from '@schmock/openapi'

const mock = schmock({ state: {} })

mock.pipe(await openapi({
  spec: './petstore.yaml',
}))

// All routes from the spec are now registered
await mock.handle('GET', '/pets')
await mock.handle('POST', '/pets', { body: { name: 'Rex' } })
```

The spec can be a file path (YAML or JSON) or an inline object:

```typescript
mock.pipe(await openapi({
  spec: {
    openapi: '3.0.3',
    info: { title: 'My API', version: '1.0.0' },
    paths: {
      '/items': {
        get: {
          responses: {
            '200': {
              description: 'List items',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } }
                }
              }
            }
          }
        }
      }
    }
  }
}))
```

## Options

```typescript
openapi({
  spec: './api.yaml',          // required: file path or inline object
  seed: { ... },               // pre-populate resources with data
  validateRequests: true,      // validate request bodies against spec schemas
  validateResponses: true,     // validate generated responses against spec schemas
  security: true,              // enforce security schemes (API key, Bearer, Basic)
  fakerSeed: 42,               // deterministic data generation
  debug: true,                 // log CRUD detection decisions
  schemas: { ... },            // replace response schemas for specific routes
  onSchema: (schema, ctx) => { ... },  // modify schemas before generation
  resources: { ... },          // override CRUD detection per resource
  queryFeatures: {             // enable query features for list endpoints
    pagination: true,
    sorting: true,
    filtering: true,
  },
})
```

## CRUD Detection

The plugin analyzes path patterns to detect CRUD resources. Given a spec with `/users` and `/users/{id}`, it auto-detects a "users" resource and registers:

| Operation | Route | Behavior |
|-----------|-------|----------|
| List | `GET /users` | Returns the in-memory collection |
| Create | `POST /users` | Adds to collection, returns 201 |
| Read | `GET /users/:id` | Finds by ID, returns 404 if missing |
| Update | `PUT /users/:id` | Merges with existing, returns 404 if missing |
| Patch | `PATCH /users/:id` | Merges with existing, returns 404 if missing |
| Delete | `DELETE /users/:id` | Removes from collection, returns 204 |

Non-CRUD routes (e.g., `GET /health`, `POST /auth/login`) get schema-generated static responses.

## Seed Data

Pre-populate CRUD resources so list/read operations return data immediately:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  seed: {
    // Inline array — objects must include the ID field from the spec
    users: [
      { userId: 1, name: 'Alice', email: 'alice@example.com' },
      { userId: 2, name: 'Bob', email: 'bob@example.com' },
    ],

    // Auto-generate from schema
    posts: { count: 50 },

    // Load from file
    products: './fixtures/products.json',
  },
}))
```

The ID field name comes from the spec's path parameter. If your spec defines `/users/{userId}`, seed objects need a `userId` field.

## Prefer Header

The `Prefer` header lets clients control responses at request time:

### `Prefer: code=N` — Force a specific status code

```typescript
const res = await mock.handle('POST', '/users', {
  body: { name: 'Alice' },
  headers: { prefer: 'code=201' },
})
// Returns the 201 response schema from the spec
```

### `Prefer: dynamic=true` — Regenerate from schema

```typescript
const res = await mock.handle('GET', '/users', {
  headers: { prefer: 'dynamic=true' },
})
// Generates fresh fake data from the response schema every time
```

### `Prefer: example=name` — Return a named example

```typescript
const res = await mock.handle('GET', '/users', {
  headers: { prefer: 'example=admin-user' },
})
// Returns the "admin-user" example from the spec
```

## Security Validation

When `security: true`, the plugin enforces security schemes defined in the spec:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  security: true,
}))

// Missing auth → 401
const res = await mock.handle('GET', '/protected-resource')
// → { status: 401, body: { error: 'Unauthorized', code: 'UNAUTHORIZED' } }

// With auth → success
const res = await mock.handle('GET', '/protected-resource', {
  headers: { authorization: 'Bearer my-token' },
})
```

Supported schemes: Bearer, Basic, API Key (header), OAuth2, OpenID Connect.

## Content Negotiation

The plugin validates `Accept` headers against content types defined in the spec:

```typescript
const res = await mock.handle('GET', '/users', {
  headers: { accept: 'text/xml' },
})
// → { status: 406, body: { error: 'Not Acceptable', acceptable: ['application/json'] } }
```

## Request Validation

Validate request bodies against the spec's `requestBody` schema:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  validateRequests: true,
}))

const res = await mock.handle('POST', '/users', {
  body: { invalid: 'data' },
})
// → { status: 400, body: { error: 'Request validation failed', code: 'VALIDATION_ERROR', details: [...] } }
```

## Schema Patching

### `schemas` option — Replace schemas at install time

When a spec has missing or incomplete schemas, provide replacements keyed by `"METHOD /path"` or `"METHOD /path STATUS"`:

```typescript
mock.pipe(await openapi({
  spec: './incomplete-api.yaml',
  schemas: {
    // Replace the 200 response schema for GET /items
    'GET /items': {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          price: { type: 'number' },
        },
      },
    },

    // Target a specific status code
    'POST /items 201': {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
  },
}))
```

Without a status code, the schema replaces the first 2xx response. If no 2xx response exists, a 200 entry is created.

The user schema **replaces** the parsed schema entirely (no deep merge). This is applied before route registration, so both CRUD and non-CRUD routes benefit.

### `onSchema` callback — Modify schemas per request

For dynamic schema modification based on request context:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  onSchema: (schema, context) => {
    // Add properties to empty schemas
    if (!schema.properties && context.path === '/items') {
      return {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
        },
      }
    }

    // Return undefined to keep the original schema
  },
}))
```

The callback receives the schema and a context object with `method`, `path`, `params`, `query`, and `headers`. It works with both static responses and Prefer header-driven dynamic generation.

**Use cases:**
- Fill gaps in incomplete specs
- Return different schemas based on query parameters
- Add fields that the spec doesn't define
- Test schema evolution scenarios

## Resource Overrides

Override CRUD detection decisions per resource:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  resources: {
    users: {
      listWrapProperty: 'data',      // list response wraps items in { data: [...] }
      errorSchema: {                  // custom error response format
        type: 'object',
        properties: {
          message: { type: 'string' },
          status: { type: 'integer' },
        },
      },
    },
    posts: {
      listFlat: true,                 // force flat array response (no wrapper)
    },
  },
}))
```

## Deterministic Generation

Use `fakerSeed` for reproducible data:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  fakerSeed: 42,
}))

// Same seed → same data every time
```

## Real-World Examples

### Frontend Development

Mock your backend API while the real one is under development:

```typescript
const mock = schmock({ state: {} })
mock.pipe(await openapi({
  spec: './api/openapi.yaml',
  seed: {
    users: { count: 20 },
    products: './fixtures/products.json',
  },
  security: true,
  fakerSeed: 1,
}))

const server = await mock.listen(4000)
// Point your frontend at http://localhost:4000
```

### Integration Testing

```typescript
import { describe, it, expect, beforeAll } from 'vitest'

let mock: Schmock.CallableMockInstance

beforeAll(async () => {
  mock = schmock({ state: {} })
  mock.pipe(await openapi({
    spec: './openapi.yaml',
    seed: { users: [{ userId: 1, name: 'Test User' }] },
    validateRequests: true,
    security: true,
  }))
})

it('rejects unauthenticated requests', async () => {
  const res = await mock.handle('GET', '/users')
  expect(res.status).toBe(401)
})

it('returns seeded data with valid auth', async () => {
  const res = await mock.handle('GET', '/users', {
    headers: { authorization: 'Bearer test-token' },
  })
  expect(res.status).toBe(200)
  expect(res.body).toHaveLength(1)
  expect(res.body[0].name).toBe('Test User')
})

it('validates request bodies', async () => {
  const res = await mock.handle('POST', '/users', {
    body: {},
    headers: { authorization: 'Bearer test-token' },
  })
  expect(res.status).toBe(400)
  expect(res.body.code).toBe('VALIDATION_ERROR')
})
```

### CLI Server for QA

```sh
schmock ./api.yaml --port 8080 --cors --seed ./qa-data.json
```

See the [CLI guide](./cli.md) for more details.

## Debug Mode

Enable `debug: true` to see CRUD detection decisions:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  debug: true,
}))
```

Output:
```
[@schmock/openapi] Detected 3 CRUD resources, 2 static routes
[@schmock/openapi] users: list=wrapped("data"), error=schema(404), headers=0
[@schmock/openapi] posts: list=flat, error=default, headers=0
[@schmock/openapi] tags: list=flat, error=default, headers=0
```
