# DevTools

Chrome's Network panel does not list a request that `mock.intercept()` answers
because the network never sees it. The `@schmock/devtools` package reports each
request in a collapsed console group and a custom track in the Performance
panel.

```sh
bun install @schmock/devtools
```

## Quick start

```typescript
import { schmock } from '@schmock/core'
import { devtoolsPlugin } from '@schmock/devtools'

const mock = schmock()
mock('GET /api/users', [{ id: 1, name: 'Alice' }])

mock.pipe(devtoolsPlugin())
mock.intercept()
```

The plugin reports every `fetch` the mock handles, whether it was answered,
failed or aborted. It never changes a response because its `process` hook
passes the response on exactly as it found it.

## What you see

### Console

One collapsed group per request:

```text
Schmock GET /api/users?page=2 → 200 (1.4 ms)
  Request  { method: 'GET', url: 'http://localhost:5173/api/users?page=2', headers: {…} }
  Response { status: 200, headers: {…}, body: [{…}] }
```

The title has four parts:

- The badge shows the track name (`Schmock` by default). Its color indicates the
  outcome: green below 400, amber for 4xx, red for 5xx and failures, grey for
  aborts.
- The method and URL show the path and query for a request to the page's own
  origin. Any other origin keeps the absolute URL.
- The outcome shows the status, `failed: <message>`, or `aborted`.
- The duration displays with one decimal place.

The `Request` inside the group holds the method, the absolute URL, the headers
and the body if one exists. Either the `Response` (status, headers, body), the
error the fetch rejected with (logged through `console.error`), or
`Aborted by the client` comes after it. Header names are lowercased. Bodies
display as their values before serialization, such as parsed JSON, instead of
bytes.

### Performance panel

Each request also appears as a `performance.measure()` entry on a custom track
named `Schmock`. Follow these steps to see the track:

1. Use Chrome 128 or later.
2. In the Performance panel, open **Capture settings** (the gear icon) and turn
   on **Show custom tracks**.
3. Start a recording, let the app make its requests, and stop.

Entries appear only during a recording. Each entry spans from the `fetch` call
to the moment its outcome settles. The tooltip displays `GET <url> → 200`.
Selecting an entry lists the Method, URL, Outcome and Duration. The entry uses
a color from the DevTools palette based on its outcome:

| Outcome | Color |
|---------|-------|
| status below 400 | `primary` |
| 4xx | `tertiary` |
| 5xx, or failed | `error` |
| aborted | `secondary` |

These measures stay in the page's User Timing buffer. This means
`performance.getEntriesByType('measure')` and any `PerformanceObserver` can see
them. The plugin never clears them.

> **Coming next:** a service-worker relay that makes mocked requests show up in
> the Network panel itself.

## `devtoolsPlugin(options?)`

```typescript
function devtoolsPlugin(options?: DevtoolsPluginOptions): Plugin

interface DevtoolsPluginOptions {
  console?: boolean      // one collapsed console group per request (default: true)
  performance?: boolean  // one Performance-panel track entry per request (default: true)
  track?: string         // track name, also the console badge (default: 'Schmock')
  trackGroup?: string    // group the track under this name in the Performance panel
}
```

```typescript
mock.pipe(devtoolsPlugin({ track: 'Users API', trackGroup: 'My app' }))
```

The plugin uses the name `devtools`. It reads options once upon creation.
Changing the options object afterwards has no effect. Give each mock its own
plugin with a different `track` to get one track per mock. A shared `trackGroup`
keeps those tracks together.

### Option errors

Creating the plugin with invalid options throws a `SchmockError` with the code
`DEVTOOLS_CONFIG_INVALID`. The plugin enforces these rules:

- `options` must be an object when given;
- `console` and `performance` must be booleans;
- `track` and `trackGroup` must be non-empty strings.

The plugin checks options in this order and reports only the first invalid one.
The `context.option` field names the invalid option, while `context.received`
holds its value. The resulting message looks like
`devtoolsPlugin: track must be a non-empty string (received "")`.

## When requests are reported

The plugin reports any request that the mock settles through `mock.intercept()`.
This behavior covers the leases taken by React's `SchmockProvider` and Vue's
`schmockPlugin`. The plugin reports each request once with one of three
outcomes:

| Outcome | When |
|---------|------|
| answered | The mock answered. The report shows the response the caller received after `beforeResponse` and `errorFormatter`. With `passthrough: false`, this includes the 404 for an unrouted request and the 400 for a malformed JSON body. |
| failed | The caller's `fetch` rejected. This happens if a hook or route throws and no `errorFormatter` replaces the error, or if the formatter itself throws. |
| aborted | The caller aborted the request while this mock was answering. |

The plugin does not report these requests:

- requests passed through to the network, because the Network panel already
  shows them;
- `mock.handle()` calls and transports built on them, including `mock.listen()`,
  the Express adapter, the CLI, and Angular's `provideSchmockInterceptor`;
- requests that reached the mock before the plugin was piped or before the
  last `reset()` call.

Only the mock that answers reports the request when several mocks intercept. A
fetch is never reported twice. This remains true even if another mock missed it
first or the same mock holds several leases. The plugin reports an abort only
if this mock was the one answering it. It reports nothing if an abort lands
while a mock is still deciding, such as inside an async `beforeRequest`.

### After `reset()`

Calling `reset()` removes every piped plugin, including this one, but keeps
`intercept()` leases active. This means requests are still mocked but no longer
reported. You must pipe the plugin again after each reset:

```typescript
mock.reset()
mock.pipe(devtoolsPlugin())
mock('GET /api/users', [{ id: 1, name: 'Alice' }])
```

The plugin does not report a request that is in flight when `reset()` runs.

## Angular

The `provideSchmockInterceptor` transport answers through `mock.handle()` inside
Angular's interceptor chain. The plugin never sees these requests. You can
report Angular traffic by replacing the interceptor with
`provideHttpClient(withFetch())` and `mock.intercept()`. The
[Angular guide](./angular.md) contains the recipe and explains what changes
when you switch.

## Keep it out of production

The plugin exists for development use. You should load it behind your bundler's
development flag so production builds leave it out:

```typescript
if (import.meta.env.DEV) {
  const { devtoolsPlugin } = await import('@schmock/devtools')
  mock.pipe(devtoolsPlugin())
}
```

The `import.meta.env.DEV` variable is Vite's flag. Other bundlers have an
equivalent flag, such as `process.env.NODE_ENV !== 'production'`.

## Writing your own reporter

`devtoolsPlugin()` returns an ordinary plugin built on the `onExchange` hook.
You can read [Observing exchanges](./plugins.md#observing-exchanges) to learn
how to send mocked traffic somewhere else.
