# @schmock/react

React adapter for Schmock — a Provider, a hook, and test utilities that intercept `fetch`.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/react
```

## Usage

```tsx
import { schmock } from "@schmock/core";
import { SchmockProvider } from "@schmock/react";

const mock = schmock();
mock("GET /users", [{ id: 1, name: "Alice" }]);

export function App({ children }) {
  return <SchmockProvider mock={mock}>{children}</SchmockProvider>;
}
```

## Documentation

- [React adapter](https://github.com/khalic-lab/schmock/blob/main/docs/react.md)
- [Testing patterns](https://github.com/khalic-lab/schmock/blob/main/docs/testing.md)

## License

MIT © Khalic Lab
