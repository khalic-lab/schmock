# Testing Patterns

Schmock's callable API makes it ideal for testing — no HTTP server needed, no network latency, full control over responses.

## Unit Tests with Vitest

### Basic setup

```typescript
import { schmock } from '@schmock/core'
import { describe, it, expect, beforeEach } from 'vitest'

// State and request bodies are typed `unknown`, so narrow them before use.
type User = { id: number; name?: string; email?: string }
const isUsers = (value: unknown): value is User[] => Array.isArray(value)

describe('UserService', () => {
  let mock: Schmock.CallableMockInstance

  beforeEach(() => {
    mock = schmock({ state: { users: [] } })

    mock('GET /users', ({ state }) => state.users)
    mock('POST /users', ({ body, state }) => {
      if (!isUsers(state.users)) return [500, { error: 'Invalid state' }]
      const input = typeof body === 'object' && body !== null ? body : {}
      const user = { id: state.users.length + 1, ...input }
      state.users.push(user)
      return [201, user]
    })
    mock('GET /users/:id', ({ params, state }) => {
      const users = isUsers(state.users) ? state.users : []
      const user = users.find((u) => u.id === Number(params.id))
      return user || [404, { error: 'Not found' }]
    })
  })

  it('creates and retrieves a user', async () => {
    const created = await mock.handle('POST', '/users', {
      body: { name: 'Alice', email: 'alice@example.com' },
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ id: 1 })

    const fetched = await mock.handle('GET', '/users/1')
    expect(fetched.body).toMatchObject({ name: 'Alice' })
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

  mock.pipe(validationPlugin({
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
  mock('POST /users', ({ body }) => [201, body])
})

it('rejects invalid request bodies', async () => {
  const res = await mock.handle('POST', '/users', {
    body: { name: '' },
  })
  expect(res.status).toBe(400)
  expect(res.body).toMatchObject({ code: 'REQUEST_VALIDATION_ERROR' })
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
    expect(res.body).toEqual([expect.objectContaining({ petId: 1 })])
  })

  it('creates a pet', async () => {
    const res = await mock.handle('POST', '/pets', {
      body: { name: 'Buddy', tag: 'dog' },
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ name: 'Buddy' })
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

The seed row and the `petId` assertion assume this
petstore's `Pet` schema declares `petId`. The plugin stores and returns a
resource's [id property](./openapi.md#identifiers): the path parameter's name
only when the item schema declares it, otherwise `id`. For a `Pet` that declares
`id`, seed `{ id: 1, … }` and assert on `id`.

A file-path `spec` (`'./petstore.yaml'`), and any relative external `$ref`s
it has with `refs: { external: true }`, is read from disk in jsdom and
happy-dom test environments too, not fetched relative to `window.location`.

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
    mock('POST /users', ({ body }) => {
      // The request body is typed `unknown`, so narrow it before spreading.
      const input = typeof body === 'object' && body !== null ? body : {}
      return [201, { id: 2, ...input }]
    })

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
import { schmock } from '@schmock/core'
import { provideSchmockInterceptor } from '@schmock/angular'

describe('UserService', () => {
  let http: HttpClient
  let mock: Schmock.CallableMockInstance

  beforeEach(() => {
    mock = schmock()
    // Register the route WITHOUT the baseUrl prefix — see the note below.
    mock('GET /users', [{ id: 1, name: 'Alice' }])

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideSchmockInterceptor(mock, { baseUrl: '/api' }),
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

Two things differ from the other adapters:

- The Angular adapter's `baseUrl` both filters requests **and strips** the
  prefix before route lookup, so `/api/users` is matched against the route
  `GET /users`. (Core's `mock.intercept()` filters without stripping — routes
  there keep the prefix.)
- Use `provideSchmockInterceptor`, not a hand-written
  `{ provide: HTTP_INTERCEPTORS, useClass: ... }` entry. The interceptor class
  is built at runtime, so `useClass` fails with NG0204 ("needs JIT compiler")
  in AOT builds; the helper provides it with `useFactory` instead.

### OpenAPI-driven Angular tests

What works depends on where the tests run.

Under a Node test runner (Vitest, Jest, jsdom or happy-dom included),
`provideSchmockInterceptorFromSpec` builds the mock for you, and a spec file
path is read from disk. A relative `fetch('/assets/api.json')` does not work
there: Node has no page origin to resolve it against.

```typescript
import { provideSchmockInterceptorFromSpec } from '@schmock/angular'

