# CLI Mock Server

Start a mock API server from the command line. Point it at an OpenAPI spec and get a working server.

```sh
bun install -g @schmock/cli
```

## Usage

```sh
schmock petstore.yaml
```

```
Schmock server running on http://127.0.0.1:3000
Spec: petstore.yaml
```

## Options

```sh
schmock <spec> [options]
```

| Flag | Description | Default |
|------|-------------|---------|
| `--port <number>` | Port to listen on | `3000` |
| `--hostname <host>` | Hostname to bind to | `127.0.0.1` |
| `--seed <path>` | JSON file with seed data | — |
| `--cors` | Enable CORS headers on mock responses and answer browser preflights (never on `/schmock-admin/*`) | `false` |
| `--debug` | Enable debug logging | `false` |
| `--seed-random <number>` | Deterministic data generation | — |
| `--errors` | Enable request validation | `false` |
| `--watch` | Watch spec file for changes | `false` |
| `--admin` | Enable admin API endpoints | `false` |
| `--admin-token <token>` | Bearer token required by `/schmock-admin/*` | generated |
| `--admin-history-limit <number>` | Requests retained for `/schmock-admin/history` | `500` |
| `--strict` | Validate the spec against the OpenAPI schema at startup | `false` |
| `--refs-external` | Resolve `$ref`s outside the spec document | `false` |
| `--refs-allow-http <hosts>` | Also resolve http(s) `$ref`s, limited to this comma-separated host list | — |
| `-h, --help` | Show help | — |

### Multi-file specs and `$ref` policy

The CLI is handed a spec path by whoever runs it, and `$ref` is a file-read and
network primitive, so nothing outside the root document resolves by default. A
spec split across files needs `--refs-external`; relative refs then resolve
against the spec file's own directory.

```sh
schmock ./api/openapi.yaml --refs-external
schmock ./api/openapi.yaml --refs-external --refs-allow-http schemas.example.com
```

`--refs-allow-http` requires `--refs-external`; on its own it is a no-op. Passing
it with an empty list allows any public host. Loopback, link-local and private
addresses are always refused. Fetched refs use a 5s timeout, refuse redirects and
are capped at 1 MB; those limits are not flags — use the plugin's `refs` option
programmatically to change them.

`--strict` rejects a spec that fails OpenAPI schema validation instead of
skipping the parts that do not parse. It is off by default because it is both
stricter and noticeably slower on large specs.

## Examples

### With seed data

Create a `seed.json`:

```json
{
  "users": [
    { "userId": 1, "name": "Alice", "email": "alice@example.com" },
    { "userId": 2, "name": "Bob", "email": "bob@example.com" }
  ],
  "posts": { "count": 20 }
}
```

```sh
schmock api.yaml --seed seed.json --port 8080
```

#### Manifest rules

Each entry must be an array, a file path, or `{ "count": <number> }`. Anything
else — a bare number, a `{ "count": "20" }` string — is **rejected loudly**;
earlier versions dropped unrecognised entries in silence and started a server
whose collections were unexpectedly empty.

File-path entries resolve **relative to the manifest**, not to the process
working directory, and may not escape the manifest's directory. Both sides are
resolved through symlinks first, so `"../pets.json"`, `"/etc/passwd"`, and a
symlink planted inside the directory that points outside it are all refused
with `Seed entry "…" must stay inside the seed manifest directory`.

Because entry paths are resolved when the manifest is read, a typo'd path now
fails at startup with `Seed entry "…" points to a missing file` rather than
later, from inside seed loading.

The manifest itself is capped at 1 MiB (`MAX_SEED_MANIFEST_BYTES`), each
referenced seed file at 5 MiB, and each resource at 10 000 items; a breach
raises `RESOURCE_LIMIT_ERROR` before the server starts. Malformed JSON is
reported as `Seed file "…" contains invalid JSON` instead of a raw
`SyntaxError`.

### CORS for frontend development

```sh
schmock api.yaml --cors --port 4000
```

Every mock response then carries `Access-Control-Allow-Origin: *`. A real browser
preflight — `OPTIONS` with both `Origin` and `Access-Control-Request-Method` — is
answered by the server itself with `204`, echoing whatever
`Access-Control-Request-Headers` asked for so a custom header such as
`x-my-token` is not rejected. Any other `OPTIONS` request is routed normally: a
spec-declared `options` operation answers it, and an unknown path answers `404`.

This is a dev-server convenience, not a configurable policy — the origin is
always `*`, credentials are never allowed, and `/schmock-admin/*` never receives
CORS headers at all.

### Deterministic data

```sh
schmock api.yaml --seed-random 42
# Same data every time with the same seed
```

### Watch mode

```sh
schmock api.yaml --watch
# Server reloads when the spec file changes
```

Reloads are serialized and the listening socket is never unbound: the new mock
is built first and then swapped in behind the running server, atomically. An
invalid intermediate save is reported on stderr and leaves the current mock
serving; connections opened before a reload stay usable across it, and requests
already in flight finish against the mock they started on.

