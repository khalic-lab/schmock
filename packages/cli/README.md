# @schmock/cli

Standalone Schmock mock server. Serves an OpenAPI spec over HTTP with no application code.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/cli
```

## Usage

```bash
# Serve a spec on the default port 3000
bunx schmock ./petstore.yaml

# Let the OS pick a free port (the bound port is printed on startup)
bunx schmock ./petstore.yaml --port 0

# Pin the port, seed the generator and reload on spec changes
bunx schmock ./petstore.yaml --port 3000 --seed-random 42 --watch

# Serve fixed data from a seed manifest (--seed takes a path, not a number)
bunx schmock ./petstore.yaml --seed ./seed.json
```

## Documentation

- [CLI guide](https://github.com/khalic-lab/schmock/blob/main/docs/cli.md)
- [OpenAPI guide](https://github.com/khalic-lab/schmock/blob/main/docs/openapi.md)

## License

MIT © Khalic Lab