beforeEach(async () => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptorsFromDi()),
      await provideSchmockInterceptorFromSpec(
        { spec: './src/assets/api.json', seed: { users: { count: 5 } } },
        { baseUrl: '/api' },
      ),
    ],
  })
})
```

Under Karma or another browser runner the tests are a bundled browser app. The
`FromSpec` helpers reject there with `OPENAPI_PEER_UNAVAILABLE` unless you
hand them your own `openapi` import as the third argument (see
[the Angular guide](./angular.md#the-fromspec-helpers)), and a file path
throws `OPENAPI_NODE_ONLY` (see
[Running in a browser](./openapi.md#running-in-a-browser)). Pass the spec
fetched or imported as JSON, and either hand the helper `{ openapi }` or pipe
the plugin into a mock yourself:

```typescript
import { schmock } from '@schmock/core'
import { openapi } from '@schmock/openapi'
import { provideSchmockInterceptor } from '@schmock/angular'

beforeEach(async () => {
  const spec: object = await fetch('/assets/api.json').then((res) => res.json())
  const mock = schmock({ state: {} })
  mock.pipe(await openapi({ spec, seed: { users: { count: 5 } } }))
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptorsFromDi()),
      provideSchmockInterceptor(mock, { baseUrl: '/api' }),
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
      const hasName =
        typeof body === 'object' && body !== null && 'name' in body && !!body.name
      if (!hasName) return [400, { error: 'name is required' }]
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
    expect(res.body).toMatchObject({ code: 'ROUTE_NOT_FOUND' })
  })
})
```

## Testing with Query Features

```typescript
import { queryPlugin } from '@schmock/query'

type User = { id: number; name: string; role: string }
type UserPage = { data: User[]; pagination: { page: number; total: number } }

// A response body is typed `unknown`; narrow it once, in one place.
function pageOf(body: unknown): UserPage {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new Error('expected a paginated body')
  }
  return body as UserPage
}

