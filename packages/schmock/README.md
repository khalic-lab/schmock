# @schmock/schmock

All-in-one Schmock install: pulls in core, faker, validation, query, openapi, and the CLI.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/schmock
```

## Usage

```typescript
// One install brings core, faker, validation, query, openapi and the CLI.
import { schmock } from "@schmock/schmock";
import { openapi } from "@schmock/openapi";

const mock = schmock({ state: {} });
mock.pipe(await openapi({ spec: "./petstore.yaml" }));
```

## Documentation

- [Getting started](https://github.com/khalic-lab/schmock/blob/main/docs/getting-started.md)
- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)

## License

MIT © Khalic Lab
