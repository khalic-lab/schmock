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

// Plugins apply to every route on the mock, not only to one route.
mock.pipe(
  queryPlugin({
    pagination: { defaultLimit: 10, maxLimit: 100 },
    sorting: { allowed: ["name"] },
  }),
);

mock("GET /users", users);

// Through an adapter: GET /users?page=2&limit=10&sort=name
const response = await mock.handle("GET", "/users", {
  query: { page: "2", limit: "10", sort: "name" },
});
```

- Responses with a status of 400 or above are never paginated, sorted or filtered.
- `sorting.default` must be one of `sorting.allowed`, and `sorting.defaultOrder`
  must be `"asc"` or `"desc"`. Both are checked when the plugin is created.
- The order parameter is case-insensitive: `order=DESC` sorts descending.
- Pipe `queryPlugin` after the plugin that produces the body (faker, openapi).
  Give faker a `seed` so every request pages through the same data.

## Documentation

- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)
- [Plugin development](https://github.com/khalic-lab/schmock/blob/main/docs/plugins.md)

## License

MIT © Khalic Lab
