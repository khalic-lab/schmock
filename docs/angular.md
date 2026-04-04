# Angular Adapter

Intercept Angular HTTP calls with Schmock. Unmatched requests pass through to the real backend.

```sh
bun install @schmock/angular
```

## Basic Usage

```typescript
import { schmock } from '@schmock/core'
import { provideSchmockInterceptor } from '@schmock/angular'
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http'

const mock = schmock()
mock('GET /api/users', [{ id: 1, name: 'Alice' }])
mock('POST /api/users', ({ body }) => [201, { id: 2, ...body }])

export const appConfig = {
  providers: [
    provideHttpClient(withInterceptorsFromDi()),
    provideSchmockInterceptor(mock, { baseUrl: '/api' }),
  ],
}
```

Your Angular services call the API normally — Schmock intercepts matching requests:

```typescript
@Injectable({ providedIn: 'root' })
export class UserService {
  constructor(private http: HttpClient) {}

  getUsers() {
    return this.http.get<User[]>('/api/users')
  }

  createUser(user: Partial<User>) {
    return this.http.post<User>('/api/users', user)
  }
}
```

## Options

```typescript
provideSchmockInterceptor(mock, {
  baseUrl: '/api',           // only intercept requests starting with this URL
  passthrough: true,         // pass unmatched requests to the real backend (default: true)

  transformRequest: (request) => ({
    headers: { 'x-tenant': 'dev' },
  }),

  transformResponse: (response, request) => ({
    ...response,
    headers: { ...response.headers, 'x-mock': 'true' },
  }),

  errorFormatter: (error, request) => ({
    message: error.message,
  }),
})
```

### `passthrough`

When `true` (default), requests that don't match any Schmock route are forwarded to the real backend. Set to `false` to return errors for unmatched requests — useful in tests to catch unexpected API calls.

### `baseUrl`

Only intercept requests whose URL starts with this string. The base URL is stripped before matching:

```typescript
// With baseUrl: '/api'
// Request to /api/users → Schmock matches route /users
provideSchmockInterceptor(mock, { baseUrl: '/api' })
```

## OpenAPI-Driven Interceptor

Skip manual route definitions — load everything from a spec:

```typescript
import { provideSchmockInterceptorFromSpec } from '@schmock/angular'

export const appConfig = {
  providers: [
    provideHttpClient(withInterceptorsFromDi()),
    await provideSchmockInterceptorFromSpec(
      { spec: './assets/api.yaml', seed: { users: { count: 10 } } },
      { baseUrl: '/api' },
    ),
  ],
}
```

Or with `createSchmockInterceptorFromSpec` for class-based setup:

```typescript
import { createSchmockInterceptorFromSpec } from '@schmock/angular'

const InterceptorClass = await createSchmockInterceptorFromSpec(
  { spec: './api.yaml' },
  { baseUrl: '/api' },
)

providers: [
  { provide: HTTP_INTERCEPTORS, useClass: InterceptorClass, multi: true },
]
```

## Helper Functions

Utility functions for building responses:

```typescript
import { notFound, badRequest, unauthorized, forbidden, serverError, created, noContent, paginate } from '@schmock/angular'

mock('GET /users/:id', ({ params }) => {
  const user = users.find(u => u.id === Number(params.id))
  return user || notFound('User not found')
})

mock('POST /users', ({ body }) => {
  if (!body?.name) return badRequest('name is required')
  return created({ id: 3, ...body })
})

mock('DELETE /users/:id', () => noContent())

mock('GET /admin', () => forbidden('Admin access only'))
```

### `paginate(items, options?)`

Paginate an array:

```typescript
mock('GET /users', () => {
  return paginate(allUsers, { page: 1, pageSize: 10 })
})
// → { data: [...], page: 1, pageSize: 10, total: 50, totalPages: 5 }
```

## Testing with TestBed

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
          useClass: createSchmockInterceptor(mock),
          multi: true,
        },
      ],
    })

    http = TestBed.inject(HttpClient)
  })

  it('fetches users', (done) => {
    http.get<any[]>('/api/users').subscribe({
      next: (users) => {
        expect(users).toHaveLength(1)
        done()
      },
    })
  })

  it('handles errors', (done) => {
    mock('GET /api/error', () => [500, { message: 'Server error' }])

    http.get('/api/error').subscribe({
      error: (err) => {
        expect(err.status).toBe(500)
        done()
      },
    })
  })
})
```

## Response Behavior

- Status >= 400 → Converted to Angular `HttpErrorResponse`
- Status < 400 → Wrapped in Angular `HttpResponse`
- ROUTE_NOT_FOUND + `passthrough: true` → Request forwarded to real backend
- ROUTE_NOT_FOUND + `passthrough: false` → Error returned