`--watch` is also available programmatically as `watch: true` — see
[Programmatic usage](#programmatic-usage).

## Admin API

When started with `--admin`, additional endpoints are available:

| Endpoint | Description |
|----------|-------------|
| `GET /schmock-admin/routes` | List all registered routes |
| `GET /schmock-admin/state` | Get current shared state |
| `GET /schmock-admin/history` | Get request history |
| `POST /schmock-admin/reset` | Reset state and history |

### Authentication

Every admin endpoint requires a bearer token. Supply one with `--admin-token`,
or let the CLI mint one — it is printed to stderr next to the startup banner:

```
Admin: enabled (/schmock-admin/*)
Admin token: 4f1c1f2c-2f5f-4b6f-9a9a-1a4b0f2f3d21
```

```sh
schmock api.yaml --admin --admin-token dev-token
curl -H 'Authorization: Bearer dev-token' localhost:3000/schmock-admin/state
```

`x-schmock-admin-token: <token>` is accepted as an alternative to the
`Authorization` header. A missing or wrong token returns `401` with code
`UNAUTHORIZED` and a `WWW-Authenticate: Bearer` challenge. With `--admin` off
the paths are not special-cased at all and fall through to the mock, so they
answer `404`. An unauthenticated caller can therefore tell from `401` vs `404`
that `--admin` is on; the token is what protects the data, not the obscurity.

The token survives a `--watch` reload, so a live admin client keeps working
across spec saves. A token passed as `--admin-token` is visible in `ps` output
on a shared host; prefer the generated one there.

### Browser access and CORS

Admin responses never carry CORS headers, even with `--cors`, and an
`OPTIONS /schmock-admin/*` preflight is not answered with a wildcard. Admin
requests that carry an `Origin` header are refused with `403` `FORBIDDEN`.

That combination is what stops a page you happen to be visiting from reading
`http://127.0.0.1:3000/schmock-admin/history` — which holds recorded request
headers and response bodies — or from calling `reset`. Command-line and
server-side clients send no `Origin` and are unaffected. A browser-based admin
dashboard cannot talk to these endpoints cross-origin by design.

### History retention and redaction

Request history exists only to serve `GET /schmock-admin/history`:

- without `--admin`, nothing is retained at all;
- with `--admin`, the most recent 500 requests are kept, adjustable via
  `--admin-history-limit <n>` (`0` keeps nothing; the value must be a
  non-negative integer). Passing it without `--admin` has no effect.

In the admin projection the values of `authorization`, `proxy-authorization`,
`cookie`, `set-cookie`, `x-api-key`, `x-auth-token` and `x-schmock-admin-token`
read `"[redacted]"`. The core `mock.history()` API is untouched and still
returns raw header values.

### Binding beyond loopback

`--admin --hostname 0.0.0.0` is allowed — containers need it — but the CLI
prints a warning, because the admin API then reaches every host that can route
to the port. The bearer token is the only thing standing between them and the
recorded traffic.

## Request Handling

Request bodies are limited to 10 MiB using both declared `Content-Length` and
the bytes actually received. Oversized requests return structured 413
`PAYLOAD_TOO_LARGE`, close that connection, and do not execute routes or enter
history. Malformed JSON for `application/json` or `+json` media types returns
structured 400 `MALFORMED_JSON`. Media-type matching is case-insensitive.

If a client disconnects, the CLI aborts pending plugin hooks, delays, and route
generators while keeping the server available for later requests.

## Programmatic Usage

```typescript
import { createCliServer } from '@schmock/cli'

const server = await createCliServer({
  spec: './petstore.yaml',
  port: 8080,
  cors: true,
  seed: './seed.json',
})

console.log(`Mock server on port ${server.port}`)

// Stop the server; resolves once the port is released
await server.close()
```

`close()` stops accepting connections first, then stops the watcher and waits
for in-flight requests, destroying whatever is still open after
`shutdownGraceMs` (default 5000) — a client that stopped mid-upload, or a spec
reload still parsing, cannot keep the shutdown open past the bound. It is
memoized, so calling it twice is safe and both calls resolve. Awaiting it
before binding the same port again is what makes a port-reuse race impossible.

`watch: true` works here too, not just behind the `--watch` flag: the returned
server owns the watcher and closes it with the socket. If the watcher cannot be
started, `createCliServer` rejects instead of leaving a server bound that
nobody can reach.

```typescript
const server = await createCliServer({
  spec: './petstore.yaml',
  port: 0,
  watch: true,
  shutdownGraceMs: 1_000,
})
```

With `admin: true` the resolved bearer token is on the returned server, whether
you pinned it via `adminToken` or let it be generated:

```typescript
const server = await createCliServer({ spec: './petstore.yaml', port: 0, admin: true })

const state = await fetch(`http://127.0.0.1:${server.port}/schmock-admin/state`, {
  headers: { authorization: `Bearer ${server.adminToken}` },
})
```

Useful for integration tests:

```typescript
import { describe, it, beforeAll, afterAll } from 'vitest'
import { createCliServer } from '@schmock/cli'

let server: Awaited<ReturnType<typeof createCliServer>>

beforeAll(async () => {
  server = await createCliServer({
    spec: './api.yaml',
    port: 0,  // random available port
    seed: './fixtures/seed.json',
  })
})

afterAll(async () => {
  // Awaited: the next suite may bind the same port.
  await server.close()
})

it('serves the API', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/users`)
  expect(res.status).toBe(200)
})
```
