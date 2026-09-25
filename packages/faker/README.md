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

## Limits

Every limit is checked when the plugin is created, and again on the generated
value where the schema alone cannot decide. A breach throws `ResourceLimitError`
with the `resource` below.

| `resource` | Constant | Bound |
|------------|----------|-------|
| `array_size`, `array_max_items` | `MAX_ARRAY_SIZE` | 10,000 items |
| `schema_nesting_depth` | `MAX_NESTING_DEPTH` | 15 levels |
| `schema_nodes` | `MAX_SCHEMA_NODES` | 50,000 distinct schema nodes |
| `generated_nodes` | `MAX_GENERATED_NODES` | 1,000,000 generated JSON nodes |
| `object_properties` | `MAX_OBJECT_PROPERTIES` | 10,000 properties per object |
| `string_length` | `MAX_STRING_LENGTH` | 65,536 UTF-16 code units per string |
| `generated_chars` | not exported | 16,777,216 UTF-16 code units per response |
| `schema_composition_depth` | not exported | 200 composition frames |

The constants are exported from `@schmock/faker`. See
[Generation limits](https://github.com/khalic-lab/schmock/blob/main/docs/api.md#generation-limits)
for faker-argument limits and what counts toward each bound.

## Documentation

- [Getting started](https://github.com/khalic-lab/schmock/blob/main/docs/getting-started.md)
- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)

## License

MIT © Khalic Lab
