# Pre-Publish Audit — 2026-04-02

Full-repo review by 6 independent agents. Findings deduplicated and prioritized.

> **Status as of 2026-05-17:** all CRITICAL items (C1–C7) fixed in D28. Of the IMPORTANT items, I1/I6/I8/I9/I12 were also fixed in D28 — marked `✓ RESOLVED` below. Remaining open items are scheduled for the 2.0.3 patch (see Tier A plan).

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

### I2: Duplicate parameterized routes — both still pushed to `this.routes`
- **Package:** `@schmock/core`
- **File:** `packages/core/src/builder.ts:133-153`
- **Status:** Warning was added in D28 (`"Duplicate route: … — first registration wins"`) and `staticRoutes` Map already dedups. But `this.routes.push(compiledRoute)` on line 153 still adds the duplicate. `getRoutes()` returns ghost entries.
- **Fix:** Skip the `this.routes.push` when `existing` is truthy.

### I3: `baseUrl` naming misleads — sounds like full URL, only matches pathname
- **Package:** `@schmock/core`
- **File:** `packages/core/src/interceptor.ts:153-155`, `schmock.d.ts:429`
- **Issue:** User passes `baseUrl: "https://api.example.com"`, nothing is intercepted because comparison is against pathname only.
- **Fix:** Rename to `basePath` in docs/types, or handle full URL comparison when protocol is present.

### I4: Unbounded `requestHistory` — memory leak
- **Package:** `@schmock/core`
- **File:** `packages/core/src/builder.ts:567`
- **Issue:** Every request pushed with no size limit. CLI server running for hours will eat memory.
- **Fix:** Add optional `maxHistorySize` config with FIFO eviction.

### I5: Regex escaping order in `parseRouteKey`
- **Package:** `@schmock/core`
- **File:** `packages/core/src/parser.ts:50-54`
- **Issue:** Special chars escaped *before* `:param` replacement. Paths with dots/brackets near params can produce broken regex.
- **Fix:** Replace params first, then escape remaining segments. Or validate param names are `[a-zA-Z0-9_]+`.

### I6: Express throws on non-standard HTTP methods — ✓ RESOLVED (D28)
- **Package:** `@schmock/express`
- **File:** `packages/express/src/index.ts:152-154`
- **Issue:** `toHttpMethod()` threw on WebDAV methods (PROPFIND, LOCK). Express middleware returned 500 instead of calling `next()`.
- **Fix:** `toHttpMethod` is now called inside a try/catch that falls through to `next()`.

### I7: Express `errorFormatter` only fires for SchmockError
- **Package:** `@schmock/express`
- **File:** `packages/express/src/index.ts:220-222`
- **Issue:** Regular errors from hooks bypass the formatter. Inconsistent with Angular adapter which formats all errors.
- **Fix:** Call formatter for all errors, or document the restriction.

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

### I10: Faker `validateSchema` is O(n^2+) on deep schemas
- **Package:** `@schmock/faker`
- **File:** `packages/faker/src/validation.ts:28-173`
- **Issue:** Full-tree traversals (`hasCircularReference`, `calculateNestingDepth`, `checkForDeepNestingWithArrays`) run on every recursive call.
- **Fix:** Run expensive checks only at top level (`path === "$"`).

### I11: Validation plugin — AJV missing `ajv-formats`
- **Package:** `@schmock/validation`
- **File:** `packages/validation/src/index.ts:32`
- **Issue:** `format: "email"` silently passes any string. Users expect format validation from a validation plugin.
- **Fix:** Install `ajv-formats` and apply it, or document the limitation.

### I12: CLI `--port foo` silently becomes random port — ✓ RESOLVED (D28)
- **Package:** `@schmock/cli`
- **File:** `packages/cli/src/cli.ts:199-200`
- **Issue:** `Number("foo")` → NaN → Node treated as 0 (random port). No error message.
- **Fix:** `Number.isInteger(port) && port >= 0 && port <= 65535` validation now fails fast.

### I13: Missing smoke tests for 3 packages
- **Files:** `scripts/smoke-tests/run-all.sh:83`
- **Issue:** `angular`, `validation`, `query` have no smoke test fixtures.
- **Fix:** Create minimal fixtures and add to ALL_PACKAGES.

### I14: `isStatusTuple` misidentifies numeric arrays as tuples
- **Package:** `@schmock/core`
- **File:** `packages/core/src/constants.ts:58-68`
- **Issue:** `[200, 300]` (legitimate data) detected as status tuple `{ status: 200, body: 300 }`.
- **Fix:** Document the edge case. Consider requiring explicit `status()` helper for disambiguation.

### I15: OpenAPI module-level AJV singleton — `$id` conflicts across specs
- **Package:** `@schmock/openapi`
- **File:** `packages/openapi/src/request-pipeline.ts:185`
- **Issue:** Shared AJV instance throws on duplicate `$id` when loading multiple specs.
- **Fix:** Create per-plugin AJV instance or strip `$id` in normalizer.
