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

// Plugins apply to every route on the mock, not only to one route.
mock.pipe(
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

mock("POST /users", ({ body }) => [201, body]);

// A body without `name` never reaches the generator — it returns 400.
```

- `response.statuses` scopes response validation: `"2xx"`, or a list of
  statuses. Without it, every response status is validated.
- Header schema names are matched case-insensitively.
- Query and header schemas can use `integer`, `number` and `boolean` types.
  Values are coerced for validation only; routes still receive strings.

## Documentation

- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)
- [Testing patterns](https://github.com/khalic-lab/schmock/blob/main/docs/testing.md)

## License

MIT © Khalic Lab
