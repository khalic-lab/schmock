# Plugin Development

Plugins extend Schmock's request pipeline. They can validate, generate, or transform requests and responses.

## Plugin Interface

```typescript
interface Plugin {
  name: string
  version?: string
  install?(instance: CallableMockInstance): void
  process(context: PluginContext, response?: unknown): PluginResult | Promise<PluginResult>
  onError?(error: Error, context: PluginContext): Error | ResponseResult | void | Promise<Error | ResponseResult | void>
}
```

## Pipeline Execution

Plugins execute in `.pipe()` order. Each receives the context and the response from the previous plugin:

```
Request → Plugin A → Plugin B → Plugin C → Response
              ↓           ↓           ↓
          (validate)  (generate)  (transform)
```

1. First plugin to set a `response` becomes the generator
2. Later plugins can transform the response
3. All plugins can modify the context (headers, state)

## Plugin Patterns

### Guard — Validate and reject early

```typescript
function authPlugin(validTokens: string[]): Schmock.Plugin {
  return {
    name: 'auth',
    process(context, response) {
      const token = context.headers.authorization?.replace('Bearer ', '')
      if (!token || !validTokens.includes(token)) {
        return { context, response: [401, { error: 'Unauthorized' }] }
      }
      context.state.set('user', { token })
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
function wrapPlugin(key: string): Schmock.Plugin {
  return {
    name: 'wrap',
    process(context, response) {
      if (response) {
        return { context, response: { [key]: response, _meta: { path: context.path } } }
      }
      return { context, response }
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
}
```

Plugins share data through `context.state`:

```typescript
// Plugin A: set state
context.state.set('requestId', crypto.randomUUID())

// Plugin B: read state
const requestId = context.state.get('requestId')
```

## Error Handling

The `onError` hook handles errors from previous plugins:

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
mock('GET /data', handler)
  .pipe(authPlugin(['valid-token']))   // 1st: reject unauthorized
  .pipe(wrapPlugin('data'))            // 2nd: wrap response
  .pipe(errorPlugin())                 // 3rd: catch errors from above
```

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
    const result = await plugin.process(ctx, undefined)
    expect(result.response).toEqual([401, { error: 'Unauthorized' }])
  })

  it('passes valid token', async () => {
    const ctx = {
      path: '/test', route: {}, method: 'GET' as const,
      params: {}, query: {}, headers: { authorization: 'Bearer valid' },
      state: new Map(),
    }
    const result = await plugin.process(ctx, { data: 'ok' })
    expect(result.response).toEqual({ data: 'ok' })
    expect(ctx.state.get('user')).toEqual({ token: 'valid' })
  })
})
```

Integration test in a real pipeline:

```typescript
it('works end to end', async () => {
  const mock = schmock()
  mock('GET /test', { secret: 'value' })
    .pipe(authPlugin(['abc']))

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
