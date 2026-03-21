# Testing Patterns

Schmock's callable API makes it ideal for testing — no HTTP server needed, no network latency, full control over responses.

## Unit Tests with Vitest

### Basic setup

```typescript
import { schmock } from '@schmock/core'
import { describe, it, expect, beforeEach } from 'vitest'

describe('UserService', () => {
  let mock: Schmock.CallableMockInstance

  beforeEach(() => {
    mock = schmock({ state: { users: [] } })

    mock('GET /users', ({ state }) => state.users)
    mock('POST /users', ({ body, state }) => {
      const user = { id: state.users.length + 1, ...body }
      state.users.push(user)
      return [201, user]
    })
    mock('GET /users/:id', ({ params, state }) => {
      const user = state.users.find(u => u.id === Number(params.id))
      return user || [404, { error: 'Not found' }]
    })
  })

  it('creates and retrieves a user', async () => {
    const created = await mock.handle('POST', '/users', {
      body: { name: 'Alice', email: 'alice@example.com' },
    })
    expect(created.status).toBe(201)
    expect(created.body.id).toBe(1)

    const fetched = await mock.handle('GET', '/users/1')
    expect(fetched.body.name).toBe('Alice')
  })

  it('returns 404 for missing user', async () => {
    const res = await mock.handle('GET', '/users/999')
    expect(res.status).toBe(404)
  })
})
```

### Asserting request history

```typescript
it('tracks all requests', async () => {
  await mock.handle('POST', '/users', { body: { name: 'Alice' } })
  await mock.handle('POST', '/users', { body: { name: 'Bob' } })

  expect(mock.callCount('POST', '/users')).toBe(2)
  expect(mock.lastRequest('POST', '/users')?.body).toEqual({ name: 'Bob' })

  const history = mock.history('POST', '/users')
  expect(history[0].body).toEqual({ name: 'Alice' })
})
```

### Testing with validation

```typescript
import { validationPlugin } from '@schmock/validation'

beforeEach(() => {
  mock = schmock()

  mock('POST /users', ({ body }) => [201, body])
    .pipe(validationPlugin({
      request: {
        body: {
          type: 'object',
          required: ['name', 'email'],
          properties: {
            name: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email' },
          },
        },
      },
    }))
})

it('rejects invalid request bodies', async () => {
  const res = await mock.handle('POST', '/users', {
    body: { name: '' },
  })
  expect(res.status).toBe(400)
  expect(res.body.code).toBe('REQUEST_VALIDATION_ERROR')
})

it('accepts valid request bodies', async () => {
  const res = await mock.handle('POST', '/users', {
    body: { name: 'Alice', email: 'alice@example.com' },
  })
  expect(res.status).toBe(201)
})
```

## OpenAPI-Based Tests

Test against real API contracts:

```typescript
import { openapi } from '@schmock/openapi'

describe('Petstore API', () => {
  let mock: Schmock.CallableMockInstance

  beforeAll(async () => {
    mock = schmock({ state: {} })
    mock.pipe(await openapi({
      spec: './petstore.yaml',
      seed: { pets: [{ petId: 1, name: 'Rex', tag: 'dog' }] },
      validateRequests: true,
    }))
  })

  it('lists pets', async () => {
    const res = await mock.handle('GET', '/pets')
    expect(res.status).toBe(200)
    expect(res.body).toBeInstanceOf(Array)
    expect(res.body[0]).toHaveProperty('petId')
  })

  it('creates a pet', async () => {
    const res = await mock.handle('POST', '/pets', {
      body: { name: 'Buddy', tag: 'dog' },
    })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Buddy')
  })

  it('deletes a pet', async () => {
    const res = await mock.handle('DELETE', '/pets/1')
    expect(res.status).toBe(204)
  })

  it('returns 404 for deleted pet', async () => {
    const res = await mock.handle('GET', '/pets/1')
    expect(res.status).toBe(404)
  })
})
```

## Testing with Express

Use `supertest` with the Express adapter:

