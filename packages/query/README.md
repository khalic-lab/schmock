# @schmock/query

Pagination, sorting, and filtering for Schmock list endpoints, driven by query parameters.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/query
```

## Usage

```typescript
import { schmock } from "@schmock/core";
import { queryPlugin } from "@schmock/query";

const mock = schmock();

mock("GET /users", users).pipe(
  queryPlugin({
    pagination: { defaultLimit: 10, maxLimit: 100 },
    sorting: { allowed: ["name"] },
  }),
);

// Through an adapter: GET /users?page=2&limit=10&sort=name
const response = await mock.handle("GET", "/users", {
  query: { page: "2", limit: "10", sort: "name" },
});
```

## Documentation

- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)
- [Plugin development](https://github.com/khalic-lab/schmock/blob/main/docs/plugins.md)

## License

MIT © Khalic Lab
