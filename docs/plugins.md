# Plugin Development

Plugins extend Schmock's request pipeline. They can validate, generate, or transform requests and responses.

## Plugin Interface

```typescript
interface Plugin {
  name: string
  version?: string
  install?(instance: CallableMockInstance): PluginHookResult
  uninstall?(instance: CallableMockInstance): PluginHookResult
  beforeRequest?(context: PluginContext): PluginResult | void | Promise<PluginResult | void>
  process(context: PluginContext, response?: unknown): PluginResult | Promise<PluginResult>
  onError?(error: Error, context: PluginContext): Error | ResponseResult | void | Promise<Error | ResponseResult | void>
}
```

`install()` and `uninstall()` return `PluginHookResult`, exported from
`@schmock/core`: any value that is not a thenable, and the value is ignored. An
expression-bodied arrow such as `install: (mock) => mock('GET /health', { ok: true })`
type-checks, as does every synchronous hook whether or not it is annotated
`: void`. An `async` hook is a compile error, and an `install()` that returns a
promise is also rejected at runtime with `PLUGIN_ASYNC_INSTALL_UNSUPPORTED`.

The `install()` instance is valid only for the synchronous duration of that
hook. Route registrations are staged and committed together when installation
succeeds; thrown errors or Promise-returning installs leave no routes or active
plugin behind. Do not retain the scoped instance for later use.

`reset()` retires the current plugin generation immediately for new requests.
Its `uninstall()` hooks then run in reverse registration order after every
already-admitted request using that generation has settled. Cleanup must be
synchronous. A plugin piped while a request is running belongs to the next
request generation and cannot enter the in-flight pipeline.

The `uninstall()` instance is read-only and expires when the hook returns:
`history`, `called`, `callCount`, `lastRequest`, `getRoutes` and `getState`
work. Route registration, `pipe`, `handle`, `reset`/`resetHistory`/`resetState`,
`on`/`off` and `listen`/`close`/`intercept` throw
`PLUGIN_UNINSTALL_OPERATION_UNSUPPORTED`, and any use after the hook returns
throws `PLUGIN_UNINSTALL_SCOPE_EXPIRED`. Re-piping a plugin object whose
uninstall is still pending (a request was in flight at `reset()`) runs that
uninstall immediately, before the new `install()`.

`pipe()` throws `SchmockError` `PLUGIN_INVALID` for a plugin that could never
work: a non-object, a missing or non-function `process`, or an `install` or
`beforeRequest` set to a truthy non-function. Falsy hooks (`onError: null`,
`install: false`) are accepted. Piping the same plugin object again is a no-op,
and debug mode logs `Plugin <name> is already piped into this mock — ignored`.
Distinct objects with the same name, such as two `openapi()` plugins, still
stack.

## Pipeline Execution

Plugins are global to a mock instance and execute in `.pipe()` order. Request
guards run before route code; response processors run after it:

```
Request → beforeRequest hooks → Route generator → process hooks → Response
                 │
                 └─ a response skips the route generator
```

1. A `beforeRequest` response rejects the request before route side effects.
2. Context changes made in `beforeRequest` flow into the route generator.
3. `process` receives the generated or short-circuit response and may transform
   it; `context.requestShortCircuited` identifies the latter.
4. All phases share the same per-request plugin state.

`process` receives the raw `ResponseResult`, not the body: a bare body, a
`[status, body]` or `[status, body, headers]` tuple, or a
`{ status, body, headers? }` envelope. A transformer that reshapes the body
must unwrap and rewrap the envelope, or it turns a 401 or a 201 into a 200 body
that contains the tuple.