describe('paginated list', () => {
  let mock: Schmock.CallableMockInstance

  beforeEach(() => {
    const users = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      name: `User ${i + 1}`,
      role: i % 3 === 0 ? 'admin' : 'user',
    }))

    mock = schmock()
    // Plugins apply to every route on the mock, not only to one route.
    mock.pipe(queryPlugin({
      pagination: { defaultLimit: 10 },
      sorting: { allowed: ['name', 'id'] },
      filtering: { allowed: ['role'] },
    }))
    mock('GET /users', () => users)
  })

  it('paginates results', async () => {
    const res = await mock.handle('GET', '/users', {
      query: { page: '2', limit: '10' },
    })
    const page = pageOf(res.body)
    expect(page.data).toHaveLength(10)
    expect(page.pagination.page).toBe(2)
    expect(page.pagination.total).toBe(25)
  })

  it('filters by role', async () => {
    const res = await mock.handle('GET', '/users', {
      query: { 'filter[role]': 'admin' },
    })
    expect(pageOf(res.body).data.every((u) => u.role === 'admin')).toBe(true)
  })

  it('sorts by name descending', async () => {
    const res = await mock.handle('GET', '/users', {
      query: { sort: 'name', order: 'desc' },
    })
    const names = pageOf(res.body).data.map((u) => u.name)
    expect(names).toEqual([...names].sort().reverse())
  })
})
```

## Tips

- Use `mock.resetState()` in `beforeEach` if you share a mock instance across tests but need fresh state
- Use `fakerSeed` in OpenAPI tests for deterministic data
- Use `mock.listen(0)` when you need a real HTTP server — port 0 picks a random available port
- Use `mock.history()` to verify the exact requests your code made, not just the responses

## Repository Quality Gates

Run the complete local verification matrix before submitting a change:

```bash
bun run test:all
bun run test:e2e
bun run lint
bun run eslint
bun run knip
bun run build
```

BDD step definitions are also compiled under the repository's strict TypeScript
configuration. Run that gate alone while editing scenarios or steps:

```bash
bun run typecheck:bdd
```

The root `typecheck` and CI typecheck jobs include this BDD gate automatically.

Unit and BDD suites of every package resolve sibling `@schmock/*` imports to
`../<pkg>/src` through `resolve.alias` in `vitest.config.ts` and
`vitest.config.bdd.ts`, so they test source without a build. Only the tests
that load `dist` by file path need `bun run build` first: `dist-shape.test.ts`
in core and angular, and in openapi `browser-compat.test.ts`,
`browser-bundle.test.ts`, `entry-parity.test.ts` and
`steps/openapi-browser-build.steps.ts`.

The `@schmock/devtools` service-worker relay is tested without a browser.
`packages/devtools/src/test-support/relay-harness.ts` fakes only the
service-worker objects in process (the registration lifecycle, scope matching,
claims, the client message queue, fetch events and Cache Storage) on top of
Node's real `MessageChannel`, `Request`, `Response` and `AbortController`. Its
self-test, `relay-harness.test.ts`, pins each modelled behaviour before the
worker and page tests rely on it. The harness forwards a page's abort to the
worker's request signal. In real Chrome the mock did not see the abort, so the
499 that the abort scenarios assert is the harness's behaviour, not Chrome's.
What only a real browser shows (Network rows, browser default headers, hard
reload, abort) was checked once by hand in headless Chrome over the DevTools
protocol, and the results are recorded in
[DevTools](./devtools.md#network-panel-relay) as *observed*. That check is not
committed and does not run in CI.

Package manifests, exports, build output, or release changes also require the
packed release-candidate gate:

```bash
bun run check:publish
```

It first runs `check:manifests` (publish shape per package: `files`, `license`,
`repository`, `homepage`, `bugs`, `engines`, README, and script symmetry), then
verifies clean/repeated build equality and stale-artifact removal, packs all
12 workspaces, runs Node and Bun consumers, compiles 15 strict standalone
declaration entries, compiles packed Core declarations with TypeScript 5.6,
checks React root/testing context identity, exercises the CLI and browser
bundle, runs the release-script tests, and runs `publint` plus `attw`.

Both browser stages bundle with esbuild (`--platform=browser --external:node:*
--metafile`) and run `scripts/check-browser-node-imports.mjs`, which reads each
external import's `kind` from the metafile. It fails on any external Node
built-in outside the allowlist, and on an allowlisted one reached any way other
than a lazy `import()`: a static `import` or a `require` of it breaks Angular's
application builder, which externalises nothing. The allowlist holds only
`node:http`, core's lazy `listen()` import. A bare built-in such as `path` or
`util` fails the esbuild bundle itself.

## Releasing

One command runs every release check without touching npm, the remote, or
GitHub:

```bash
bun run publish
```

It runs the release preflight (12 synchronized manifests, `bun.lock` parity, a
clean worktree on canonical `main`), then the quality gate in this order:
`lint`, `eslint`, `knip`, `bun audit --audit-level=high`, `build`, `test:all`,
`test:e2e` and `check:publish`. It refuses to go on if those checks changed
the worktree, then prints the release plan and the exact execute command:

```bash
bun run publish -- all --execute --confirm all@vX.Y.Z:<40-char-commit>
```

It also prints the checks to run once npm serves the release, which install
the published packages from the public registry:

```bash
SCHMOCK_VERSION=X.Y.Z bun run test:smoke
SCHMOCK_VERSION=X.Y.Z bun run test:consumer
```

The confirmation token names the version and the release commit so that the
person releasing affirms both; nothing derives it for you. Any arguments are
passed through to `.agents/skills/devops/scripts/publish.sh`, which owns the
guarantees and runs the same quality gate before it publishes: it skips a
package only when npm reports the same package contents already published, and
it pushes `main` and creates one unified `vX.Y.Z` release after all 12
packages are published. Publishing a single package (`bun run publish --
openapi --execute ...`) refuses unless npm already has every `@schmock/*`
dependency and peer of that package at the same version, since the package
could not be installed otherwise; it neither pushes nor creates a release.
