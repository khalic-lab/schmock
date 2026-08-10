# @schmock/angular

Angular HTTP interceptor adapter for Schmock.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/angular
```

## Usage

```typescript
import { provideHttpClient, withInterceptorsFromDi } from "@angular/common/http";
import { schmock } from "@schmock/core";
import { provideSchmockInterceptor } from "@schmock/angular";

const mock = schmock();
mock("GET /users", [{ id: 1, name: "Alice" }]);

export const appConfig = {
  // `withInterceptorsFromDi()` is required: bare `provideHttpClient()` never
  // reads the HTTP_INTERCEPTORS token, so the mock would silently not run.
  providers: [
    provideHttpClient(withInterceptorsFromDi()),
    provideSchmockInterceptor(mock, { baseUrl: "/api" }),
  ],
};
```

## Documentation

- [Angular adapter](https://github.com/khalic-lab/schmock/blob/main/docs/angular.md)
- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)

## License

MIT © Khalic Lab
