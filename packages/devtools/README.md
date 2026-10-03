# @schmock/devtools

This package shows the requests your Schmock mocks answer in Chrome DevTools.
It creates one collapsed console group and one Performance-panel track entry
per mocked request.

This package is part of [Schmock](https://github.com/khalic-lab/schmock), which
mocks APIs from OpenAPI specs or hand-crafted routes.

## Install

```bash
bun add -d @schmock/devtools
```

`@schmock/core` is a peer dependency.

## Usage

```typescript
import { schmock } from "@schmock/core";
import { devtoolsPlugin } from "@schmock/devtools";

const mock = schmock();
mock.pipe(devtoolsPlugin());
mock("GET /api/users", [{ id: 1, name: "Ada" }]);
mock.intercept();
```

Each request the mock handles through `mock.intercept()` is reported, whether it
was answered, failed or aborted. That includes requests that go through React's
`SchmockProvider` or Vue's `schmockPlugin`:

- The console shows a collapsed group titled like
  `Schmock GET /api/users → 200 (1.4 ms)`. This group holds the request and
  then the response, the error, or `Aborted by the client`.
- The Performance panel shows an entry on a `Schmock` custom track. This
  needs Chrome 128+, a recording, and **Show custom tracks** turned on under
  Capture settings.

Requests passed through to the network, `mock.handle()` calls and Angular's
`provideSchmockInterceptor` are not reported. `mock.reset()` removes the
plugin, so pipe it again after a reset.

## Options

```typescript
devtoolsPlugin({
  console: true,       // log one collapsed group per request (default: true)
  performance: true,   // add one Performance-panel track entry per request (default: true)
  track: "Schmock",    // track name, also the console badge (default: "Schmock")
  trackGroup: "My app" // group the track in the Performance panel (default: none)
});
```

An invalid option throws a `SchmockError` with code `DEVTOOLS_CONFIG_INVALID`.

## Development only

```typescript
if (import.meta.env.DEV) {
  const { devtoolsPlugin } = await import("@schmock/devtools");
  mock.pipe(devtoolsPlugin());
}
```

See [docs/devtools.md](https://github.com/khalic-lab/schmock/blob/main/docs/devtools.md) for the full guide.
