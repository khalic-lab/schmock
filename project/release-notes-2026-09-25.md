# Release notes draft: 2026-09-25 review branch

Every user-visible change on `feature/review-2026-09-25` (base `main` at 16b120a),
grouped by package. Written for the changelog of the release that ships the
branch; see `REVIEW-2026-09-25.md` for the findings behind it.

## Before release

- **Peer ranges on `@schmock/core`.** `@schmock/express`, `@schmock/angular`,
  `@schmock/vue`, `@schmock/validation` and `@schmock/query` still declare
  `peerDependencies` `@schmock/core ^2.4.1`, but they now import the new core
  exports (`@schmock/core/adapter`, `getResponseParts`, `serveNodeRequest`,
  `parsePathPrefix`, and so on). Bump core's minor version and raise every peer
  range to it, or a consumer with an older core installed fails at import.
- **@schmock/openapi needs a higher `@schmock/core` range.** openapi now emits
  route keys that only the new core route grammar parses (`{job}:cancel`
  becomes an escaped colon, `{user.id}` a quoted parameter name). Raise
  `packages/openapi/package.json`'s `@schmock/core` dependency (currently
  `^2.4.1`) to the core version that ships this change.

## @schmock/core

### Added

- Route grammar: `\:` is a literal colon, `:"name"` quotes a parameter name
  that contains other characters, and a hyphen before another parameter is a
  literal separator (`:from-:to`).
- `@schmock/core/adapter`, a new entry for adapter authors:
  `acquireRequestAdmission`, `awaitWithAbort`, `abortReason`,
  `createFetchInterceptor`, and the `RequestAdmission` and `MockRequestHandler`
  types.
- Root helpers for adapter and plugin authors: `getResponseParts`,
  `replaceResponseBody`, `parsePathPrefix`, `matchPathPrefix`,
  `serveNodeRequest`, `withDefaultContentType`, `buildFormattedErrorResponse`,
  `SENSITIVE_HEADER_NAMES`, `redactHeaders`, `getHeader`, and the
  `InvalidHttpMethodError` class. `getResponseParts` returns the raw carried
  body (`null` stays `null`), and a plain `null`/`undefined` result has status
  204.
- Named type exports: `PaginateOptions`, `PaginatedResponse<T>`,
  `RequestStartEvent`, `RequestMatchEvent`, `RequestNotFoundEvent`,
  `RequestEndEvent`, `SchmockEventMap`, `SchmockEvent`, `OpenApiRefPolicy`,
  `OnSchemaCallback`, `OnSchemaContext`, `ResponseParts`, `PathPrefix`,
  `FormattedErrorOptions`, `ServeNodeRequestOptions`,
  `ServeNodeResponseContext`, `HttpErrorReply`.
- `intercept()`'s `errorFormatter` receives the request as a second argument
  (after `beforeRequest`; the pre-hook request if the hook threw; the bodyless
  incoming request if the body could not be read). Additive.

### Deprecated (removal planned for the next major)

- `createFetchInterceptor` from the root entry. Use `mock.intercept()`;
  adapter authors import it from `@schmock/core/adapter` (same function).
- `ExpressAdapterOptions` from `@schmock/core`. Use `@schmock/express`'s.
- `AngularAdapterOptions` from `@schmock/core`. Use `@schmock/angular`'s.

### Changed

- **Route parameters.** In a segment with several parameters, each one except
  the last now stops at the first character of the literal after it, as in
  Express: `:name.:ext` on `a.tar.gz` gives name `a`, ext `tar.gz` (previously
  `a.tar` / `gz`). Two adjacent parameters (`/:a:b`) throw `ROUTE_PARSE_ERROR`.
  A raw backslash directly before a colon in a route key is now read as an
  escape.
- **Namespace trailing slash.** `'/api/'` and `'/api'` are the same namespace.
  Under `'/api/'`, `/api//users` is now 404; it used to be served. An
  origin-form namespace matches on its path only.
- **Plugins.** `pipe()` throws `PLUGIN_INVALID` for a plugin that could never
  work, and piping the same plugin object twice is a no-op. `uninstall()`
  receives a read-only, expiring instance
  (`PLUGIN_UNINSTALL_OPERATION_UNSUPPORTED`, `PLUGIN_UNINSTALL_SCOPE_EXPIRED`).
  An invalid `process`/`beforeRequest` result now fails with `PluginError`
  `Plugin "x" failed: didn't return valid result` (was a plain Error wrapped as
  `Plugin "x" failed: Plugin x didn't return valid result`); `onError` hooks
  see the `PluginError`, and it is not wrapped twice.