```typescript
import express from 'express'
import request from 'supertest'
import { schmock } from '@schmock/core'
import { toExpress } from '@schmock/express'

describe('Express integration', () => {
  let app: express.Express

  beforeEach(() => {
    const mock = schmock()
    mock('GET /users', [{ id: 1, name: 'Alice' }])
    mock('POST /users', ({ body }) => [201, { id: 2, ...body }])

    app = express()
    app.use(express.json())
    app.use('/api', toExpress(mock))
  })

  it('GET /api/users', async () => {
    const res = await request(app).get('/api/users')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
  })

  it('POST /api/users', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({ name: 'Bob' })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Bob')
  })
})
```

## Testing with Angular

### TestBed setup

```typescript
import { TestBed } from '@angular/core/testing'
import { HttpClient, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http'
import { HTTP_INTERCEPTORS } from '@angular/common/http'
import { schmock } from '@schmock/core'
import { createSchmockInterceptor } from '@schmock/angular'

describe('UserService', () => {
  let http: HttpClient
  let mock: Schmock.CallableMockInstance

  beforeEach(() => {
    mock = schmock()
    mock('GET /api/users', [{ id: 1, name: 'Alice' }])

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        {
          provide: HTTP_INTERCEPTORS,
          useClass: createSchmockInterceptor(mock, { baseUrl: '/api' }),
          multi: true,
        },
      ],
    })

    http = TestBed.inject(HttpClient)
  })

  it('fetches users', (done) => {
    http.get<any[]>('/api/users').subscribe(users => {
      expect(users).toHaveLength(1)
      expect(users[0].name).toBe('Alice')
      done()
    })
  })
})
```

### OpenAPI-driven Angular tests

```typescript
import { provideSchmockInterceptorFromSpec } from '@schmock/angular'

beforeEach(async () => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptorsFromDi()),
      await provideSchmockInterceptorFromSpec(
        { spec: './api.yaml', seed: { users: { count: 5 } } },
        { baseUrl: '/api' },
      ),
    ],
  })
})
```

## Testing Error Scenarios

```typescript
describe('error handling', () => {
  let mock: Schmock.CallableMockInstance

  beforeEach(() => {
    mock = schmock()
    mock('GET /flaky', () => [500, { error: 'Internal server error' }])
    mock('GET /timeout', () => [504, { error: 'Gateway timeout' }])
    mock('POST /validate', ({ body }) => {
      if (!body?.name) return [400, { error: 'name is required' }]
      return [201, body]
    })
  })

  it('handles 500 errors', async () => {
    const res = await mock.handle('GET', '/flaky')
    expect(res.status).toBe(500)
  })

  it('handles missing routes', async () => {
    const res = await mock.handle('GET', '/nonexistent')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('ROUTE_NOT_FOUND')
  })
})
```

## Testing with Query Features

```typescript
import { queryPlugin } from '@schmock/query'

describe('paginated list', () => {
  let mock: Schmock.CallableMockInstance

  beforeEach(() => {
    const users = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      name: `User ${i + 1}`,
      role: i % 3 === 0 ? 'admin' : 'user',
    }))

    mock = schmock()
    mock('GET /users', () => users)
      .pipe(queryPlugin({
        pagination: { defaultLimit: 10 },
        sorting: { allowed: ['name', 'id'] },
        filtering: { allowed: ['role'] },
      }))
  })

  it('paginates results', async () => {
    const res = await mock.handle('GET', '/users', {
      query: { page: '2', limit: '10' },
    })
    expect(res.body.data).toHaveLength(10)
    expect(res.body.pagination.page).toBe(2)
    expect(res.body.pagination.total).toBe(25)
  })

  it('filters by role', async () => {
    const res = await mock.handle('GET', '/users', {
      query: { 'filter[role]': 'admin' },
    })
    expect(res.body.data.every(u => u.role === 'admin')).toBe(true)
  })

  it('sorts by name descending', async () => {
    const res = await mock.handle('GET', '/users', {
      query: { sort: 'name', order: 'desc' },
    })
    const names = res.body.data.map(u => u.name)
    expect(names).toEqual([...names].sort().reverse())
  })
})
```

## Tips

- Use `mock.resetState()` in `beforeEach` if you share a mock instance across tests but need fresh state
- Use `fakerSeed` in OpenAPI tests for deterministic data
- Use `mock.listen(0)` when you need a real HTTP server — port 0 picks a random available port
- Use `mock.history()` to verify the exact requests your code made, not just the responses
