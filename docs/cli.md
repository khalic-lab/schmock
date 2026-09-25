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
| `--admin-token <token>` | Bearer token required by `/schmock-admin/*`; requires `--admin` | generated |
| `--admin-history-limit <number>` | Requests retained for `/schmock-admin/history` | `500` |
| `--strict` | Validate the spec against the OpenAPI schema at startup | `false` |
| `--refs-external` | Resolve `$ref`s outside the spec document | `false` |
| `--refs-allow-http <hosts>` | Also resolve http(s) `$ref`s, limited to this comma-separated host list | — |
| `-h, --help` | Show help | — |

### Argument validation

Bad invocations fail at startup rather than starting a server that quietly does
something else:

- `--port` takes decimal digits only. `--port=` (for example an unset shell
  variable), a blank value, `0x1F90`, `1e3`, `80.0` and `+80` are rejected with
  `Invalid port`.
- `--admin-history-limit` also takes decimal digits only.
- `--seed-random` must be an optional minus sign followed by digits (`-?\d+`).
  Negatives are fine (`--seed-random=-1`; the `=` form is required for a leading
  dash). `abc`, an empty value, `1.5`, `1e3`, `0x10` and `+5` are rejected,
  where the first three previously became `NaN`, "no seed at all" and a
  fractional seed.
- `--admin-token` without `--admin` fails with `--admin-token requires --admin.`;
  the token does not turn the admin API on.
- `createCliServer({ admin: true, adminToken })` throws `Invalid admin token. The
  token must be non-empty and contain no whitespace.` for an empty token or one
  containing whitespace, including a trailing newline read from a file.
- `--hostname` must be a non-empty host. A blank value is rejected: it is *not*
  the `127.0.0.1` default — `listen(port, '')` binds every interface, so a typo
  used to publish the mock to the network. The same check applies to
  `createCliServer({ hostname })`.
- Exactly one spec path. `schmock a.json b.json` is an error instead of silently
  serving `a.json`. (`--spec` still wins over a single positional.)

Each of these is a `SchmockError` with code `INVALID_CONFIG`; the messages are
the ones quoted above. From `parseCliArgs`, the error's `context` is
`{ flag, value }`. `--admin-token` errors carry `{ flag }` only, so the token
never lands in a log, and an extra spec path carries `{ flag: '<spec>' }`. From
`createCliServer`, a blank hostname carries `{ option: 'hostname', value }` and
an unusable admin token `{ option: 'adminToken' }`. The binary still prints
`Schmock failed: <message>`, but `err.name` (and so `String(err)`) is now
`SchmockError` rather than `Error`.

### Shutting down

`SIGINT`/`SIGTERM` starts a graceful shutdown bounded by `shutdownGraceMs`
(default 5000). A repeat signal inside the grace window does not force an exit —
the drain is already bounded — but it is acknowledged on stderr once:

```
Shutdown already in progress; waiting for in-flight requests (signal again after 5000 ms to force an exit)...
```

A signal that arrives after the grace window has passed, while the close is
still running, prints `Shutdown did not finish within the grace window; forcing
exit.` and exits with code 1. At the grace deadline the CLI destroys every open
connection itself instead of relying only on the runtime's
`closeAllConnections()`, which under Bun does not release a connection with a
half-sent request body.

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
it with an empty list (`--refs-allow-http ''`) allows any public host.
Loopback, link-local, private and reserved addresses are always refused. With an
empty list or an explicit host list, every address a host resolves to is checked
when the connection is made, so an allow-listed hostname that resolves to a
private address is refused, and so are names like `127.0.0.1.nip.io`. The
refused ranges are listed in the
[OpenAPI guide](./openapi.md#external-refs-are-opt-in).

A remote document cannot pull in local files: a `$ref` to a local file that
appears only in a document fetched over http fails with
`OPENAPI_EXTERNAL_REF_BLOCKED`. `--refs-external` alone still reads any local
file the spec and its local documents reference.

Fetched refs use a 5s timeout, refuse redirects and are capped at 1 MB. The cap
is enforced while the body streams, after decompression. Those limits are not
flags — use the plugin's `refs` option programmatically to change them.

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

A manifest key must name a CRUD resource the spec declares. An unknown key makes
the server fail at startup with `OPENAPI_UNKNOWN_SEED_RESOURCE`, and the message
lists the detected resources.

The manifest itself is capped at 1 MiB (`MAX_SEED_MANIFEST_BYTES`), each
referenced seed file at 5 MiB, and each resource at 10 000 items; a breach
raises `RESOURCE_LIMIT_ERROR` before the server starts. Malformed JSON is
reported as `Seed file "…" contains invalid JSON` instead of a raw
`SyntaxError`.

Manifest mistakes (invalid JSON, a manifest that is not an object, an entry of
the wrong shape, a missing file, an entry that escapes the directory) are
`SchmockError` with code `OPENAPI_INVALID_OPTION` and context
`{ option: 'seed', resource? }`: the code the openapi plugin raises for the
same mistakes in its `seed` option. The same code, with `file` in the context,
covers a referenced seed file that is not valid JSON or not a JSON array.

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

A preflight is answered 204 without reading any request body it carries.

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
already in flight finish against the mock they started on. The mock a reload
replaces is retired, so its plugins' `uninstall` hooks run once every request
admitted against it has finished.

Watching is on the spec's **directory**, not its inode, so an atomic editor
save — write a temp file, rename it over the spec, which is what vim, JetBrains
and VS Code do — keeps working, as do all the edits after it. A symlinked spec
is watched at the link's own directory, so saving the link *target* elsewhere is
not seen.

Besides the spec, the `--seed` manifest and every file entry it names are
watched, each through its own directory. The watched set is re-derived after
every reload, so an entry added to the manifest is followed. With
`--refs-external`, a reload is also triggered by any non-hidden `.json`,
`.yaml` or `.yml` sibling of the spec, because a `$ref`'d schema file is part
of the contract. A `$ref` target in a different directory is not watched; touch
the root spec to reload after editing it. Writes to other files in watched
directories are ignored: log files (so output redirected there cannot feed a
reload loop), text files, `.DS_Store`, and editor swap or backup files
(`*.swp`, `*~`, `.#*`).

A reload builds a fresh mock: CRUD rows created since startup and the admin
request history are discarded, and `--seed` data is applied again. The reload
line on stderr says so:

```
Schmock server reloaded on http://127.0.0.1:3000 (state and request history reset)
```

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

The Origin 403 and token 401 checks, and the endpoint answer itself, run
before the request body is read. An oversized, malformed, badly encoded or
stalled body therefore never turns a refusal into a 413 or 400 and never delays
it. The admin endpoints ignore any request body.

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
  non-negative integer). Passing it without `--admin` has no effect and prints a
  `WARNING` line on stderr.