- **Plugin hook types.** `install()`/`uninstall()` return `PluginHookResult`
  (exported): any value that is not a thenable, which is ignored. An async hook
  is a compile error, and async `uninstall()` no longer compiles (it was ignored
  at runtime). Expression-bodied arrows such as
  `install: (mock) => mock('GET /health', {...})` keep compiling. A hook
  explicitly typed `=> unknown` does not.
- **Route parameters, encoded separators.** When the separator between two
  parameters in one segment percent-encodes (a non-ASCII letter, say), the
  earlier capture ends at the whole encoded separator and may contain other
  encoded characters. Before, any encoded character ended it.
- **Nested interception leases.** A lease without `beforeRequest` claims the
  request before answering, so an older `passthrough: false` lease no longer
  answers 400 or 404 for a request a newer lease passed through. A lease with
  `beforeRequest` still answers 400 `MALFORMED_JSON` before its hook.
- **Static route data.** A static body with an own `__proto__` key keeps it
  through the copy a piped plugin triggers; it used to be dropped and the copy
  re-prototyped.
- **Request admissions.** `RequestAdmission` gains an optional
  `hasRoute(method, path)`; admissions from `schmock()` carry it, and the fetch
  interceptor uses it to skip reading a passthrough request's body. A response
  from a hand-written admission passed to `createFetchInterceptor` is now
  normalized like a mock's own (hop-by-hop headers dropped, HEAD body stripped).
- **`serveNodeRequest()`.** `maxBodySize` is optional and defaults to 10 MiB,
  and a new `answerBeforeBody(method, path)` option answers a request without
  reading its body. The structural request and response types are exported as
  `NodeRequestLike` and `NodeResponseLike`.
- **Events and history.** A cancelled request emits `request:end` with status
  499. History records the request as the client sent it, before plugins or
  the generator edit it.
- **`mock.listen()`.** Answers 400 `BAD_REQUEST` for a missing Host header
  (`Missing Host header`), a malformed one (`Malformed Host header`) or a
  malformed request target, and 405 `METHOD_NOT_ALLOWED` with `Allow` for an
  unsupported verb. `//users` is routed by its full path. Any body failure
  (400 or 413) closes the connection. Every response with a body declares
  `Content-Length`.
- **`toHttpMethod`** throws `InvalidHttpMethodError` (code
  `INVALID_HTTP_METHOD`, a `SchmockError`); the message is unchanged.
- **Fetch interceptor.** A non-standard method (`PROPFIND`, `PURGE`) is a
  route miss instead of a rejection. With `passthrough: false`, malformed JSON
  gets 400 `MALFORMED_JSON`. A `baseUrl` without a leading slash is rooted.
  With `passthrough: true` and no `beforeRequest`, a request no route matches
  is never read or parsed: it reaches the network untouched, so an unreadable
  body (malformed multipart, an erroring stream) sent to an unmocked URL passes
  through instead of rejecting the fetch. Debug mode logs `bodyType: 'none'`
  for such a request. A `beforeResponse` hook that returns a `null` body now
  gets `content-type: application/json`.
- **`collectBody()`** returns an object, string, `FormData` or `ArrayBuffer`
  according to the content type (it used to return a raw string), decodes
  urlencoded, `text/*` and `multipart/*`, adds the `JSON_TOO_DEEP` and
  `MALFORMED_MULTIPART` codes, and reads `content-type`/`content-length`
  case-insensitively.
- **`awaitWithAbort`** with an already-aborted signal returns a rejected
  promise instead of throwing synchronously.

## @schmock/faker

Seeded output changes against 2.4.1: regenerate seeded snapshots.

- Explicit schema keywords (`default`/`example`, `const`, `enum`, `pattern`,
  `faker`, `$ref`, a generatable `format`, `schmockTrueProbability`) now win
  over field-name heuristics. Defaults and examples are honoured.
- Weighted booleans draw from faker's seeded RNG, so nullable roll positions
  shift. (A seed-42, 200-item, 0.8 split was observed moving from 162/38 to
  158/42; no test pins that figure.)
- Every date mapping emits an ISO-8601 UTC date-time, whatever the time zone.
- Native 3.1 `[T, 'null']` unions are nulled at about 5%.
- Plural primitive arrays map through their singular name (`emails`).
- Keywords shorter than 5 characters match only on token edges, so `latency`
  and `population` no longer map to latitude; qualifier-suffixed fields
  (`phoneType`, `emailStatus`) no longer map.
