# @schmock/schmock

All-in-one Schmock install: pulls in core, faker, validation, query, openapi, and the CLI.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/schmock
```

This package re-exports only `schmock` and the response helpers from `@schmock/core`.
The other packages arrive as its dependencies, which a strict layout (pnpm, Yarn PnP,
`bun install --linker isolated`) does not let your code import or run. List every
package you import, and `@schmock/cli` if you run the `schmock` command, as a direct
dependency:

```bash
bun add -d @schmock/schmock @schmock/openapi
```

## Usage

```typescript
import { schmock } from "@schmock/schmock";
import { openapi } from "@schmock/openapi"; // installed directly, see above

const mock = schmock({ state: {} });
mock.pipe(await openapi({ spec: "./petstore.yaml" }));
```

## Documentation

- [Getting started](https://github.com/khalic-lab/schmock/blob/main/docs/getting-started.md)
- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)

## License

MIT © Khalic Lab
