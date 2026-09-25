# @schmock/core

Core mock builder, routing, and plugin pipeline for Schmock.

Part of [Schmock](https://github.com/khalic-lab/schmock) — mock APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/core
```

## Usage

```typescript
import { schmock } from "@schmock/core";

const mock = schmock();

mock("GET /users", [{ id: 1, name: "Alice" }]);
mock("POST /users", ({ body }) => [201, body]);

const response = await mock.handle("GET", "/users");
// → { status: 200, body: [{ id: 1, name: "Alice" }] }
```

## For adapter and plugin authors

The root entry also exports the helpers core's own adapters and plugins are
built from. Application code does not need them.

```typescript
// Response results, for plugins
getResponseParts(response: unknown): ResponseParts  // { status, body, headers, kind }
replaceResponseBody(response: unknown, body: unknown): unknown

// Path prefixes: the namespace and baseUrl rule
parsePathPrefix(prefix: string): PathPrefix         // { origin: string | null, path: string }
matchPathPrefix(prefix: PathPrefix, path: string): boolean

// Node ingress: the bridge mock.listen() and the CLI run
serveNodeRequest(req, res, options: ServeNodeRequestOptions): Promise<void>

// Response shaping
withDefaultContentType(response: Response): Response
buildFormattedErrorResponse(options: FormattedErrorOptions): Response

// Headers
SENSITIVE_HEADER_NAMES: ReadonlySet<string>
redactHeaders(headers: Record<string, string>): Record<string, string>
getHeader(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined
```

A plugin that reshapes a body reads the result with `getResponseParts()` and
writes it back with `replaceResponseBody()`, which apply core's envelope rule:

```typescript
import { getResponseParts, replaceResponseBody } from "@schmock/core";

const wrapPlugin: Schmock.Plugin = {
  name: "wrap",
  process(context, response) {
    const { status, body } = getResponseParts(response);
    if (body == null || status >= 300 || context.requestShortCircuited) {
      return { context, response };
    }
    return { context, response: replaceResponseBody(response, { data: body }) };
  },
};
```

A prefix matches on a segment boundary, and one trailing slash is ignored:

```typescript
import { matchPathPrefix, parsePathPrefix } from "@schmock/core";

const prefix = parsePathPrefix("/api/"); // { origin: null, path: "/api" }
matchPathPrefix(prefix, "/api/users"); // true
matchPathPrefix(prefix, "/apiv2"); // false
```

`serveNodeRequest()` serves a mock from any Node server, with the same 400,
405 and 413 answers as `mock.listen()`:

```typescript
import { createServer } from "node:http";
import { schmock, serveNodeRequest } from "@schmock/core";

const mock = schmock();
mock("GET /users", [{ id: 1 }]);

createServer((req, res) => {
  void serveNodeRequest(req, res, { handle: mock.handle, maxBodySize: 1024 * 1024 });
}).listen(3000);
```

`withDefaultContentType()` adds the content type a body implies, and
`buildFormattedErrorResponse()` turns an `errorFormatter` result into a
normalized 500 without ever throwing. The header helpers mask credentials and
look names up case-insensitively:

```typescript
import { buildFormattedErrorResponse, getHeader, redactHeaders, withDefaultContentType } from "@schmock/core";

withDefaultContentType({ status: 200, body: { ok: true }, headers: {} });
// → { status: 200, body: { ok: true }, headers: { "content-type": "application/json" } }

buildFormattedErrorResponse({
  formatter: (error) => ({ message: error.message }),
  error: new Error("boom"),
  method: "GET",
});
// → { status: 500, body: { message: "boom" }, headers: { "content-type": "application/json" } }

redactHeaders({ Authorization: "Bearer t" }); // → { Authorization: "[redacted]" }
getHeader({ "Content-Type": "text/plain" }, "content-type"); // → "text/plain"
```

### `@schmock/core/adapter`

Transport adapters import the request-admission protocol from a separate entry:

```typescript
import { schmock } from "@schmock/core";
import { acquireRequestAdmission } from "@schmock/core/adapter";

const mock = schmock();
mock("GET /users", [{ id: 1 }]);

const admission = acquireRequestAdmission(mock); // undefined for a non-schmock stub
if (admission) {
  try {
    await admission.handle("GET", "/users");
  } finally {
    admission.release();
  }
}
```

It exports `acquireRequestAdmission`, `awaitWithAbort`, `abortReason` and
`createFetchInterceptor`, and the `RequestAdmission` and `MockRequestHandler`
types.

### Deprecated

These are planned for removal in the next major version:

- `createFetchInterceptor` from `@schmock/core`. Use `mock.intercept()`; adapter
  authors import it from `@schmock/core/adapter`.
- `ExpressAdapterOptions` from `@schmock/core`. Import it from `@schmock/express`.
- `AngularAdapterOptions` from `@schmock/core`. Import it from `@schmock/angular`.

See [Adapter-author utilities](https://github.com/khalic-lab/schmock/blob/main/docs/api.md#adapter-author-utilities)
for every signature.

## Documentation

- [Getting started](https://github.com/khalic-lab/schmock/blob/main/docs/getting-started.md)
- [API reference](https://github.com/khalic-lab/schmock/blob/main/docs/api.md)
- [Plugin development](https://github.com/khalic-lab/schmock/blob/main/docs/plugins.md)

## License

MIT © Khalic Lab