- Dotted overrides no longer replace arrays with objects.
- The `chance` keyword is rejected at validation.
- An `if` beside a `then` is charged against the per-node limits at creation
  (json-schema-faker generates from it), with its size keywords capped by the
  parent's and `then`'s maximums. `prefixItems`, `contains` (up to
  `minContains` copies), `containsAll` and every other generating keyword now
  count against the node budget, so some deeply nested schemas that passed
  creation before are rejected.
- A non-schema entry in a tuple `items` list or in `prefixItems` is rejected
  with `SchemaValidationError`; booleans are still allowed.
- A list or map keyword of the wrong shape (`allOf` given as an object,
  `properties` given as a string) fails with `SchemaValidationError` at the
  keyword path instead of a raw `TypeError`.
- Pattern keys are compiled the same way everywhere (key invention, nullable
  rolls, validation), so a pattern that compiles only without the `u` flag no
  longer skips the nullable roll.
- The `deep_nesting_memory_risk` and `memory_estimation` resources are removed;
  a new aggregate `generated_chars` budget (16,777,216 UTF-16 code units per
  response) can reject schemas accepted before.
- `MAX_OBJECT_PROPERTIES` and `MAX_STRING_LENGTH` are exported.
- One keyword table now drives validation, smart mapping and JSF
  normalization. Valid schemas generate exactly as before (129 probes diffed).
  Malformed input changes:
  - With several faults, validation can report a different first one, since
    it visits keywords in table order (for example `$.definitions.X` instead of
    `$.items.$ref`). Pass/fail is unchanged.
  - JSF normalization drops a malformed map entry, maps a malformed positional
    entry to `true` so later positions keep their place, and keeps a malformed
    single-schema keyword's raw copy. Cases that threw `TypeError` (such as
    `properties: { a: 5 }`, `items: null`, `allOf` garbage) no longer throw
    there; `properties: { a: [1] }` is dropped instead of becoming `{}`.
  - Map keywords given as arrays are walked by index. Validation now descends
    into array-valued `definitions`, `$defs` and `dependentSchemas`
    (a bad child is rejected at `$.definitions.0.faker`), and smart mapping
    turns array-valued `patternProperties`, `definitions`, `$defs` and
    `dependentSchemas` into index-keyed maps.
  - Smart mapping drops a map entry whose value is `undefined`.

## @schmock/validation

- New `response.statuses` option (`'2xx'` or a list of statuses).
- Query and header schemas coerce scalar types; bodies stay strict. A value
  coerced to a number must be a finite plain decimal (`-3`, `2.5`, `007`):
  `Infinity`, `1e400`, exponents such as `1e1`, hex, binary and octal
  literals, a leading `+` or `.`, and padded values are rejected with the
  slot's validation error.
- Header schema names are matched case-insensitively; names that differ only
  by case are rejected at creation. The check walks only the header schema,
  its `allOf`/`anyOf`/`oneOf`/`if`/`then`/`else`/`not` and schema-form
  `dependencies` subschemas, and the `$ref` targets they reach; a schema with
  an unrelated definition that used to throw at creation now constructs.
  Headers the schema names reach `patternProperties` and `propertyNames` in
  the schema's own spelling; every other header arrives lowercased.
- With `response.body` configured, a tuple's headers are read inside the
  plugin: a throwing getter on a tuple's third element now gives 500
  `PLUGIN_ERROR` `Plugin "validation" failed: …` instead of `INTERNAL_ERROR`.

## @schmock/query

- Leaves responses with status 400 or above untouched.
- Validates `sorting.default` and `sorting.defaultOrder` at creation, clamps
  `defaultLimit` to `maxLimit`, and matches `order` case-insensitively.
- A tuple's headers are read inside the plugin: a throwing getter on a tuple's
  third element now gives 500 `PLUGIN_ERROR` `Plugin "query" failed: …`
  instead of `INTERNAL_ERROR`.

## @schmock/openapi

- **External `$ref` security.** The unsafe-address block applies to every
  address a host resolves to, at connect time, over a pinned connection, and
  adds CGNAT, reserved and IPv6 transition ranges. `allowedHosts` entries are
  subject to it too. Only http(s) redirect targets are followed, and
  `redirects` is a real hop limit. A document fetched over http can no longer
  read local files. `maxBytes` is enforced while streaming, on decoded bytes.
  Timeouts and network failures are named in the error.
