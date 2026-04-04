# Debug Mode

Enable detailed logging of the request processing lifecycle.

```typescript
const mock = schmock({ debug: true })
```

## Log Output

### Instance and route setup
```
[SCHMOCK:CONFIG] Debug mode enabled
[SCHMOCK:INSTANCE] SchmockInstance created { routeCount: 0, pluginCount: 0 }
[SCHMOCK:ROUTE] Route defined: GET /users
[SCHMOCK:PLUGIN] Registered plugin: auth@1.0.0
```

### Request processing
```
[SCHMOCK:REQUEST] [abc123] GET /users { headers: {...}, query: { limit: '10' } }
[SCHMOCK:ROUTE] [abc123] Matched route: /users
[SCHMOCK:PIPELINE] Processing plugin: auth
[SCHMOCK:PIPELINE] Processing plugin: schema-generator
[SCHMOCK:PIPELINE] Plugin schema-generator generated response
[SCHMOCK:RESPONSE] [abc123] Sending response 200
[SCHMOCK] request-abc123: 25.678ms
```

### Errors
```
[SCHMOCK:ERROR] [def456] Error processing request: Authentication required
[SCHMOCK:PIPELINE] Plugin auth handled error
[SCHMOCK] request-def456: 15.234ms
```

## Log Categories

| Category | What it logs |
|----------|--------------|
| `CONFIG` | Configuration changes |
| `INSTANCE` | Instance creation |
| `ROUTE` | Route definition and matching |
| `PLUGIN` | Plugin registration |
| `REQUEST` | Request start and details |
| `PIPELINE` | Plugin pipeline execution |
| `RESPONSE` | Response generation |
| `ERROR` | Error handling |

## Filtering

```sh
# Only pipeline logs
bun start | grep "SCHMOCK:PIPELINE"

# Only errors
bun start | grep "SCHMOCK:ERROR"

# Specific request
bun start | grep "abc123"
```

## Environment-based

```typescript
const mock = schmock({
  debug: process.env.NODE_ENV === 'development',
})
```

## OpenAPI debug

The OpenAPI plugin has its own `debug` option that logs CRUD detection:

```typescript
mock.pipe(await openapi({
  spec: './api.yaml',
  debug: true,
}))
```

```
[@schmock/openapi] Detected 3 CRUD resources, 2 static routes
[@schmock/openapi] users: list=wrapped("data"), error=schema(404), headers=2
```
