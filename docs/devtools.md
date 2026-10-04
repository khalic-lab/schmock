# DevTools

Chrome's Network panel does not list a request that `mock.intercept()` answers
because the network never sees it. The `@schmock/devtools` package reports each
request in a collapsed console group and a custom track in the Performance
panel. Its [service-worker relay](#network-panel-relay) also lists them in the
Network panel.

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

1. Use Chrome 128 or later. Other browsers keep the measures but show no
   custom track (see [Other browsers](#other-browsers)).
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

## Network panel relay

The console group and the Performance track sit beside the Network panel. The
relay puts mocked requests in it. `startServiceWorkerRelay()` registers a
service worker, `schmock-sw.js`, that answers the page's `fetch` and XHR
requests. The worker sends each request over a `MessageChannel` to the page,
where your `mock.intercept()` leases answer it as before, and hands the
response back to the browser. Chrome then lists the request as a native row
with Size `(ServiceWorker)`. The filter `is:service-worker-intercepted` shows
only those rows.

XHR is mocked too. Fetch interception never sees an XHR, but the worker does.
A piped `devtoolsPlugin()` still reports relayed requests, so each one gets a
console group and a Performance entry next to its Network row.

Behaviour marked *observed* on this page was measured in headless Chrome on
2026-10-03, unless it names another browser; the rest follows from the code. Mocked `fetch` and XHR requests
both showed as Network rows served by the service worker (observed).

### Setup

**1. Serve the worker script.** Copy `schmock-sw.js` into the directory your
dev server serves at the site root:

```sh
npx schmock-devtools init public
```

The command creates the directory if it is missing, replaces an older copy,
and prints the next step. Run it again after each upgrade of
`@schmock/devtools` so the script matches the page library.

To copy the script during the build instead, point your bundler's copy plugin
at `node_modules/@schmock/devtools/dist/schmock-sw.js`. The package does not
export the script, so a deep import such as
`import swUrl from '@schmock/devtools/dist/schmock-sw.js?url'` is refused.
Copy it; don't import it.

**2. Start the relay before the app renders.**

```typescript
import { schmock } from '@schmock/core'
import { devtoolsPlugin, startServiceWorkerRelay } from '@schmock/devtools'

const mock = schmock()
mock.pipe(devtoolsPlugin())
mock('GET /api/users', [{ id: 1, name: 'Alice' }])
mock.intercept()

await startServiceWorkerRelay()

startApp()
```

Await it before the app makes its first request. Until the relay is live, a
`fetch` is answered in the page with no Network row, and an XHR goes to the
network unmocked. The relay serves every lease on the page, whether it was
taken before or after the relay started, so the order relative to
`mock.intercept()` does not matter.

Once the worker is installed the wait is short. A relay that falls back with
`"timeout"` or `"not-controlled"` holds the first render for up to `timeout`
(5 s by default).

**Where the script lives.** A service worker controls only the pages under its
scope, and the default scope is the script's directory: `/schmock-sw.js`
covers the whole origin, `/mocks/schmock-sw.js` only pages under `/mocks/`.
Serve the script at or above the pages that start the relay, normally at `/`.
A page outside the scope falls back at once with `"not-controlled"` and
registers nothing (observed). Registering with a `scope` wider than the script's directory rejects with a
`SecurityError` (observed), and the relay falls back with
`"registration-failed"`, unless the server sends a `Service-Worker-Allowed`
header.

**Secure context.** Service workers need https or `localhost`. In Chrome an
insecure page has no `navigator.serviceWorker` at all, so it falls back with
`"unsupported"`, not `"insecure-context"` (observed).

### `startServiceWorkerRelay(options?)`

```typescript
function startServiceWorkerRelay(options?: ServiceWorkerRelayOptions): Promise<ServiceWorkerRelay>

interface ServiceWorkerRelayOptions {
  url?: string      // where the app serves schmock-sw.js (default: '/schmock-sw.js')
  scope?: string    // registration scope (default: the browser's, the script's directory)
  timeout?: number  // ms for the whole start, and for stop()'s acknowledgement (default: 5000)
}
```

`url` and `scope` resolve against the page's base URL (`document.baseURI`, or
`location.href` without a document). The worker is registered with
`updateViaCache: 'none'`, so a script copied again installs on the next load.

`timeout` is one deadline for the whole start: the lookup of an existing
registration, the registration, activation, taking control of the page and
the handshake. It also bounds how long `stop()` waits for the worker. A
deadline that expires while the relay waits for control gives
`"not-controlled"`. Anywhere else it gives `"timeout"`.

The promise rejects only for a caller error:

- invalid options reject with a `SchmockError` with the code
  `DEVTOOLS_CONFIG_INVALID`;
- a relay with other options that is already starting or running rejects with
  `DEVTOOLS_RELAY_ALREADY_STARTED` (see [Starting twice](#starting-twice)).

Every failure on the browser's side resolves with a relay that fell back
instead, and mocking continues in the page.

Options are checked first, before the relay looks for service-worker support,
in this order:

- `options` must be an object when given;
- `url` and `scope` must be non-empty strings;
- `timeout` must be a positive finite number;
- `url` and `scope` must resolve against the page URL.

Only the first invalid option is reported. `context.option` names it and
`context.received` holds its value, as in
`startServiceWorkerRelay: timeout must be a positive finite number (received 0)`.

### The relay object

```typescript
interface ServiceWorkerRelay {
  readonly active: boolean
  readonly fallbackReason: RelayFallbackReason | undefined
  stop(): Promise<void>
}
```

- `active` is `true` while the worker relays this page's requests. Read it
  live: it turns `false` while the relay reconnects after a worker update, and
  stays `false` after a fallback or `stop()`.
- `fallbackReason` says why the relay fell back. It is `undefined` while the
  relay starts, while it is active or reconnecting, and after `stop()`.
- `stop()` hands `fetch` back to in-page interception at once, then tells the
  worker to forget this page and waits for its acknowledgement, up to
  `timeout`. From then on a `fetch` is answered in the page with no Network
  row, and XHR is no longer mocked. A request the worker relayed before it
  processed the goodbye is still answered by the mock. `stop()` is idempotent.
  On a relay that fell back it resolves at once and clears `fallbackReason`.
  It never unregisters the worker (see [Unregistering](#unregistering)).

After `stop()` or a fallback, calling `startServiceWorkerRelay()` again starts
a new relay.

**Worker updates.** When a new version of the worker takes control of the
page, the relay releases its hold, so `fetch` is answered in the page
meanwhile, and repeats the handshake with a fresh `timeout`. During that,
`active` is `false` and `fallbackReason` is `undefined`. The relay goes live
again, or falls back: `"protocol-mismatch"` or `"timeout"` for Schmock's
script, `"not-controlled"` when another script took control.

**Page lifecycle.** A page that unloads tells the worker to forget it. A page
that enters the back/forward cache keeps its relay and needs no new handshake
when it comes back.

### Fallback reasons

A relay that cannot go live resolves with `active: false` and a
`fallbackReason`, and logs one `console.warn`. Mocking goes on in the page:
`fetch` is answered there with no Network row, and XHR is not mocked. Every
warning starts with `Schmock relay: `. In the texts below, `<url>` is the
script's absolute URL, such as `http://localhost:5173/schmock-sw.js`, and
`<publicDir>` is printed as is.

| Reason | When | Warning |
|--------|------|---------|
| `unsupported` | No `navigator.serviceWorker`: Node, a browser without service workers, an insecure page in Chrome, or a sandboxed iframe without `allow-same-origin`, where reading it throws (observed). | `Schmock relay: service workers are unavailable here, so mocked requests stay in the page and do not appear in the Network panel.` |
| `insecure-context` | The browser exposes service workers on a page that is not a secure context. Chrome does not, so there the reason is `unsupported`. | `Schmock relay: service workers need a secure context (https or localhost), so mocked requests stay in the page.` |
| `scope-taken` | Another script is registered at exactly the relay's scope. Nothing is registered. | `Schmock relay: <scriptURL> already controls this scope; Schmock will not replace it. Unregister it while developing, or give Schmock its own scope.` |
| `registration-failed` | The browser refused the registration (script not served, script error, scope wider than the script's directory), or the worker failed to install. | `Schmock relay: could not register <url> (<message>). Run "npx schmock-devtools init <publicDir>" and serve the file at <url>.` |
| `not-controlled` | The URL the page was loaded at is outside the scope: the script's directory, or the `scope` option. Nothing is registered and nothing waits. Not checked for a page the Schmock worker already controls, or for a srcdoc, blob or `about:blank` document. | `Schmock relay: <url> can only control pages under <scope>, and this page is <pageUrl>. Serve the script at or above this page, or pass a scope that covers it.` |
| `not-controlled` | The worker could not take control of the page within `timeout`, and no worker controls it. | `Schmock relay: this page is not controlled by the Schmock service worker (a hard reload bypasses service workers); reload normally.` |
| `not-controlled` | Another worker still controls the page when `timeout` expires, or took it over after a worker update. | `Schmock relay: this page is controlled by <scriptURL>, which Schmock will not replace. Unregister it while developing, or give Schmock a scope that covers this page.` |
| `protocol-mismatch` | The served script speaks another relay protocol: it was copied from an incompatible version. | `Schmock relay: <url> speaks relay protocol <n>, this page expects <m>. Run "npx schmock-devtools init <publicDir>" again.` |
| `timeout` | The deadline expired while the relay looked up, registered or activated the worker, or the worker never answered the handshake. | `Schmock relay: the service worker did not get ready within <timeout> ms, so mocked requests stay in the page.` |

Two other messages leave the relay running:

- A script copied from another `@schmock/devtools` version that speaks the
  same protocol warns
  `Schmock relay: <url> comes from @schmock/devtools <version>, this page uses <version>. Run "npx schmock-devtools init <publicDir>" to update it.`
  and the relay goes live.
- A relayed request whose mock fails, for example through a hook that throws
  with no `errorFormatter`, logs
  `Schmock relay: <METHOD> <request url> failed in the mock, so the page receives a network error.`
  through `console.error`, with the original error as the second argument.

### Starting twice

A page has one relay. A call while a relay is starting or active:

- with the same options returns the same promise, and so the same relay. The
  options are compared after resolving: `url`, `scope` and `timeout`. `{}` and
  `{ url: '/schmock-sw.js' }` are the same. `{}` and `{ scope: '/' }` are not,
  because an omitted scope is left to the browser;
- with other options rejects with a `SchmockError` with the code
  `DEVTOOLS_RELAY_ALREADY_STARTED`. Its `context` holds `running` and
  `requested`, both resolved. Call `stop()` on the running relay first.

Code that runs twice in one page, such as a module re-run by hot module
replacement, gets the same relay back. The `unsupported` and
`insecure-context` fallbacks keep nothing: each call warns again and returns a
new relay object.

### Recipes

Each recipe assumes `schmock-sw.js` is served at `/`.

#### Plain app

Use the snippet in [Setup](#setup): `mock.intercept()`, then
`await startServiceWorkerRelay()`, then start the app.

#### React

```typescript
import { createRoot } from 'react-dom/client'
import { schmock } from '@schmock/core'
import { devtoolsPlugin, startServiceWorkerRelay } from '@schmock/devtools'
import { SchmockProvider } from '@schmock/react'
import { App } from './App'

const mock = schmock()
mock.pipe(devtoolsPlugin())
mock('GET /api/users', [{ id: 1, name: 'Alice' }])

await startServiceWorkerRelay()

createRoot(document.getElementById('root')!).render(
  <SchmockProvider mock={mock}>
    <App />
  </SchmockProvider>,
)
```

`SchmockProvider` takes its lease when it renders, and the relay routes it.
The provider needs no new prop.

#### Vue

```typescript
import { createApp } from 'vue'
import { schmock } from '@schmock/core'
import { devtoolsPlugin, startServiceWorkerRelay } from '@schmock/devtools'
import { schmockPlugin } from '@schmock/vue'
import App from './App.vue'

const mock = schmock()
mock.pipe(devtoolsPlugin())
mock('GET /api/users', [{ id: 1, name: 'Alice' }])

const app = createApp(App)
app.use(schmockPlugin, { mock })

await startServiceWorkerRelay()
app.mount('#app')
```

#### Angular

`provideSchmockInterceptor` answers inside Angular's interceptor chain, so the
request never leaves Angular and never reaches the worker. Replace it with a
`mock.intercept()` lease and start the relay before bootstrapping:

```typescript
import { provideHttpClient, withFetch } from '@angular/common/http'
import { bootstrapApplication } from '@angular/platform-browser'
import { schmock } from '@schmock/core'
import { devtoolsPlugin, startServiceWorkerRelay } from '@schmock/devtools'
import { AppComponent } from './app/app.component'

const mock = schmock()
mock.pipe(devtoolsPlugin())
mock('GET /api/users', [{ id: 1, name: 'Alice' }])
mock.intercept({ baseUrl: '/api' })

startServiceWorkerRelay()
  .then(() =>
    bootstrapApplication(AppComponent, {
      providers: [provideHttpClient(withFetch())],
    }),
  )
  .catch((err) => console.error(err))
```

Under the relay both `HttpClient` backends work: the default XHR backend's
requests reach the worker as XHRs, and `withFetch()` sends them through
`fetch`. Keep `withFetch()` anyway. If the relay falls back, `fetch` is still
mocked in the page and XHR is not mocked at all. The
[Angular guide](./angular.md#chrome-devtools) lists what changes when you
leave `provideSchmockInterceptor`.

### Fetch mode vs relay mode

| Aspect | Fetch mode (default) | Relay mode |
|--------|----------------------|------------|
| Network row for a mocked request | none | one, Size `(ServiceWorker)` (observed for `fetch` and XHR) |
| XHR mocked | no | yes |
| Scripts, styles, images, fonts, navigations | never seen | never relayed (scripts and images untouched, observed) |
| Request no mock answers | one row | two rows: the page's, served by the worker, and the worker's own fetch (observed) |
| The mock fails, for example a hook throws with no `errorFormatter` | `fetch` rejects with that error | `fetch` rejects with a `TypeError` and XHR fires `error`; the original error is logged |
| Relative `fetch` and an origin-form `baseUrl` naming the page origin | no match | matches |
| Abort | the mock ends the request with `request:end` 499 | the row is canceled and `fetch` rejects with an `AbortError`; the mock did not see the abort (observed) |
| Lease restored, or the mock reset, after the call | the leases and routes of the call answer | the request is routed when it reaches the page, a task or more later, by the leases and routes of that moment: a lease restored right after the call no longer answers it |
| A mocked redirect (3xx with `Location`) | `fetch` receives the 3xx | the browser follows it as it would a server's: the follow-up request goes through the relay and reaches the network unless a route answers it; `redirect: 'manual'` gives status 0 (`opaqueredirect`) and `redirect: 'error'` rejects (observed) |
| Headers a route sees | the ones the page set | those plus browser defaults; only `accept: */*` was added (observed) |
| `response.url` | the URL without its fragment | the URL without its fragment (observed) |
| `response.type` | `default` | `basic`, cross-origin included (observed) |
| Cross-origin request a lease answers (origin-form `baseUrl` for another origin) | readable | readable, custom headers such as `x-total-count` included (observed) |
| Bodiless `POST` (`fetch` or XHR) | no body | no body (observed) |
| Explicit empty request body | empty | empty |
| Before the relay is live | n/a | `fetch` answered in the page, XHR not mocked |
| Performance entry vs Network row | no row | the entry is shorter by the worker round trip |

The Performance entry starts when the page receives the request from the
worker, so it is usually a few milliseconds shorter than the Network row.

### Which requests the worker relays

- **Only requests from a page that started the relay.** The worker keeps a
  list of the pages (tabs, iframes, workers) that said hello, and sends each
  request back to the page that made it. One tab's mock never answers another
  tab. Another page under the same worker that never started the relay is
  untouched (observed).
- **Only requests with an empty destination:** `fetch()` and XHR, and also
  `navigator.sendBeacon()` and `EventSource`. Navigations, scripts, styles,
  images and fonts are never relayed, so a `passthrough: false` lease cannot
  answer the app's own assets with 404s.
- **Not `only-if-cached` requests** whose mode is not `same-origin`.

The worker stores its list of pages in Cache Storage, in a cache named
`schmock-relay-v<protocol>` (`schmock-relay-v1` today), so the relay survives
Chrome stopping an idle worker. Right after a restart the worker holds
requests until it has read the list back. If Cache Storage fails, it keeps the
list in memory.

### Hazards

- **Bypass for network.** With **Bypass for network** checked under
  Application → Service workers, Chrome skips the worker. The page still holds
  the relay, so its `fetch` requests reach the real network unmocked, and so
  do its XHRs. The page cannot detect this. **Update on reload** is harmless.
- **Another service worker.** The relay never replaces the app's own worker,
  such as a PWA's or MSW's:
  - at exactly the relay's scope, it falls back with `"scope-taken"` and
    registers nothing;
  - at a parent scope (the app's worker at `/`, the relay given
    `scope: '/app/'`), there is no conflict: Schmock registers its own
    narrower registration, and pages under `/app/` are then controlled by
    Schmock's worker instead of the app's. The script must sit under `/app/`,
    or the server must allow the scope with `Service-Worker-Allowed`;
  - at a narrower scope (the app's worker at `/app/`, the relay at `/`), the
    app's worker keeps the `/app/` pages. The relay waits the full `timeout`,
    then falls back with `"not-controlled"` and names that worker.

  Unregister the app's worker while developing, or give Schmock a scope that
  covers the page more closely than the app's worker does.
- **Redirects.** A route that answers 3xx with a `Location` is followed by the
  browser under the relay, as a server's redirect would be. In fetch mode the
  caller receives the 3xx itself. Mock the target too, or the follow-up
  request reaches the network (observed).
- **A miss can be routed twice around a worker update or `stop()`.** While the
  relay reconnects after a worker update, and after `stop()` until the worker
  acknowledges it, `fetch` is answered in the page. A fetch no lease answers
  passes through, the worker still relays it back, and the mock is consulted
  again: `request:start`, `request:notfound` and `request:end` fire twice.
- **Hard reload.** Shift+Reload loads the page without its service worker, so
  the relay asks the active worker to claim the page. After a hard reload the
  relay re-claimed the page and came back active, with no warning (observed).
  If a claim does not take, the relay falls back with `"not-controlled"` and
  the "reload normally" warning.
- **Synchronous XHR.** `xhr.open(method, url, false)` deadlocks: the main
  thread blocks while the worker waits for the page to answer. It is not
  supported under the relay.
- **Cleared Cache Storage.** App code that deletes every cache also deletes
  the worker's list of pages. Once the worker restarts, it forgets the page
  while the page still holds the relay, and the page's `fetch` requests and
  XHRs reach the network unmocked, silently. Reload the page, or call `stop()`
  and start the relay again.
- **A canceled request may still run in the mock.** Aborting a relayed request
  cancels its Network row (`net::ERR_ABORTED`, canceled) and the page's `fetch`
  rejects with an `AbortError`. The mock did not see the abort, though: no
  `request:end` 499 was recorded (observed). The mock may run the request to
  completion, and `devtoolsPlugin()` would then report it as answered. In fetch
  mode the mock gets the abort and ends the request with 499.
- **A page that dies mid-request.** If a tab closes or crashes after the
  worker relayed one of its requests, no answer comes, and the request stays
  pending in the worker until Chrome stops the worker. Nothing is visible.
- **Two rows for a request no mock answers.** The page's row, served by the
  worker, comes with the worker's own fetch to the network (observed). Hide
  the second with the filter `-is:service-worker-initiated`. Only `fetch` and
  XHR requests from relaying pages that no lease answered get two rows.
- **Two copies of `@schmock/core`.** If the bundle holds two copies, nothing
  is relayed: XHRs pass through to the real network (observed). A monorepo
  `tsconfig` `paths` alias caused this during verification: it can point
  `@schmock/core` or `@schmock/core/adapter` at source while
  `@schmock/devtools` resolves the published `dist`, which brings its own copy.
  The relay holds and routes through that other copy, which has none of the
  app's leases, so `relay.active` still reads `true` while the app's copy keeps
  answering `fetch` in the page with no Network row. Make sure the bundle
  resolves one copy of `@schmock/core`.

### Development only

Start the relay behind your bundler's development flag, as with the plugin:

```typescript
if (import.meta.env.DEV) {
  const { devtoolsPlugin, startServiceWorkerRelay } = await import('@schmock/devtools')
  mock.pipe(devtoolsPlugin())
  await startServiceWorkerRelay()
}
```

`npx schmock-devtools init public` puts the script in a directory that the
production build copies too. A script that no page registers does nothing. To
keep it out of production output, copy it only in development builds.

### Unregistering

`stop()` leaves the worker registered: unregistering would affect every other
tab, and the worker leaves pages that never started the relay to the network.
To remove it, use **Unregister** under Application → Service workers, or:

```typescript
for (const registration of await navigator.serviceWorker.getRegistrations()) {
  if (registration.active?.scriptURL.endsWith('/schmock-sw.js')) {
    await registration.unregister()
  }
}
```

### Other browsers

The relay uses only standard service-worker APIs, so it is not tied to
Chrome. On 2026-10-04 we ran it in Playwright's WebKit 26.6 (the engine
behind Safari) and Firefox 155 with the same checks as Chrome, and
observed:

- The relay went live and the worker took control of the page.
- The browser reported every mocked `fetch` and XHR, POSTs with a body
  included, as answered by the service worker. No mocked request reached
  the server, and requests no mock answered reached it with their bodies
  intact.
- The console groups were logged.
- Aborting a relayed `fetch` canceled it in the page, but the mock still
  ran the route to completion, as in Chrome.

What differs:

- Firefox and Safari lack the custom Performance track because it is a
  Chrome DevTools extension. They keep the `performance.measure()` entries
  as plain User Timing entries, without the `Schmock` track or its colors.
- Firefox's Network Monitor and Safari's Web Inspector mark service-worker
  responses their own way. The network labels
  `is:service-worker-intercepted`, `-is:service-worker-initiated` and the
  `(ServiceWorker)` Size belong to Chrome. Neither UI was inspected, and
  Safari itself, as opposed to Playwright's WebKit build, was not run.

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
| answered | The mock answered. The report shows the response the caller received after `beforeResponse` and `errorFormatter`. With `passthrough: false`, this includes the 404 for an unrouted request and the 400 for a malformed JSON body. A route that throws is answered too, with core's 500 response or with what `errorFormatter` makes of the error. |
| failed | The caller's `fetch` rejected. This happens if a `beforeRequest` or `beforeResponse` hook throws and no `errorFormatter` replaces the error, or if the formatter itself throws. |
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
