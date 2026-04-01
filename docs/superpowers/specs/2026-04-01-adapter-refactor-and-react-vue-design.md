# Adapter Refactor + React/Vue Adapters

## Goal

Introduce `@schmock/react` and `@schmock/vue` adapters while refactoring the adapter architecture so all adapters share primitives from core and own their framework-specific facades. Redesign packaging so users install one package for their framework and get everything they need.

## Architecture

### Core Primitives (`@schmock/core`)

Core gains three capabilities that all adapters consume:

**1. `mock.intercept(options?)`**

Patches `globalThis.fetch` to route requests through `mock.handle()`. Returns an object with `restore()` and `active`. This is the client-side equivalent of `mock.listen()`.

```typescript
interface InterceptOptions {
  baseUrl?: string          // only intercept URLs starting with this
  passthrough?: boolean     // default: true — unmatched routes hit real fetch
  beforeRequest?: (request: AdapterRequest) => AdapterRequest | void | Promise<AdapterRequest | void>
  beforeResponse?: (response: AdapterResponse, request: AdapterRequest) => AdapterResponse | void | Promise<AdapterResponse | void>
  errorFormatter?: (error: Error) => unknown
}

interface InterceptHandle {
  restore(): void
  readonly active: boolean
}

// Usage
const handle = mock.intercept({ baseUrl: '/api' })
// ... all fetch() calls now route through Schmock
handle.restore()
```

Works in both browser (`window.fetch`) and Node.js 18+ (`globalThis.fetch`).

**2. Response Helpers**

Extracted from `@schmock/angular` into core. Framework-agnostic utilities:

```typescript
notFound(message?)       // [404, { message }]
badRequest(message?)     // [400, { message }]
unauthorized(message?)   // [401, { message }]
forbidden(message?)      // [403, { message }]
serverError(message?)    // [500, { message }]
created(body)            // [201, body]
noContent()              // [204, null]
paginate(items, options) // { data, page, pageSize, total, totalPages }
```

**3. ROUTE_NOT_FOUND Detection Utility**

A shared helper that adapters import instead of duplicating the detection logic:

```typescript
function isRouteNotFound(response: Schmock.Response): boolean
```

### Adapter Facades

Each adapter package owns its facade — the framework-specific layer that converts between framework types and core primitives.

**`@schmock/express`** — Express middleware facade

- Converts `(req, res, next)` to `AdapterRequest`
- Calls `mock.handle()`
- Uses `isRouteNotFound()` for passthrough via `next()`
- Converts result to Express response
- Imports response helpers from core (re-exports for backwards compat if needed)

**`@schmock/angular`** — Angular HttpInterceptor facade

- Converts `HttpRequest` to `AdapterRequest`
- Calls `mock.handle()`
- Uses `isRouteNotFound()` for passthrough via `next.handle()`
- Converts result to `Observable<HttpEvent>`
- Response helpers move to core; Angular re-exports them

**`@schmock/react`** — React Provider/hooks facade

- `<SchmockProvider mock={mock} options={}>` — calls `mock.intercept()` on mount, `restore()` on unmount
- `useSchmock()` — returns the `CallableMockInstance` from context
- `renderWithSchmock(ui, options)` — test utility wrapping Testing Library's `render`, pre-registers routes, handles cleanup

**`@schmock/vue`** — Vue Plugin/composables facade

- `schmockPlugin` — Vue plugin that calls `mock.intercept()` on install
- `useSchmock()` — composable returning the `CallableMockInstance` from injected context
- Lifecycle-aware: intercept starts with app, restores on unmount

### Common Types

Added to core's ambient types (`schmock.d.ts`):

```typescript
interface AdapterRequest {
  method: string
  path: string
  headers: Record<string, string>
  body?: unknown
  query: Record<string, string>
}

interface AdapterResponse {
  status: number
  body: unknown
  headers: Record<string, string>
}
```

These are the contracts that adapters normalize to/from.

## Packaging

### New Model

Each framework adapter is a single install that pulls in everything needed:

| User installs | Dependencies (automatic) | Peer deps (user provides) |
|---------------|--------------------------|---------------------------|
| `@schmock/react` | `@schmock/core` | `react` |
| `@schmock/vue` | `@schmock/core` | `vue` |
| `@schmock/express` | `@schmock/core` | `express` |
| `@schmock/angular` | `@schmock/core` | `@angular/common`, `@angular/core`, `rxjs` |

Plugins remain additive: `@schmock/faker`, `@schmock/validation`, `@schmock/query`, `@schmock/openapi`.

### `@schmock/schmock` Meta-Package

Changes from "everything including all adapters" to "core + all plugins, no framework adapters." Users who want the full plugin suite without framework lock-in install this. Framework adapters are installed separately based on need.

Updated dependencies:
- `@schmock/core`
- `@schmock/faker`
- `@schmock/validation`
- `@schmock/query`
- `@schmock/openapi`
- `@schmock/cli`
- ~~`@schmock/express`~~ removed
- ~~`@schmock/angular`~~ removed

### `@schmock/cli`

Depends on core + openapi (uses `node:http` directly, not Express). Stays in the meta-package. No changes needed.

## Execution Order

### Phase 1: Refactor (TDD — red/green/green)

All work on existing packages. No new packages yet.

1. **Core: response helpers module** — Extract helpers from Angular into core. Write tests first, then implement, then refactor Angular to import from core.
2. **Core: `isRouteNotFound` utility** — Write tests, implement, then refactor Express and Angular to use it.
3. **Core: `mock.intercept()`** — Write tests for fetch patching, passthrough, restore, baseUrl filtering, request/response hooks, error formatting. Implement. This is the largest piece.
4. **Express adapter refactor** — Update facade to use core primitives. Existing BDD tests must stay green.
5. **Angular adapter refactor** — Update facade to use core primitives. Move response helpers to re-exports from core. Existing BDD tests must stay green.
6. **`@schmock/schmock` update** — Remove framework adapter dependencies.

### Phase 2: New Adapters (TDD — red/green/green)

7. **`@schmock/react`** — BDD feature file first, then Provider, hook, and test utility.
8. **`@schmock/vue`** — BDD feature file first, then Plugin, composable.

## Testing Strategy

- **TDD throughout**: write failing test (red), make it pass (green), refactor (green)
- **BDD features**: each adapter gets a `.feature` file with scenarios for: route matching, passthrough, error handling, lifecycle (mount/unmount/restore), hooks
- **Existing tests must not break**: Express and Angular BDD suites are the regression safety net during refactor
- **`mock.intercept()` tests**: fetch patching, restore, concurrent interceptors, baseUrl filtering, passthrough behavior, request/response hooks

## Risks

- **Fetch patching in test environments**: Some test runners (Jest with jsdom) have their own fetch implementations. Need to verify `globalThis.fetch` patching works correctly in vitest (our test runner).
- **Breaking changes to `@schmock/schmock`**: Removing adapter deps is a breaking change. Requires major version bump or clear migration path.
- **Response helper re-exports from Angular**: Moving helpers to core and re-exporting from Angular preserves backwards compatibility, but consumers importing from `@schmock/angular` should eventually migrate to `@schmock/core`.