Use `getResponseParts(response)` and `replaceResponseBody(response, body)`
from `@schmock/core` for that instead of a hand-written envelope guard.
`getResponseParts` returns `{ status, body, headers, kind }` with the guards
core itself applies, including the rule that an object whose `headers` are not
a string record is a plain body, not an envelope. `replaceResponseBody` puts a
new body into the same shape without mutating the original. A guard that checks
only for `status` and `body` misreads that case and rewrites a body core would
deliver whole. See [Response parts](./api.md#response-parts).

A hook must return a `PluginResult` (`beforeRequest` may also return nothing).
Anything else fails the request with `PluginError` and the message
`Plugin "<name>" failed: didn't return valid result`, and `onError` hooks see
that `PluginError`.

Static route data (a non-function generator) and `context.route` are
per-request copies. Editing them in place changes only the current response
and request, never the registered route or later requests. Static data is
copied deeply, but only its arrays and plain objects; Dates, binary values and
class instances are passed by reference. `context.route` is a shallow copy, so
custom route data nested inside it is shared.

## Plugin Patterns

### Guard — Validate and reject early

```typescript
function authPlugin(validTokens: string[]): Schmock.Plugin {
  return {
    name: 'auth',
    beforeRequest(context) {
      const token = context.headers.authorization?.replace('Bearer ', '')
      if (!token || !validTokens.includes(token)) {
        return { context, response: [401, { error: 'Unauthorized' }] }
      }
      context.state.set('user', { token })
      return { context }
    },
    process(context, response) {
      return { context, response }
    },
  }
}
```

### Generator — Produce a response

```typescript
function timestampPlugin(): Schmock.Plugin {
  return {
    name: 'timestamp',
    process(context, response) {
      if (!response) {
        return { context, response: { timestamp: Date.now() } }
      }
      return { context, response }
    },
  }
}
```

### Transformer — Modify existing response

```typescript
import { getResponseParts, replaceResponseBody } from '@schmock/core'

function wrapPlugin(key: string): Schmock.Plugin {
  return {
    name: 'wrap',
    process(context, response) {
      // A guard's rejection: leave it alone
      if (context.requestShortCircuited) return { context, response }

      // Plain body, tuple or envelope, read with core's own rules
      const { status, body } = getResponseParts(response)
      // Nothing to wrap, or an error: leave it alone
      if (body === undefined || body === null || status >= 300) {
        return { context, response }
      }
      const wrapped = { [key]: body, _meta: { path: context.path } }
      return { context, response: replaceResponseBody(response, wrapped) }
    },
  }
}
```

### Install hook — Register routes programmatically

```typescript
function autoRoutesPlugin(routes: Record<string, Function>): Schmock.Plugin {
  return {
    name: 'auto-routes',
    install(instance) {
      for (const [key, handler] of Object.entries(routes)) {
        instance(key as Schmock.RouteKey, handler)
      }
    },
    process(context, response) {
      return { context, response }
    },
  }
}
```

## Context and State

The `PluginContext` provides request data:

```typescript
interface PluginContext {
  path: string
  route: RouteConfig               // matched route config (includes custom data)
  method: HttpMethod
  params: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
  body?: unknown
  state: Map<string, unknown>       // shared across plugins for this request
  routeState?: Record<string, unknown>
  readonly signal?: AbortSignal     // admitted request cancellation
}
```

The admitted signal is immutable pipeline context: replacing the context in a
hook cannot discard it. Pending async hooks settle on abort even if their own
promise remains unresolved. Plugins should still observe `context.signal` when
performing cancelable external work.

Plugins share data through `context.state`:

```typescript
// Plugin A: set state
context.state.set('requestId', crypto.randomUUID())

// Plugin B: read state
const requestId = context.state.get('requestId')
```

## Error Handling

The `onError` hook first handles errors from its own plugin. If it does not
recover, downstream error handlers are tried in registration order. Generator
errors are offered to registered error handlers in the same order.

```typescript
function errorPlugin(): Schmock.Plugin {
  return {
    name: 'error-handler',
    process(context, response) {
      return { context, response }
    },
    onError(error, context) {
      // Return a response to recover
      return [500, { error: error.message, path: context.path }]
    },
  }
}
```

Return values from `onError`:
- `ResponseResult` — converts to a response, stops error propagation
- `Error` — replaces the error, continues propagation
- `void` — continues propagation with original error

## Chaining

Order matters:

```typescript
mock
  .pipe(authPlugin(['valid-token']))   // global pre-request guard
  .pipe(wrapPlugin('data'))            // 2nd: wrap response
  .pipe(errorPlugin())                 // 3rd: catch errors from above

mock('GET /data', handler)
```

A request without a token gets the guard's 401 unchanged: `wrapPlugin` skips
short-circuit responses.

### Ordering the built-in plugins

`process` hooks run in `.pipe()` order, and each built-in plugin acts on the
response as it finds it:

1. `fakerPlugin` first. It fills only an empty response and passes any other
   through, so a transformer piped before it sees nothing to transform.
2. Response validation next: `validationPlugin`, or `openapi` with
   `validateResponses`. It checks the body as it is when it runs, so it must
   come after the generator and before any transformer that reshapes the body.
3. `queryPlugin` last. It wraps arrays in `{ data, pagination }`.

```typescript
mock
  .pipe(fakerPlugin({ schema: { type: 'array', items: { type: 'integer' } }, count: 25 }))
  .pipe(validationPlugin({ response: { body: { type: 'array' } } }))
  .pipe(queryPlugin({ pagination: { defaultLimit: 10 } }))
```

In any other order the pipeline fails:

| Order | Result |
|-------|--------|
| `queryPlugin` before `fakerPlugin` | the full array, unpaginated, with no error |
| `validationPlugin` before `fakerPlugin`, when faker generates the body | 500 `RESPONSE_VALIDATION_ERROR`: the schema sees the empty response |
| `queryPlugin` before response validation | 500 `RESPONSE_VALIDATION_ERROR`: the schema sees the envelope |

If response validation must run after `queryPlugin`, write its schema against
the `{ data, pagination }` envelope.

## Testing Plugins

Unit test with a mock context:

```typescript
import { describe, it, expect } from 'vitest'

describe('authPlugin', () => {
  const plugin = authPlugin(['valid'])

  it('rejects missing token', async () => {
    const ctx = {
      path: '/test', route: {}, method: 'GET' as const,
      params: {}, query: {}, headers: {},
      state: new Map(),
    }
    if (!plugin.beforeRequest) throw new Error('guard hook missing')
    const result = await plugin.beforeRequest(ctx)
    if (!result) throw new Error('guard result missing')
    expect(result.response).toEqual([401, { error: 'Unauthorized' }])
  })

  it('passes valid token', async () => {
    const ctx = {
      path: '/test', route: {}, method: 'GET' as const,
      params: {}, query: {}, headers: { authorization: 'Bearer valid' },
      state: new Map(),
    }
    if (!plugin.beforeRequest) throw new Error('guard hook missing')
    const result = await plugin.beforeRequest(ctx)
    if (!result) throw new Error('guard result missing')
    expect(result.response).toBeUndefined()
    expect(ctx.state.get('user')).toEqual({ token: 'valid' })
  })
})
```

Integration test in a real pipeline:

```typescript
it('works end to end', async () => {
  const mock = schmock()
  mock.pipe(authPlugin(['abc']))
  mock('GET /test', { secret: 'value' })

  const denied = await mock.handle('GET', '/test')
  expect(denied.status).toBe(401)

  const allowed = await mock.handle('GET', '/test', {
    headers: { authorization: 'Bearer abc' },
  })
  expect(allowed.status).toBe(200)
})
```

## Built-in Plugins

These serve as reference implementations:

| Plugin | Pattern | Description |
|--------|---------|-------------|
| `@schmock/faker` | Generator | JSON Schema → realistic data |
| `@schmock/validation` | Guard | Validate requests/responses with AJV |
| `@schmock/query` | Transformer | Pagination, sorting, filtering |
| `@schmock/openapi` | Install hook | Auto-register routes from spec |

Plugin options are trusted configuration, not request data. Schemas handed to
`@schmock/validation` or `@schmock/faker` compile to native regular expressions
without safety screening, so a schema derived from untrusted input can block the
event loop; treat specs and schemas like handler code, especially when a mock is
exposed over a network. See the [Validation Plugin section of the API
reference](./api.md#validation-plugin-schmockvalidation) for the full contract,
including that validation targets the semantic response body rather than the
serialized transport payload.
