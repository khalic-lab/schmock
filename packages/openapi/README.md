# @schmock/openapi

Auto-register Schmock routes from an OpenAPI or Swagger spec, with stateful CRUD collections and seed data.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/openapi
```

## Usage

```typescript
import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";

const mock = schmock({ state: {} });

mock.pipe(await openapi({ spec: "./petstore.yaml", seed: { pets: { count: 5 } } }));

const response = await mock.handle("GET", "/pets");
```

## Documentation

- [OpenAPI guide](https://github.com/khalic-lab/schmock/blob/main/docs/openapi.md)
- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)

## License

MIT © Khalic Lab
