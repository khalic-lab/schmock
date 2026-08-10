# @schmock/express

Express middleware adapter for Schmock.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/express
```

## Usage

```typescript
import express from "express";
import { schmock } from "@schmock/core";
import { toExpress } from "@schmock/express";

const mock = schmock();
mock("GET /users", [{ id: 1, name: "Alice" }]);

const app = express();
app.use("/api", toExpress(mock));
```

## Documentation

- [Express adapter](https://github.com/khalic-lab/schmock/blob/main/docs/express.md)
- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)

## License

MIT © Khalic Lab
