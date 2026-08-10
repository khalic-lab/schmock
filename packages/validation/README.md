# @schmock/validation

Request and response validation for Schmock, backed by AJV and JSON Schema.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/validation
```

## Usage

```typescript
import { schmock } from "@schmock/core";
import { validationPlugin } from "@schmock/validation";

const mock = schmock();

mock("POST /users", ({ body }) => [201, body]).pipe(
  validationPlugin({
    request: {
      body: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  }),
);

// A body without `name` never reaches the generator — it returns 400.
```

## Documentation

- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)
- [Testing patterns](https://github.com/khalic-lab/schmock/blob/main/docs/testing.md)

## License

MIT © Khalic Lab
