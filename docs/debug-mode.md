# Debug Mode

Enable detailed logging of the request processing lifecycle.

```typescript
const mock = schmock({ debug: true })
```

## Log Output

Every `[SCHMOCK:CATEGORY]` line is prefixed with an ISO timestamp —
`[2024-01-01T00:00:00.000Z] [SCHMOCK:CONFIG] …` — omitted from the samples below
for brevity. The category is the internal name uppercased, so
`grep SCHMOCK:LIFECYCLE` works. The `[SCHMOCK] request-<id>` timing line comes
from `console.time`/`timeEnd` and carries no timestamp of its own.

### Instance and route setup
```
[SCHMOCK:CONFIG] Debug mode enabled
[SCHMOCK:CONFIG] Callable mock instance created { debug: true, namespace: undefined, delay: undefined }
[SCHMOCK:ROUTE] Route defined: GET /users
[SCHMOCK:PLUGIN] Registered plugin: auth@1.0.0
```

### Request processing
```
[SCHMOCK:REQUEST] [abc123] GET /users { headers: {...}, query: { limit: '10' }, bodyType: 'none' }
[SCHMOCK:ROUTE] [abc123] Matched route: GET /users
[SCHMOCK:PIPELINE] Running plugin pipeline for 2 plugins
[SCHMOCK:PIPELINE] Processing plugin: auth
[SCHMOCK:PIPELINE] Processing plugin: faker
[SCHMOCK:PIPELINE] Plugin faker generated response
[SCHMOCK:RESPONSE] [abc123] Sending response 200 { status: 200, headers: {...}, bodyType: 'object' }
[SCHMOCK] request-abc123: 25.678ms
```

### Errors
```
[SCHMOCK:ERROR] [def456] Error processing request: Authentication required
[SCHMOCK:PIPELINE] Plugin auth handled error
[SCHMOCK:RESPONSE] [def456] Sending response 500 { status: 500, headers: {...}, bodyType: 'object' }
[SCHMOCK:EVENT] request:end listener rejected: metrics backend unavailable
[SCHMOCK] request-def456: 15.234ms
```

A request that ends in a 500 still finishes through the normal response path,
so it is logged as `RESPONSE`, recorded in history, and reported to
`request:end` listeners.

### Server and lifecycle
```
[SCHMOCK:SERVER] Listening on 127.0.0.1:3000
[SCHMOCK:SERVER] Server stopped
[SCHMOCK:LIFECYCLE] Interception lease acquired (1 held)
[SCHMOCK:LIFECYCLE] Interception lease released (0 still held)
[SCHMOCK:LIFECYCLE] Request history cleared
[SCHMOCK:LIFECYCLE] Mock fully reset
```

The bracketed id (`abc123` above) is a v4 UUID that ties one request's lines
together. It comes from `crypto.randomUUID()` where that exists. Browsers
expose it only in secure contexts, so on a page served over plain http (a LAN
address, a docker hostname, `ng serve --host`) the id is built from
`crypto.getRandomValues()` instead, and from `Math.random()` on a runtime
without Web Crypto. Generating it never fails a request.

## Log Categories

| Category | What it logs |
|----------|--------------|
| `CONFIG` | Instance creation and configuration |
| `ROUTE` | Route definition and matching |
| `PLUGIN` | Plugin registration, install and uninstall, and failing `onExchange` and `afterResponse` hooks |
| `REQUEST` | Request start and details |
| `PIPELINE` | Plugin pipeline execution |
| `RESPONSE` | Response generation |
| `ERROR` | Error handling |
| `EVENT` | Isolated lifecycle-listener failures and rejected promises |
| `LIFECYCLE` | Interception leases, and `reset()` / `resetHistory()` / `resetState()` |
| `WARNING` | Recoverable misconfiguration, e.g. a duplicate route or a plugin piped twice |
| `SERVER` | Standalone server start, stop and server-level errors |

These eleven are the complete set — `packages/core` is the only emitter, and a
unit test pins the list so it cannot drift from this table.

## Credential redaction

Request and response header values are redacted in `REQUEST` and `RESPONSE` logs
when the header name is one of `authorization`, `proxy-authorization`, `cookie`,
`set-cookie`, `x-api-key`, `x-auth-token` or `x-schmock-admin-token` (matched
case-insensitively). The header NAME is still logged so you can see it was
present; only the value is replaced with `[redacted]`:

```
[SCHMOCK:REQUEST] [abc123] GET /users { headers: { authorization: '[redacted]', 'content-type': 'application/json' }, query: {}, bodyType: 'none' }
```

Query parameter values are redacted in the `REQUEST` log when the parameter is
named like a credential: exactly `key`, `token`, `apikey`, `api_key`,
`api-key`, `secret` or `password`, or any name ending in one of those after a
`-` or `_` (`access_token`, `client_secret`, `x-pet-key`), matched
case-insensitively. That is the rule the CLI's admin history uses:

```
[SCHMOCK:REQUEST] [abc123] GET /pets { headers: {...}, query: { api_key: '[redacted]', limit: '10' }, bodyType: 'none' }
```

Redaction affects logs only — plugins, generators and `history()` still receive
the real header and query values. There is no opt-out. The header set is
exported from `@schmock/core` as `SENSITIVE_HEADER_NAMES`, and
`redactHeaders()` applies the same masking; see
[Header helpers](./api.md#header-helpers). The query rule is exported from
`@schmock/core/adapter` as `isCredentialName()`.

`bodyType` reports the type of the request body whenever one was supplied, so an
empty string, `0` or `false` show as `string` / `number` / `boolean`; `none`
means no body was passed at all.

An intercepted fetch that no route matches (passthrough on, no `beforeRequest`
hook) also logs `bodyType: 'none'`, because its body is never read.

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
