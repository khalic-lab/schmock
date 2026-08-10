# @schmock/core

Core mock builder, routing, and plugin pipeline for Schmock.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/core
```

## Usage

```typescript
import { schmock } from "@schmock/core";

const mock = schmock();

mock("GET /users", [{ id: 1, name: "Alice" }]);
mock("POST /users", ({ body }) => [201, body]);

const response = await mock.handle("GET", "/users");
// → { status: 200, body: [{ id: 1, name: "Alice" }] }
```

## Documentation

- [Getting started](https://github.com/khalic-lab/schmock/blob/main/docs/getting-started.md)
- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)
- [Plugin development](https://github.com/khalic-lab/schmock/blob/main/docs/plugins.md)

## License

MIT © Khalic Lab