`--admin-history-limit` (`adminHistoryLimit` programmatically) is core's
`maxHistorySize` under the admin API's name. It defaults to 500 where core's
default is unbounded, and it applies only with `--admin`.

In the admin projection the values of `authorization`, `proxy-authorization`,
`cookie`, `set-cookie`, `x-api-key`, `x-auth-token` and `x-schmock-admin-token`
read `"[redacted]"`. These seven are core's `SENSITIVE_HEADER_NAMES`, the set
its debug log masks. A request `set-cookie` header reaches the server as an
array and is not recorded at all. In addition, any header or query parameter whose name,
compared case-insensitively, is exactly `key`, `token`, `apikey`, `api_key`,
`api-key`, `secret` or `password`, or ends in one of those after a `-` or `_`
(for example `X-Pet-Key`, `access_token`, `client_secret`), is masked the same
way. This covers the usual spellings of spec-declared apiKey schemes, but a name
outside that pattern (such as `X-Pet-Credential`) is shown as sent. The core
`mock.history()` API is untouched and still returns raw values.

### Binding beyond loopback

`--admin --hostname 0.0.0.0` is allowed — containers need it — but the CLI
prints a warning, because the admin API then reaches every host that can route
to the port. The bearer token is the only thing standing between them and the
recorded traffic. Loopback binds (`127.0.0.0/8`, `::1`, `localhost`, and
IPv4-mapped loopback such as `::ffff:127.0.0.1`) print no warning.

An IPv6 host is printed bracketed: `--hostname ::1` gives
`Schmock server running on http://[::1]:<port>`, and the reload line does the
same.

## Request Handling

Every request, admin and preflight included, is served through core's
`serveNodeRequest`, the same bridge as `mock.listen()`, so both answer client
errors alike:

- a missing `Host` header gets 400 `BAD_REQUEST` `Missing Host header`, and a
  malformed one 400 `BAD_REQUEST` `Malformed Host header` (previously
  `Malformed request target`);
- a malformed request target gets 400 `BAD_REQUEST`;
- a method outside `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD` and
  `OPTIONS` gets 405 `METHOD_NOT_ALLOWED` with an `Allow` header;
- a target starting with `//` is a path, never a host: `GET //users` is looked
  up as `//users`. It used to be read as host `users` and path `/`, and reach
  the `GET /` route.

After those checks, the admin API and a CORS preflight are answered without
reading the body. For every other request the body is read and checked before
the route runs. Request bodies are limited to 10 MiB, core's default,
using both declared `Content-Length` and the bytes actually received.
Oversized requests return structured 413 `PAYLOAD_TOO_LARGE` and do not execute
routes or enter history. Every body failure (400 `MALFORMED_JSON`,
`JSON_TOO_DEEP` or `MALFORMED_MULTIPART`, and 413) sends `connection: close` and
closes a kept-alive connection. Only a 413 used to close it. Media-type
matching is case-insensitive.

A mock whose request admission is broken answers its routes with 500
`SERVER_ERROR` `Schmock returned an invalid request admission`, after the body
has been read. The admin API keeps answering.

The handler receives the body in the same shape the fetch interceptor gives it.
The same rules apply to `mock.listen()`:

| Content type | Body |
|---|---|
| `application/json` and any `+json` type | The parsed value. Malformed JSON gives 400 `MALFORMED_JSON`; nesting deeper than 256 levels gives 400 `JSON_TOO_DEEP` |
| `application/x-www-form-urlencoded` | A flat object of strings; the last duplicate key wins |
| `text/*` | A UTF-8 string (the `charset` parameter is ignored) |
| `multipart/*` | `FormData`. Malformed multipart gives 400 `MALFORMED_MULTIPART` |
| Anything else, including no content type | An `ArrayBuffer` |
| Empty body | `undefined` |

Every response with a body carries `Content-Length` rather than chunked framing,
`/schmock-admin/*` answers included.

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
