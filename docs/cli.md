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
| `-h, --help` | Show help | — |

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