- **Proxies.** http `$ref`s connect directly through `node:http` and ignore
  `HTTP_PROXY`/`HTTPS_PROXY`, so a proxy cannot resolve a name past the
  address check. Anyone who relied on a proxy for `$ref` fetches is affected,
  notably Bun users, whose `fetch` honoured those variables.
- A hostname refused after DNS resolution fails with ref-parser's
  `ResolverError` (not a `SchmockError`), or with `OPENAPI_INVALID_SPEC` under
  `strict`. Only a literal refused host gives `OPENAPI_EXTERNAL_REF_BLOCKED`.
- **Prototype pollution.** A spec envelope property named `__proto__` no
  longer pollutes `Object.prototype` when a list request is served; the list
  generator writes every key with `Object.defineProperty`.
- **List envelopes.** The collection array is also found when composition
  makes it nullable (`anyOf: [{type: array}, {type: null}]`, 3.0 `allOf` with
  `nullable: true`), when it is a `oneOf` of array or object, and when it is
  `{type: array}` without `items`; such envelopes used to hide the live
  collection. The envelope keeps its declared key order (the array was
  serialized last). A list contract with no array-like property whose declared
  object cannot be generated serves the bare collection with a console warning
  instead of a structured 500.
- **Resources option.** A `resources` key that names no detected CRUD resource
  throws `OPENAPI_UNKNOWN_RESOURCE_OVERRIDE` (context `{ key, resources }`)
  instead of being ignored; when the key is a renamed resource's old name
  (`':owner'`), the message names the key to use (`'repos'`).
- **Spec option.** A `spec` that is neither a path string nor a document
  object throws `SchmockError` `OPENAPI_INVALID_SPEC` (was a plain `Error`).
- **Seed option.** An unknown seed key throws `OPENAPI_UNKNOWN_SEED_RESOURCE`;
  a non-object seed or a bad entry shape throws `OPENAPI_INVALID_OPTION`. Both
  were ignored silently. Seed loading failures (a seed file that is not valid
  JSON or not a JSON array, an invalid `{ count }`, a `{ count }` for a resource
  with no schema) are now `SchmockError` `OPENAPI_INVALID_OPTION` with context
  `{ option: 'seed', resource, file? }` instead of plain `Error`s; messages are
  unchanged. This also affects CLI `--seed` manifests at startup.
- **Prefer.** Any applied `Prefer` directive (`code`, `example`, `dynamic`) on
  a CRUD mutation is a pure simulation: nothing is stored, even for a 2xx such
  as `Prefer: code=201` on POST.
- **Generation.** A lone item GET answers from its schema when nothing is
  seeded (it used to answer 404 forever). Object/array schema examples are no
  longer returned verbatim. `writeOnly` fields are not copied through on open
  contracts. A create declaring 201 and 200 answers 201. An integer-or-null
  field no longer generates `NaN` (a 500 `INVALID_RESPONSE` before). 3.1
  nullable unions are null about 5% of the time instead of about 50%. The
  `$ref` sibling result no longer depends on document order.
- **Routing.** Custom methods (`{job}:cancel`) and dotted parameters
  (`{user.id}`) route correctly (needs the new core; see "Before release").
- **Callbacks** read the response body with core's envelope rule. An object
  whose `headers` are not a string record is the delivered body: for
  `{ status: 201, body: { id: 1 }, headers: { 'x-n': 1 } }`,
  `{$response.body#/id}` is unresolved and the callback is skipped, while
  `#/body/id` resolves to `1`.
- File-path specs load from disk under jsdom and happy-dom.
- `OnSchemaCallback`, `OnSchemaContext`, `OpenApiRefPolicy`,
  `ResourceOverride` and `CrudOperationMeta` are exported by name.

## @schmock/cli

- `--port`, `--admin-history-limit` and `--seed-random` take decimal digits
  only. `--port=` used to fall back to 3000 and a blank value to a random port.
- `--admin-token` without `--admin` is an error.
- Errors are `SchmockError`: flag and config errors carry `INVALID_CONFIG`
  with context `{ flag, value? }` or `{ option }`, and seed-manifest errors
  carry `OPENAPI_INVALID_OPTION`. Messages and the `Schmock failed: <msg>`
  output are unchanged, but `err.name` (and `String(err)`) change from `Error`
  to `SchmockError`.
