# Pre-Publish Audit — 2026-04-02

Full-repo review by 6 independent agents. Findings deduplicated and prioritized.

> **Status as of 2026-05-17:** all CRITICAL items (C1–C7) fixed in D28. All IMPORTANT items now resolved: I1/I6/I8/I9/I12 in D28, I2/I4/I5/I10/I11/I14/I15 in 2.0.3 (D35), and I3/I7/I13 in 2.1.0 (D36).

## CRITICAL — Must fix before publish

### C1: CLI missing `.catch()` on request promise chain
- **Package:** `@schmock/cli`
- **File:** `packages/cli/src/cli.ts:156-163`
- **Issue:** `void collectBody(...).then(...)` has no `.catch()`. Unhandled rejection crashes the CLI server on any request error (body too large, plugin failure, stream error). Node 15+ terminates process on unhandled rejections.
- **Fix:** Add `.catch()` that writes a 500 JSON error response, matching the pattern in `builder.ts:342`.

### C2: CLI docs reference non-existent `--faker-seed` flag
- **Package:** `@schmock/cli`
- **File:** `docs/cli.md:34,69`
- **Issue:** Docs say `--faker-seed <number>`. Actual flag is `--seed-random` (see `cli.ts:198,237`).
- **Fix:** Replace `--faker-seed` with `--seed-random` in docs.

### C3: Angular `baseUrl` doesn't strip prefix before routing
- **Package:** `@schmock/angular`
- **File:** `packages/angular/src/index.ts:211,220`
- **Issue:** Docs say "Request to /api/users -> Schmock matches route /users". Code only *filters* by baseUrl but passes the full path (including prefix) to `mock.handle()`. Routes defined as `GET /users` never match when `baseUrl: '/api'` is set.
- **Fix:** Strip baseUrl prefix: `const routePath = baseUrl ? path.slice(baseUrl.length) || '/' : path;`

### C4: Stale hardcoded `version` in 3 plugin objects
- **Package:** `@schmock/faker`, `@schmock/validation`, `@schmock/query`
- **Files:** `packages/faker/src/index.ts:38`, `packages/validation/src/index.ts:55`, `packages/query/src/index.ts:43`
- **Issue:** Plugin objects report `version: "1.0.0"` (or `"1.0.1"`) but packages are at 2.0.0. Debug logs and introspection show wrong version.
- **Fix:** Import version from each package's `package.json`, matching `@schmock/openapi`'s pattern.

### C5: OpenAPI callbacks — completely silent error swallowing
- **Package:** `@schmock/openapi`
- **File:** `packages/openapi/src/callbacks.ts:34-36`
- **Issue:** `.catch(() => {})` discards all callback errors with zero feedback. DNS failures, serialization errors, network timeouts — all invisible.
- **Fix:** Accept error param and log via debug logger.

### C6: OpenAPI generators — 3 `catch { return {} }` patterns
- **Package:** `@schmock/openapi`
- **Files:** `packages/openapi/src/generators.ts:335,382,403`, `packages/openapi/src/request-pipeline.ts:305`
- **Issue:** Schema generation failures silently serve empty `{}` responses. Tests become false positives. Users have no signal that their spec's schemas failed to generate.
- **Fix:** Log via debug logger at minimum. Consider returning 500 status tuples to make failures visible.

### C7: 4 docs pages still use `npm install`
- **Files:** `docs/express.md:6`, `docs/angular.md:6`, `docs/openapi.md:6`, `docs/cli.md:6`
- **Issue:** Inconsistent with getting-started.md, react.md, vue.md which correctly use `bun install`.
- **Fix:** Replace `npm install` with `bun install` in all four files. Also fix `docs/debug-mode.md:54,57,60` (`npm start` → `bun start`).

## IMPORTANT — Should fix before publish

### I1: `server.close()` doesn't terminate keep-alive connections — ✓ RESOLVED (D28)
- **Package:** `@schmock/core`
- **File:** `packages/core/src/builder.ts:375-376`
- **Issue:** `http.Server.close()` stops accepting but doesn't close keep-alive connections. Port leaks in test suites. `close()` is sync but cleanup is async.
- **Fix:** `closeAllConnections()` now called before `close()`.

### I2: Duplicate parameterized routes — both still pushed to `this.routes` — ✓ RESOLVED (2.0.3)
- **Package:** `@schmock/core`
- **File:** `packages/core/src/builder.ts:133-153`
- **Status:** D28 added the warning and dedup in `staticRoutes`. 2.0.3 now also returns early before `this.routes.push`, so `getRoutes()` no longer reports ghost entries.

### I3: `baseUrl` naming misleads — sounds like full URL, only matches pathname — ✓ RESOLVED (2.1.0)
- **Package:** `@schmock/core`, `@schmock/angular`
- **File:** `packages/core/src/interceptor.ts:155-185`, `packages/angular/src/index.ts:202-232`, `schmock.d.ts:433-447`
- **Issue:** Passing `baseUrl: "https://api.example.com"` silently intercepted nothing because the comparison was pathname-only.
- **Fix:** Both adapters now parse the option into origin + path. Path-form (`/api`) keeps current behavior. Origin-form (`https://api.example.com[/v1]`) requires matching origin AND, when a path is present, matching path prefix. Two BDD scenarios added.

### I4: Unbounded `requestHistory` — memory leak — ✓ RESOLVED (2.0.3)
- **Package:** `@schmock/core`
- **File:** `packages/core/src/builder.ts:567`
- **Issue:** Every request pushed with no size limit. CLI server running for hours would eat memory.
- **Fix:** Added `GlobalConfig.maxHistorySize` (opt-in, defaults to unbounded). When set, history is FIFO-evicted past the cap.

