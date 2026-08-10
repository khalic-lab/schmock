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
| `--cors` | Enable CORS headers | `false` |
| `--debug` | Enable debug logging | `false` |
| `--seed-random <number>` | Deterministic data generation | — |
| `--errors` | Enable request validation | `false` |
| `--watch` | Watch spec file for changes | `false` |
| `--admin` | Enable admin API endpoints | `false` |
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

Reloads are serialized and keep the same port. A changed spec is parsed and
configured before the live server is replaced, so an invalid intermediate save
is reported without taking the current mock offline.

## Admin API

When started with `--admin`, additional endpoints are available:

| Endpoint | Description |
|----------|-------------|
| `GET /schmock-admin/routes` | List all registered routes |
| `GET /schmock-admin/state` | Get current shared state |
| `GET /schmock-admin/history` | Get request history |
| `POST /schmock-admin/reset` | Reset state and history |

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

// Stop the server
server.close()
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

afterAll(() => server.close())

it('serves the API', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/users`)
  expect(res.status).toBe(200)
})
```