- Requests go through core's `serveNodeRequest`:
  - a malformed Host header gets 400 `Malformed Host header` (was
    `Malformed request target`; status and code unchanged);
  - a target starting with `//` is a path (`GET //users` used to reach
    `GET /`);
  - 400 `MALFORMED_JSON`, `JSON_TOO_DEEP` and `MALFORMED_MULTIPART` close a
    kept-alive connection, as a 413 did;
  - the admin API (Origin 403, token 401 and the endpoint answer) and a CORS
    preflight are answered before the request body is read, so a stalled,
    oversized or malformed body never delays or changes them and a preflight
    with a malformed JSON body gets 204;
  - admin answers declare `Content-Length` instead of chunked encoding;
  - a broken request admission still answers 500
    `Schmock returned an invalid request admission`, after the body is read,
    and the admin API keeps answering.
- A watch reload resets state and history and says so on stderr.
- With `--refs-external`, a reload is triggered by the spec, the seed files
  and non-hidden `.json`/`.yaml`/`.yml` siblings of the spec only. Other
  writes in the spec directory (log files, text files, `.DS_Store`, editor
  swap and backup files) no longer reload, so output redirected there cannot
  feed a reload loop.
- Admin history masks credential-shaped header and query names.
- The IPv6 banner is bracketed.
- `run()` keeps its SIGINT/SIGTERM handlers until close settles; a repeated
  signal is acknowledged, and a signal after `shutdownGraceMs` forces an exit.
- Type-level: `CliOptions` is a type alias of `Schmock.CliOptions`, so it can
  no longer be augmented by declaration merging; augment `Schmock.CliOptions`.

## @schmock/express

- A repeated query key resolves to its last value (was the first). The default
  query re-reads the query string of `req.url`, the URL `req.path` comes from,
  so bracket keys stay literal under Express 4's `qs` parser and a
  URL-rewriting middleware moves path and query together. A `req.query` that
  earlier middleware assigned or redefined is ignored unless `transformQuery`
  is supplied.
- Route headers are sent verbatim; no charset is appended to `content-type`.
- A `null` body with no declared content type (from `beforeResponse`, say) is
  sent with `application/json`, as `mock.listen()` and the CLI send it.
- A mock whose admission factory returns a non-admission fails with
  `SchmockError` `INVALID_REQUEST_ADMISSION` (was a plain `Error`). With
  `passErrorsToNext: false` and no formatter the body code changes from
  `INTERNAL_ERROR` to `INVALID_REQUEST_ADMISSION`, and `next(error)` receives
  a `SchmockError`. The message is unchanged.
- With `passErrorsToNext: false`, a `beforeRequest` that rewrites the method to
  an unsupported verb renders code `INVALID_HTTP_METHOD` instead of
  `INTERNAL_ERROR`.

## @schmock/angular

- A repeated query key resolves to its last value (was the first).
- `errorFormatter` output is normalized: no body on HEAD, Dates as ISO
  strings, `content-type` forced to JSON, and a fallback body
  (`{ error: 'Internal Server Error', code: 'INTERNAL_ERROR' }`) for output
  that cannot be serialized, including a body with an `undefined`-valued
  property such as `{ code: error.code }` for an error without a code.
- `createSchmockInterceptorFromSpec` and `provideSchmockInterceptorFromSpec`
  reject with `SchmockError` `OPENAPI_PEER_UNAVAILABLE` (the import failure in
  `context.cause`) when `@schmock/openapi` is missing or does not export an
  `openapi()` factory. They remain Node/test-only: a bundled browser app pipes
  `openapi()` itself and uses `provideSchmockInterceptor(mock)`.
- The spec helpers load `@schmock/openapi` through a computed specifier;
  webpack may print a harmless "Critical dependency" warning.
- `baseUrl` matching is canonical, as in the fetch interceptor: `'/caf%C3%A9'`
  matches `/café/...` and the reverse, and a non-ASCII path base now also
  matches an absolute request URL (it used to pass through). A `baseUrl`
  without a leading slash (`'api'`) is `'/api'`; it used to match nothing. The
  stripped remainder keeps the request's spelling.
- A promise returned from `transformRequest` or `transformResponse` is awaited.
  Before, a `transformRequest` promise was spread into the request (its
  override silently dropped) and a `transformResponse` promise produced a 500.
- New `beforeRequest`/`beforeResponse` options, which may be async and where
  returning nothing means no change. `transformRequest`/`transformResponse`
  win when both names are set.

## @schmock/react

- The provider takes its interception lease during render, so a fetch started
  in render is intercepted on first mount. Nested leases of one mock dedupe on
  the effective request.

## @schmock/vue

- `schmockPlugin` accepts `options` as an alias of `interceptOptions`; the
  latter wins when both are given.
