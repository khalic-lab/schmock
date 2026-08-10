# @schmock/vue

Vue 3 adapter for Schmock — a plugin and a composable that intercept `fetch`.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/vue
```

## Usage

```typescript
import { createApp } from "vue";
import { schmock } from "@schmock/core";
import { schmockPlugin } from "@schmock/vue";

const mock = schmock();
mock("GET /users", [{ id: 1, name: "Alice" }]);

createApp(App).use(schmockPlugin, { mock });
```

## Documentation

- [Vue adapter](https://github.com/khalic-lab/schmock/blob/main/docs/vue.md)
- [Testing patterns](https://github.com/khalic-lab/schmock/blob/main/docs/testing.md)

## License

MIT © Khalic Lab
