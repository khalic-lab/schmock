# @schmock/faker

Faker-powered automatic data generation for Schmock. Turns JSON Schema into realistic, field-name-aware mock data.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/faker
```

## Usage

```typescript
import { schmock } from "@schmock/core";
import { fakerPlugin } from "@schmock/faker";

const mock = schmock();

// Plugins are instance-wide: this fills any route that produced no response.
mock.pipe(
  fakerPlugin({
    seed: 42,
    count: 3,
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, email: { type: "string" } },
      },
    },
  }),
);
mock("GET /users", undefined);
```

## Documentation

- [Getting started](https://github.com/khalic-lab/schmock/blob/main/docs/getting-started.md)
- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)

## License

MIT © Khalic Lab