### I5: Regex escaping order in `parseRouteKey` — ✓ RESOLVED (2.0.3)
- **Package:** `@schmock/core`
- **File:** `packages/core/src/parser.ts:42-56`
- **Issue:** Special chars were escaped *before* `:param` replacement, so paths with dots/brackets near params produced broken regex (e.g. `:name.json` swallowed `.json` into the param name).
- **Fix:** New approach splits the path on the param token, escapes each literal segment in place, and substitutes the capture group only where a token actually appears. Param names restricted to `[A-Za-z0-9_-]+`.

### I6: Express throws on non-standard HTTP methods — ✓ RESOLVED (D28)
- **Package:** `@schmock/express`
- **File:** `packages/express/src/index.ts:152-154`
- **Issue:** `toHttpMethod()` threw on WebDAV methods (PROPFIND, LOCK). Express middleware returned 500 instead of calling `next()`.
- **Fix:** `toHttpMethod` is now called inside a try/catch that falls through to `next()`.

### I7: Express `errorFormatter` only fires for SchmockError — ✓ RESOLVED (2.1.0)
- **Package:** `@schmock/express`
- **File:** `packages/express/src/index.ts:196-237`
- **Issue:** Generator-throw 500s (which schmock catches internally and returns as `{ code, error }` 500 responses) bypassed the formatter, and the catch-block path only fired for `SchmockError`. Inconsistent with Angular.
- **Fix:** Catch block now routes any `Error`; before sending a response, the middleware also detects schmock's internal 500 `{ error, code }` shape and re-renders it through the formatter. Matches Angular behavior. New BDD scenario.

### I8: React `renderWithSchmock` rerender lacks provider wrapping — ✓ RESOLVED (D26, D28)
- **Package:** `@schmock/react`
- **File:** `packages/react/src/testing.ts:26-33`
- **Issue:** Used `render(createElement(...))` instead of RTL's `wrapper` option. `result.rerender()` wouldn't re-wrap in provider.
- **Fix:** Now uses `render(ui, { wrapper })` pattern so rerender re-wraps automatically.

### I9: Faker `determineArrayCount` breaks on `minItems > maxItems` — ✓ RESOLVED (D28)
- **Package:** `@schmock/faker`
- **File:** `packages/faker/src/overrides.ts:28`
- **Issue:** Negative range produced garbage counts, possibly negative numbers.
- **Fix:** `const max = Math.max(min, schema.maxItems);` guard now in place.

### I10: Faker `validateSchema` is O(n^2+) on deep schemas — ✓ RESOLVED (2.0.3)
- **Package:** `@schmock/faker`
- **File:** `packages/faker/src/validation.ts:140-173`
- **Issue:** Full-tree traversals (`hasCircularReference`, `calculateNestingDepth`, `checkForDeepNestingWithArrays`, `checkArraySizeLimits`) ran on every recursive call.
- **Fix:** Gated those four checks (plus the self-ref `$ref` check, for legacy error-message compatibility) on `path === "$"`. Per-node validations still run on every recursive call.

### I11: Validation plugin — AJV missing `ajv-formats` — ✓ RESOLVED (2.0.3)
- **Package:** `@schmock/validation`
- **File:** `packages/validation/src/index.ts:32-34`
- **Issue:** `format: "email"` (and every other AJV format keyword) silently passed any string. A silent trust violation in a plugin called "validation".
- **Fix:** Added `ajv-formats` as a dependency and call `addFormats(ajv)` after constructing the AJV instance. New BDD scenarios cover the malformed-rejected and well-formed-accepted paths.

### I12: CLI `--port foo` silently becomes random port — ✓ RESOLVED (D28)
- **Package:** `@schmock/cli`
- **File:** `packages/cli/src/cli.ts:199-200`
- **Issue:** `Number("foo")` → NaN → Node treated as 0 (random port). No error message.
- **Fix:** `Number.isInteger(port) && port >= 0 && port <= 65535` validation now fails fast.

### I13: Missing smoke tests for 3 packages — ✓ RESOLVED (2.1.0)
- **Files:** `scripts/smoke-tests/run-all.sh:83`, `scripts/smoke-tests/fixtures/{angular,validation,query}/`
- **Issue:** `angular`, `validation`, `query` had no smoke test fixtures; `ALL_PACKAGES` listed 8 of 11 published packages.
- **Fix:** Added fixtures for each — validation exercises the format keyword (confirms ajv-formats wiring in the published artifact), query exercises pagination/filter/sort, angular instantiates the interceptor and runs a matched + unmatched request. All 11 fixtures now pass.

### I14: `isStatusTuple` misidentifies numeric arrays as tuples — ✓ DOCUMENTED (2.0.3)
- **Package:** `@schmock/core`
- **File:** `packages/core/src/constants.ts:54-68`, `docs/api.md:156-160`
- **Issue:** `[200, 300]` (legitimate data) detected as status tuple `{ status: 200, body: 300 }`.
- **Fix:** Documented the edge case in the constants.ts JSDoc and in docs/api.md, recommending users wrap the array or restructure data that could collide. No code change.

### I15: OpenAPI module-level AJV singleton — `$id` conflicts across specs — ✓ RESOLVED (2.0.3)
- **Package:** `@schmock/openapi`
- **File:** `packages/openapi/src/request-pipeline.ts:185-202`
- **Issue:** Shared AJV instance threw on duplicate `$id` when loading multiple specs in the same process.
- **Fix:** Introduced `BodyValidatorContext` (AJV + schema cache) and `createBodyValidatorContext()`. Each `openapi()` call now builds its own context, threaded through `validateRequestBody`. Plugin-level test exercises two plugins sharing a `$id`.
