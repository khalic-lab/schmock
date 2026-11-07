# Decisions

### D1: Use global fetch interception (monkey-patch) for React/Vue (2026-04-01)

React and Vue have no built-in HTTP interception point unlike Express middleware or Angular HttpInterceptor. The team chose to patch globalThis.fetch directly (MSW-style) for both test-time and dev-time use cases. The alternative — shipping a Schmock-powered fetch client users must explicitly adopt — was rejected as too invasive to application code.

### D2: mock.intercept() and shared primitives fold into @schmock/core (2026-04-01)

Early brainstorm considered @schmock/fetch and @schmock/adapter-core as separate packages. After reviewing the codebase, the operator concluded these belong in core: mock.intercept() is the client-side equivalent of mock.listen() and belongs at the same abstraction level. A separate interceptor package was also proposed (@schmock/interceptor) but rejected for the same reason. Core now owns: mock.intercept(), response helpers (notFound, created, paginate, etc.), and isRouteNotFound() utility.

### D3: Adapter packages are facades; core does not contain them (2026-04-01)

There was a moment of confusion about whether the adapter facades should live in core. Resolved: core provides primitives (mock.handle(), mock.intercept(), helpers, isRouteNotFound). Each adapter package (@schmock/express, @schmock/angular, @schmock/react, @schmock/vue) owns its own facade — the framework-specific request/response conversion and lifecycle wiring. Core does not import or know about any framework.

### D4: Single-install packaging: one package per framework (2026-04-01)

The meta-package @schmock/schmock previously bundled everything including Express and Angular, giving React developers unused deps. New model: framework entry points (@schmock/react, @schmock/vue, @schmock/express, @schmock/angular) each bring core as a dependency and are the single install for their ecosystem. Plugins (@schmock/faker, @schmock/openapi, etc.) remain additive. @schmock/schmock becomes core + plugins only, no framework adapters.

### D5: @schmock/react test utility ships as a separate subpath export (2026-04-01)

renderWithSchmock depends on @testing-library/react which not all users will install. To avoid breaking non-test builds, the test utility is exported from @schmock/react/testing as a separate entry point, not from the main index. Listed as an optional peer dependency in package.json.

### D6: CLI depends on core and openapi only — not Express (2026-04-01)

An assumption in the spec that CLI needed Express was caught in review. Verified by reading the source: CLI implements its own HTTP server using node:http directly, using core utilities (writeSchmockResponse, collectBody, parseNodeHeaders, parseNodeQuery). It depends on @schmock/core and @schmock/openapi only. Spec was corrected before implementation began.

### D7: Global fetch interception for client-side adapters (2026-04-01)

React and Vue adapters intercept HTTP by monkey-patching globalThis.fetch. Any fetch-based library call (axios, react-query, swr, plain fetch) is intercepted automatically without changes to application code. A Schmock-powered explicit fetch client (Option B) was considered and rejected — it requires callers to swap their fetch references. The hybrid option (C) was also rejected as YAGNI. Approach mirrors MSW's model and works in both Node 18+ (tests) and browser (dev-time), which the operator noted is already table-stakes for React tooling.

### D8: Interceptor primitives live in core; adapters own their facades (2026-04-01)

Three package structures were considered: (1) @schmock/adapter-core + @schmock/interceptor as standalone packages, (2) everything folded into @schmock/core, (3) a core interceptor module with adapter-core as a separate facade layer. The operator rejected options 1 and 3 — the shared logic does not justify extra packages, and facades belong in the adapter packages not in core. Final structure: @schmock/core gains mock.intercept() (fetch patching + handle bridging), isRouteNotFound() (shared utility extracted from Express and Angular), and response helpers (notFound, badRequest, unauthorized, forbidden, serverError, created, noContent, paginate — previously duplicated in Angular). Each adapter package is a thin facade converting its framework types in/out of mock.handle(). AdapterRequest, AdapterResponse, InterceptOptions, InterceptHandle types live in schmock.d.ts.

### D9: Single-install packaging per framework (2026-04-01)

Framework entry points (@schmock/react, @schmock/vue, @schmock/express, @schmock/angular) each pull in everything a developer needs. A React developer runs 'bun install @schmock/react' and gets core + interceptor + React bindings — no stray Angular or Express dependencies. The @schmock/schmock meta-package drops @schmock/express and @schmock/angular from its dependencies; it now covers core + plugins only. Plugins (@schmock/faker, @schmock/validation, @schmock/openapi, etc.) remain additive and installed separately.

### D10: CLI uses node:http directly, not Express (2026-04-01)

CLI was initially described as 'standalone' but code inspection revealed it uses node:http directly with core utilities (writeSchmockResponse, collectBody, parseNodeHeaders, parseNodeQuery). CLI depends on @schmock/core and @schmock/openapi — not Express. Adding Express as a CLI dependency would have been wrong. The meta-package retains CLI as a bundled tool, not an adapter.

### D11: @schmock/react/testing as separate subpath entry point (2026-04-01)

renderWithSchmock (a @testing-library/react convenience wrapper) is exported from @schmock/react/testing, not from the main index. This keeps @testing-library/react as an optional peer dependency — users who don't write component tests with renderWithSchmock do not need it installed. The package.json exports map defines the /testing subpath separately.

### D12: BDD coverage floor for framework adapters (2026-04-01)

**Superseded by D30.** The original floor duplicated core routing,
passthrough, status, and request-body behavior in every adapter. Adapter BDD
now covers only framework-specific installation, lifecycle, cleanup, context,
and reconfiguration behavior; shared fetch behavior is owned by core.

Historically, each framework adapter feature duplicated (1) basic GET mocking,
(2) passthrough, (3) error status propagation, (4) POST JSON handling, and
(5) context/provider errors. D30 replaces that floor with framework-boundary
coverage and assigns shared interception behavior to the core feature suite.

### D13: Agent Teams as execution mechanism (2026-04-01)

The operator requested the experimental Agent Teams (teammates) feature rather than subagent-driven-development or executing-plans. Three persistent teammates were created: core-dev (packages/core), adapter-dev (packages/express, angular, schmock), frontend-dev (packages/react, vue). Tasks 1+2 ran first in isolated worktrees (background Agent tool), then the team executed Tasks 3-8 with core-dev and adapter-dev running concurrently. The CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 env var was added to settings.json to enable the feature.

### D14: Global fetch interception (MSW-style) for React and Vue (2026-04-01)

Rather than providing a replacement fetch client or framework-specific HTTP adapters, the React and Vue adapters intercept globalThis.fetch by patching it. This supports both test-time (Node 18+) and browser/dev-time environments without requiring any changes to application code. The approach mirrors MSW conceptually.

### D15: mock.intercept() belongs in core, not a separate package (2026-04-01)

An initial proposal to publish @schmock/interceptor as a standalone package was rejected. fetch interception is the client-side equivalent of mock.listen() and belongs at the same layer of abstraction inside @schmock/core. Core gains mock.intercept(options?) which returns { restore(), active }.

### D16: Facade pattern stays per-adapter; core provides primitives only (2026-04-01)

Each adapter package (Express, Angular, React, Vue) owns its own facade — the framework-specific conversion logic. Core exports primitives (isRouteNotFound, response helpers, mock.intercept()) but does not contain any facade. An earlier design that placed shared facade logic in an adapter-core package was rejected.

### D17: Response helpers and isRouteNotFound extracted to core (2026-04-01)

notFound(), badRequest(), unauthorized(), forbidden(), serverError(), created(), noContent(), and paginate() were previously duplicated in the Angular adapter. isRouteNotFound() detection was duplicated in both Express and Angular. Both are now in @schmock/core and re-exported by adapters that need them.

### D18: Single-install packaging model per framework (2026-04-01)

Each framework adapter package (@schmock/react, @schmock/vue, @schmock/express, @schmock/angular) is a complete install — it brings core and all required dependencies. Users do not need to manually install @schmock/core separately. Plugins (@schmock/faker, @schmock/openapi, etc.) remain additive opt-ins.

### D19: Meta-package strips framework adapter dependencies (2026-04-01)

@schmock/schmock no longer depends on @schmock/express or @schmock/angular. It is core + plugins. Framework-specific code now lives exclusively in the framework packages. CLI (@schmock/cli) was confirmed to use node:http directly (not Express) and remains in the meta-package alongside core utilities it depends on.

### D20: React test utilities published as @schmock/react/testing subpath (2026-04-01)

renderWithSchmock and related test helpers require @testing-library/react, which should not be a mandatory dependency for all React adapter users. They are published under a /testing subpath export so the peer dependency is optional and only needed by users who import the test utilities.

### D21: Integration runner must use `bun run test`, not `bun test`, for vitest packages (2026-04-01)

When the integration test runner called `bun test` for the React and Vue fixtures, Bun used its built-in test runner, which ignores vitest.config.ts entirely — meaning no jsdom environment was injected. Every test that touched `document` or `@testing-library/react` crashed with `ReferenceError: document is not defined`. The runner was updated to call `bun run test` instead, which invokes the `test` script in package.json and goes through Vitest with the correct jsdom environment. Packages that use Bun's native runner (core, express) are unaffected.

### D22: `extractHeaders` normalizes all header keys to lowercase (2026-04-02)

In `@schmock/core`'s `mock.intercept()` implementation, `extractHeaders` now normalizes all header keys to lowercase across all three input formats (Headers instance, array of tuples, plain object). This matches the `Headers` Web API behavior and means handlers always read `headers.authorization`, never `headers.Authorization`. The Headers instance path already returned lowercase keys; the array and plain-object paths were updated to call `.toLowerCase()` on each key.

### D23: E2E tests should simulate the first-install developer journey, not just API correctness (2026-04-01)

After integration tests passed (4/4), the operator decided additional E2E coverage should mirror the realistic onboarding experience: what someone following the docs would actually build after a fresh install. The goal is confidence that a new user can install a package, wire it up following the standard pattern, and have it work — not just that the API surface is correct. The assistant began writing new test files targeting this "I just installed this, now what?" perspective.

### D24: Todo CRUD as shared baseline across all adapter integration fixtures (2026-04-01)

The operator asked to unify the integration fixtures around a common Todo CRUD scenario (load all todos, add a todo, toggle completion, delete, error handling on 4xx/5xx) so that each adapter can be compared on equal footing. The plan is to merge the basic and app-specific fixtures into a single fixture per adapter, with `testing-patterns` and `express-dev-proxy` retained as specialized extras. Fixture rewrite was started but the session ended mid-discussion about how to source the todo component implementations.

### D25: Angular baseUrl strips prefix before routing (behavioral clarification) (2026-04-02)

The Angular adapter's `baseUrl` option was documented to strip the prefix before passing the path to `mock.handle()` — e.g., a request to `/api/users` with `baseUrl: '/api'` should match a route registered as `GET /users`. The implementation was not doing this; it only used `baseUrl` as a filter. The code was corrected to strip the prefix: `const routePath = baseUrl ? path.slice(baseUrl.length) || '/' : path`. The docs were already correct; this fix aligns the implementation with the stated and intended behavior.

### D26: renderWithSchmock uses RTL wrapper option for rerender provider preservation (2026-04-02)

The original `renderWithSchmock` implementation wrapped the component by passing it as a child to `SchmockProvider` directly. This meant calling `result.rerender(newUi)` would not re-wrap in the provider, breaking the context for re-renders. The implementation was changed to use React Testing Library's `wrapper` option: `render(ui, { wrapper: ({ children }) => createElement(SchmockProvider, { mock, options }, children) })`. This ensures `rerender()` also wraps its argument in the provider automatically.

### D27: extractBody prioritizes init.body over Request.body per Fetch spec (2026-04-02)

When `fetch()` is called with a `Request` object as input and an `init` object with a `body` property, the Fetch specification states that `init.body` takes precedence over `input.body`. The `extractBody` function in the core interceptor was updated to check `init?.body` first before falling back to reading from the `Request` object's body stream. This is a spec-compliance fix that also avoids consuming a potentially already-read body stream.

### D28: Full pre-publish audit conducted; critical and important issues fixed; deferred items tracked in AUDIT.md (2026-04-02)

A six-reviewer audit of the entire repository was conducted before promotion. Reviewers covered: core package, all plugins, all framework adapters, CLI/docs/tests/config, silent failure patterns, and type system design. Seven critical and five important issues were identified and fixed in a team session (coder + test-writer + test-runner teammates). Twelve issues were resolved: CLI missing `.catch()`, angular baseUrl stripping, plugin version strings hardcoded at 1.x, OpenAPI callback silent failure, three `catch { return {} }` patterns in generators, four doc pages using `npm install`, `server.closeAllConnections()` for port leak, Express non-standard HTTP method passthrough, `renderWithSchmock` rerender fix, faker `minItems > maxItems` guard, and CLI invalid port validation. Remaining items (unbounded request history, duplicate parameterized route handling, regex escaping order, `isStatusTuple` ambiguity, AJV missing formats, type system improvements) are tracked in `AUDIT.md` as deferred work. All ~1,652 tests pass after fixes.

### D29: Fix all type hygiene issues found in pre-publish audit (D29) (2026-04-04)

The operator reviewed the full type hygiene audit and instructed 'Fix ALL'. Scope of fixes decided:

1. **`any` cleanup** — `@schmock/query`: `items: any[]`, `response?: any`, `data: any[]` (pervasive in index.ts). `@schmock/faker`: `data: any`, `state?: any`, `overrides?: Record<string, any>`. `@schmock/express`: `body?: any` in five inline callback shapes. `@schmock/angular`: `body?: any` in transform options.
2. **Dedup 3 duplicate types** — `SchemaGenerationContext`, `FakerPluginOptions` (faker/src/index.ts vs. schmock.d.ts), `OpenApiOptions` (openapi/src/plugin.ts vs. schmock.d.ts). `schmock.d.ts` is the source of truth; packages re-export from there.
3. **Named types for repeated adapter shapes** — response shape `{ status: number; body: any; headers: Record<string, string> }` repeated in Express and Angular with slight variations; request transform shape repeated inline in both.
4. **Missing explicit return types** — `schmock()`, `handle()`, `generateFromSchema()`, `queryPlugin()`, `applyOverrides()`, and ~4 others.
5. **String literal unions** — validation error codes (`"REQUEST_VALIDATION_ERROR"` etc.) and content-type literals (`"application/json"` etc.) to become named union types.

Two `as any` casts in `faker/src/jsf-config.ts:30,40` were flagged as suspicious (json-schema-faker API boundary) but are included in the fix scope. Implementation started (all relevant files read), session ended before edits were applied.

**Status (2026-09-25 review):** items 4–5 are partly closed. The response helpers now return literal status tuples (`notFound()` is `[404, object]`, `noContent()` is `[204, null]`), and `paginate` takes `readonly T[]`. Still open: an exported `SchmockErrorCode` union, a `ValidationErrorCode` union, and explicit return types for `SchmockProvider` and the Angular providers (`multi: true`).

### D30: BDD feature files refactored to eliminate redundancy; adapters restricted to framework-specific integration behavior (2026-04-04)

After receiving the consolidated BDD quality audit across all 37 feature files, the operator instructed 'FIX ALL'. Audit identified: ~25 scenarios to remove (trivial, exact duplicates, tests of framework/language behavior rather than Schmock), ~12 to merge, ~15 to rewrite (weak assertions, vague titles, implementation-detail tests), ~5 to split (bloated multi-behavior scenarios). Key cross-file duplications identified: passthrough/baseUrl tested 4×, error status codes 5×, POST with JSON 3×, plugin pipeline 3×. The governing principle established: adapter feature files (angular-adapter, react-adapter, vue-adapter, express-adapter) must cover only framework integration concerns — HttpResponse wrapping, Provider lifecycle, middleware wiring — and must not re-test core routing, error handling, or response helpers already covered in core-owned feature files. developer-experience.feature to be stripped to genuine DX pitfalls only. Five parallel agents were launched to execute the changes.

### D31: Property-based testing using fast-check required to close edge-case gaps (2026-04-04)

After BDD cleanup, the operator assessed that unit tests alone were insufficient and directed a full audit for missing property-based testing, edge cases, and failure modes. fast-check was already installed in the project. Four parallel agents wrote 108 new tests (+2,110 lines) covering: route matching round-trip invariants, response parsing determinism, header normalization invariants, override shape preservation, DANGEROUS_KEYS rejection, template idempotency, pagination boundaries, status code boundaries, content negotiation q-values, empty collection handling, generator throw/rejection → 500, AJV compilation failure, invalid seed counts, non-existent security schemes, and malformed Accept headers. A real interceptor bug was discovered during this work (see D32). Committed as 0133de3.

### D32: Interceptor baseUrl must check segment boundaries, not raw string prefix (2026-04-04)

During property-based test authoring, a bug was discovered: the interceptor's baseUrl option matched on raw string prefix, so setting baseUrl: '/api' would intercept requests to '/apiv2'. The fix adds a segment boundary check — after stripping the prefix, the remaining path must start with '/' or be empty. Analogous to D25 (Angular baseUrl stripping) but in the fetch interceptor inside @schmock/core. Fixed as part of commit 0133de3.

### D33: All adapter integration tests must run in CI; Angular needs a new fixture (2026-04-04)

Investigation triggered by the operator noticing only 95 integration tests revealed three structural gaps: (1) Angular has zero integration tests — no fixture under tests/integration/ and nothing in scripts/integration-tests/. (2) React and Vue fixture tests exist under scripts/integration-tests/fixtures/ but are not referenced by test:all, making them orphaned. (3) Faker, validation, and query have no standalone integration tests — only exercised inside multi-plugin combos. Decision: fix all three. Three parallel agents were dispatched: one to write an Angular integration fixture, one to wire the React/Vue fixtures into CI, one to add standalone plugin integration tests. Results pending at session end.

### D34: D33 complete: Angular integration fixture, React/Vue CI wiring, standalone plugin tests (2026-04-04)

Three parallel agents resolved D33. Angular received a new integration fixture (previously had zero integration coverage anywhere in the repo). React and Vue fixtures that existed under scripts/integration-tests/fixtures/ but were not referenced by test:all were wired into the CI pipeline. Faker, validation, and query each received standalone integration test files exercising their API surfaces independently, rather than only being covered inside multi-plugin combination tests. Integration test count: 95 → 157 (+62). All 11 packages now have integration coverage. Committed as 2312232.

### D35: 2.0.3 patch — Tier A audit fixes shipped (2026-05-17)

After v2.0.2 (dep refresh) shipped, the operator asked for next steps. Verified that AUDIT.md was stale: of the 15 IMPORTANT items listed, 5 (I1/I6/I8/I9/I12) had silently been fixed in D28 but were still marked deferred. The remaining 10 were re-evaluated and split into three tiers:

- **Tier A — patch 2.0.3** (this entry): 7 non-breaking correctness/reliability fixes shipped as one PR.
- **Tier B — minor 2.1.0**: I3 (baseUrl → full URL handling, per operator), I7 (Express errorFormatter consistency), I13 (smoke tests for angular/validation/query).
- **Tier C — new initiative**: Q1 examples/ apps, Q4 docs-as-tests.

Tier A scope shipped in this release:

1. **I11 (validation, ajv-formats)** — silent trust violation: `format: "email"` silently passed any string. Added ajv-formats dep, called `addFormats(ajv)`. Two new BDD scenarios.
2. **I2 (core, duplicate routes)** — warning + staticRoutes dedup already existed (D28), but `this.routes.push` still added duplicates. Now returns early. New BDD scenario asserts `getRoutes()` is deduped.
3. **I4 (core, requestHistory cap)** — new `GlobalConfig.maxHistorySize` option, opt-in FIFO eviction; defaults to unbounded so existing users see no change. Technically a minor-version feature in strict semver but bundled per operator sign-off.
4. **I5 (core, parser)** — `:name.json` no longer swallows `.json`; param names restricted to `[A-Za-z0-9_-]+`; pattern build is now split → escape literal segments → substitute capture groups. Two regression tests. (Extended by D37.)
5. **I10 (faker, validateSchema perf)** — full-tree checks (circular, depth, deep-nesting-with-arrays, array-size-limits) gated on `path === "$"`. Per-node checks remain on every recursion. Legacy `$ref="#"` error message preserved by gating it too. (The deep-nesting-with-arrays check is superseded by D39.)
6. **I15 (openapi, AJV per plugin)** — replaced module-level AJV singleton with `BodyValidatorContext` factory. Each `openapi()` call gets its own instance + schema cache; multi-spec processes no longer collide on `$id`. New plugin test exercises two plugins sharing `$id`.
7. **I14 (core, isStatusTuple ambiguity)** — documented `[200, 300]`-as-data ambiguity in constants.ts JSDoc and docs/api.md. No code change.

Also: backfilled the missing `v2.0.1` git tag (release history had a gap between v2.0.0 and v2.0.2). AUDIT.md updated inline to mark each resolved item.

Open AUDIT items deferred to 2.1.0: I3 (baseUrl rename/expand), I7 (Express errorFormatter), I13 (smoke tests).

### D36: 2.1.0 minor — Tier B audit fixes shipped (2026-05-17)

Tier B from the post-2.0.2 audit plan closed. Three items, all behavioural/test changes that don't break existing path-form usage but add new capability/coverage:

1. **I3 (core + angular, origin-form baseUrl)** — operator's choice from the original tier presentation was "full URL handling seems better DX". Both the fetch interceptor and the Angular HTTP interceptor now parse `baseUrl` into origin + path. Path-form (`/api`) keeps prior pathname-prefix semantics. Origin-form (`https://api.example.com[/v1]`) requires matching origin and, when a path is present, matching pathname prefix. Relative-URL requests don't match an origin-form base. Two BDD scenarios added.

2. **I7 (express, errorFormatter coverage)** — formerly the formatter only fired for `SchmockError` raised from the catch block. Generator throws, which schmock catches internally and returns as `{ code, error }` 500 responses, bypassed it. Now: catch block routes any `Error`, and before sending a response, schmock's internal 500 `{ error, code }` shape is detected and re-rendered through the formatter. Matches the Angular adapter behaviour. New BDD scenario.

3. **I13 (smoke tests for angular/validation/query)** — `scripts/smoke-tests/run-all.sh` previously skipped these three (`ALL_PACKAGES` listed 8 of 11). Minimal install-from-npm fixtures added. Validation fixture covers the new ajv-formats wiring shipped in 2.0.3 (asserts `format: "email"` actually rejects). All 11 smoke fixtures now pass against the published artifacts.

Bumped to minor (not patch) because I3 changes behaviour for users who passed an origin-form `baseUrl` (previously silently ignored, now actually intercepts). I7 is a strict expansion — formatter sees strictly more error paths than before.

All AUDIT.md IMPORTANT items (I1–I15) are now resolved. No items deferred to 3.x.

### D37: Route-key grammar follow-up to I5 (2026-09-25)

The 2026-09-25 review found that adjacent captures in one path segment collapsed into each other, which mis-routed custom methods and let a long segment backtrack polynomially. The grammar was extended rather than replaced:

1. Plain parameter names keep the D35 charset `[A-Za-z0-9_-]`.
2. Hyphens that end a name directly before another parameter are the separator between the two, so `:from-:to` reads as in Express. A hyphen inside a name (`:user-id`) still belongs to it.
3. `:"name"` quotes a name outside the plain grammar, and `\:` is a literal colon. Both follow path-to-regexp v8. `@schmock/openapi` uses them to route templates such as `{job}:cancel` and `{user.id}`.
4. Two parameters with nothing between them throw a `RouteParseError`.
5. In a multi-parameter segment every capture except the last excludes the next literal's first character, so the segment splits at the first separator (Express's lazy behaviour) instead of the old greedy split, and matching cannot backtrack polynomially.

### D38: Unsatisfiable faker schemas pass through unvalidated (2026-09-25)

Schemas that no value can satisfy — `allOf` with disjoint types, `minimum` above `maximum`, `minLength` above `maxLength` — are passed to json-schema-faker as they are. It returns a best-effort value that violates the schema. `validateSchema` checks structure and resource limits, not satisfiability. Two tests in `packages/faker/src/advanced-features.test.ts` pin this pass-through explicitly; they do not claim the output is valid. Extending the M20 fail-loud policy to these schemas (rejecting them with `SchemaValidationError`) is an open decision. If it is taken, flip both tests to `rejects.toThrow(SchemaValidationError)`.

### D39: Faker generation budgets replace the memory heuristics (2026-09-25)

The depth×count memory heuristics (`deep_nesting_memory_risk`, `memory_estimation`, and the `DEEP_NESTING_THRESHOLD`/`LARGE_ARRAY_THRESHOLD` constants) are removed in favour of the memoized `MAX_GENERATED_NODES` estimate. This supersedes the deep-nesting-with-arrays check listed under D35 item 5.

An aggregate `MAX_GENERATED_CHARS` budget (16,777,216 UTF-16 code units, 256 maximal strings) bounds one response. At plugin creation it is charged only from what a schema is certain to generate: `minLength`, nested `maxItems`, the root `minItems`, or an explicit `count`. The generated value is checked against it as well, reported as `generated_chars`.

The `chance` keyword is rejected at validation rather than stripped: Schmock registers no chance instance, so the keyword could only fail or be silently ignored. Resource limits are charged along generating edges only. Depth counting through `$defs`, `not` and `if` stays deliberate (see CODEBASE-ANALYSIS.md, Phase 5 refuted findings).

### D40: Node ingress body shapes and the query-key rule (2026-09-25)

`collectBody` (the CLI and `mock.listen()`) follows the fetch interceptor's media-type table: JSON is parsed and capped at 256 levels of nesting, `application/x-www-form-urlencoded` becomes an object, `text/*` a string, `multipart/*` a `FormData` (only `multipart/form-data` since D61), and anything else an `ArrayBuffer`. A repeated query key resolves to its last value on every adapter. That was already the CLI and interceptor rule; Express and Angular changed from first-wins. Every `exports` entry carries a `default` condition, and declaration maps are not shipped.

### D41: Validation checks every response status by default (2026-09-25)

`@schmock/validation`'s `response.body` validates every response status by default, including other plugins' request rejections and route error tuples. The scenario "Another plugin's request rejection is still response validated" and the unit test "response-validates a request rejection from another plugin" pin this. The review of findings 38 and 88 kept that default and added the opt-in `response.statuses` (`"2xx"` or a list of statuses) instead of flipping it.

Also decided in the same review: the query and header validators coerce scalar types while bodies stay strict; header schema names are matched case-insensitively, and names that differ only by case throw at plugin creation; `queryPlugin` skips responses with status 400 or above.

### D42: Resolve dot segments in every transport (2026-09-25, adopted 2026-10-23)

Status: adopted through review decision #57 (2026-10-23) and implemented.

The CLI, core `mock.listen()`, and the fetch interceptor already resolved `.`, `..`, and `%2e%2e` path segments through `new URL(...).pathname`. The Express middleware now routes the pathname of `new URL('http://schmock.invalid' + req.url)` (or of an absolute `req.url`), falling back to `req.path` when there is no parseable `req.url`. That makes Express on Node agree with Express on Bun, whose `node:http` resolves them first. The Angular adapter resolves dot segments in a relative URL the way a browser does before sending, without re-encoding the rest of the path, so the remainder keeps the request's spelling (`/café`); an absolute URL still goes through `new URL()`. "Raw everywhere" was rejected because Bun and the fetch interceptor can't route raw dot segments. Within one Express app, the mock middleware routes the resolved path while sibling Express routes still match the raw `req.path`. Raw-socket tests pin Express and the CLI against `mock.listen()`. The "never resolves `.`/`..`" comment on `canonicalizePath` still covers only strings passed directly to `handle()`.

### D43: One path-prefix rule for namespace and baseUrl (2026-09-25)

`parsePathPrefix` and `matchPathPrefix` in `@schmock/core` are the single prefix rule for the mock's `namespace`, the fetch interceptor's `baseUrl` and the Angular adapter's `baseUrl`. The prefix is canonicalized like a request path, a missing leading slash is implied, and one trailing slash is dropped, so `'/api/'` and `'/api'` are the same prefix. Under `namespace: '/api/'`, `/api//users` is now 404; it used to be served. Matching is on a segment boundary and compares the path only.

The Angular adapter still strips the prefix before routing, but no longer with `path.slice(baseUrl.length)` as D25 describes. After a canonical match it removes as many leading segments as the prefix has from the raw path, so `'/café'` also strips `/caf%C3%A9/menu`, and the remainder keeps the request's spelling. This supersedes D25's description of the strip.

### D44: Plugins settle a request in `afterResponse` (2026-10-23)

Core adds `Plugin.afterResponse?(context: PluginContext, response: Readonly<Response>): unknown` (review decision #39). The builder calls it in `.pipe()` order once a matched request's response is final: after the plugin pipeline, or with the 500 that a failing route, plugin, or response produced, and after the response delay, right before the history record and `request:end`. That means it runs on every transport. It's skipped for a route miss and for a request aborted before that point. `context` is the request's latest plugin context, so `context.state` is the generator's `pluginState`. `response` is a frozen per-hook copy. A returned promise is awaited against the request signal, so an abort while it's pending rejects `handle()` with 499. The return value is ignored, and any throw or rejection is logged under the `plugin` debug category without changing the response.

`@schmock/openapi` commits staged CRUD writes and dispatches callbacks from it, for the routes it owns:

- The write is committed when the final status is below 400, and it's dropped otherwise. An applied `Prefer` directive still discards it during `process()` and records the status it produced.
- Nothing is committed or dispatched unless openapi's own `process()` ran. A `beforeRequest` answer from another plugin, or any `onError` recovery (even one answering 2xx), settles nothing because a generator that threw after staging its write didn't finish.
- Callbacks go out when the final status is below 400 or equals the recorded `Prefer` status, after the commit, so a re-entrant dispatcher sees the row. The dispatch promise is returned, so the response waits for delivery; remaining callbacks are skipped once the request is aborted. An abort while a dispatcher is pending rejects `handle()` but keeps the committed row. Each dispatcher receives the request's `signal` as `OpenApiCallbackRequest.signal`, so it can abort its own delivery; the signal is absent when the request has none.
- A plugin piped after openapi no longer sees the write during its own `process()`. Because the commit follows response serialization, concurrent PATCHes to one row each answer with the merge taken when that request was generated, while the stored row merges every committed update.

Committing from `onExchange` was rejected because it fires only for `mock.intercept()` traffic, carries no plugin context, and runs after the client already has its response. Keeping the commit in `process()` with a docs warning was also rejected, because a plugin piped later could turn a stored write into a 500. Adapter `beforeResponse` and `errorFormatter` still run after the hook and can change the status the client sees.

### D45: Changes held for 3.0 (2026-10-23)

These were decided in the 2026-10-23 review and wait for the next major because each breaks a documented 2.x contract:

- Remove the deprecated core `ExpressAdapterOptions` and `AngularAdapterOptions` copies (`schmock.d.ts`, the `types.ts` aliases, the `index.ts` re-exports, the core README list, and the compile pins in `review-core-primitives.steps.ts`), keeping `AdapterRequestOverride` in a neutral section. Until then, both core copies accept `void` on their hook branches, as the adapter packages do, so the copies stop drifting.
- Make `request.body` hold a repeated urlencoded name as an array, so `tags=a&tags=b` arrives as `{ tags: ['a', 'b'] }`. In 2.x, `body` keeps D40's last-wins record on every transport, and transports that decode an urlencoded body pass the complete form beside it as `form` (D56). 3.0 only changes what `body` holds, because `@schmock/openapi` reads repeated names from that form.
- Parse every JSON string body in the Angular adapter's `json` responseType. Under `application/json` or a `+json` type, it will `JSON.parse` the string and fall back to the raw text when it doesn't parse, as `HttpClient` does against a real backend. In 2.x, only a JSON string literal is decoded (D52), because a route returning the string `'true'` with a JSON content type would otherwise become the boolean `true`.

### D46: Faker generation follows composition and json-schema-faker's real behaviour (2026-10-23)

A node carrying `allOf`/`anyOf`/`oneOf`/`not`/`if` gets no field-name mapping, no lorem fallback, and no boolean weighting, because json-schema-faker evaluates `faker` before composition; those strings are its random alphanumerics. When merged schemas declare the same property, only a `faker` that the enhancer inferred yields to a later declaration that adds a constraint; an explicit `faker` is kept. A sibling `oneOf`/`anyOf` beside `allOf` is generated alongside it (up to 64 branch combinations), and `if`/`then`/`else` beside `allOf` carries the `allOf` into each branch. A decimal `multipleOf` snaps to an exactly divisible value. Beside `type: [T, "null"]`, the node's own composition vetoes a null it rejects, and a `not` that accepts null vetoes the null roll.

References that json-schema-faker can't follow on its own (an `$anchor` or `$dynamicAnchor`, a resolvable `$dynamicRef`, a draft-07 plain-name `$id`, an `$id` under `definitions`, or a relative `$id` resolved against the root) are merged into the node that holds them before generation, the way json-schema-faker merges a JSON Pointer `$ref`: the target's keywords are used, with the holder's own keywords overriding them, except that both `allOf` lists are kept and identifiers and definitions stay on the target. A root JSON Pointer `$ref` beside or inside a `not` is merged the same way, so the `not` is encoded against the merged node. Only a generating `$dynamicRef` that names nothing is rejected at creation. This withdraws wave 1's rejection of anchor refs and every `$dynamicRef`.

A `not` that generation can't honour is rejected at creation with `SchemaValidationError` at `<path>.not`, on generating paths only. Generation honours `not: false`, `not: true`/`{}` on a `properties` value, `not.const`/`not.enum`, a lone `not.type` that narrows the node's type, and a lone `not.required` naming an optional property. A `not` that json-schema-faker merges away (on an `allOf` entry, an `anyOf`/`oneOf` branch, an `if`/`then`/`else`, or a target reached from one) is rejected unless the node's own type or bounds rule out every value it accepts. This applies D38's fail-loud rule to `not` only; other unsatisfiable schemas still pass through. For `@schmock/openapi`, which builds the faker schema per request, a response schema with such a `not` now answers every request with `SCHEMA_VALIDATION_ERROR` instead of a body the schema rejects. No bundled fixture has one. Seeded output changes from v2.6.0 for schemas holding a merged reference or a `not` beside a pointer `$ref`.

Creation-time checks charge for what json-schema-faker actually generates, amending D39. A string's certain length is the largest of its `minLength`, the shortest match of a `pattern` it generates from (held to `maxLength`, and dropped when `faker`/`format`/`enum`/`const`/`default` or a merged branch supplies the value), and the floor of an exact-length faker argument, including `helpers.fake` placeholders. D62 amends the pattern part: a pattern whose shortest match is longer than `maxLength` is charged for the matches json-schema-faker builds and discards. `minContains`/`maxContains` are held to `MAX_ARRAY_SIZE`, and every `contains` draw counts against `MAX_GENERATED_NODES`. A faker method must be exactly `module.method`. A `count` is checked against the array limit on a bare array root and also through a root `$ref`, a wrapper-only `allOf`, or a null union, and the `generated_nodes` and `generated_chars` estimates charge it there too. Characters aren't charged through a null union, since the root may roll null.

### D47: Validation and query follow the transport (2026-10-23)

`@schmock/validation` validates a `multipart/*` body, which core delivers as `FormData` (D40), as a record of its fields: a name sent once maps to its value, a repeated name maps to an array, and a file part maps to its `File`. That record is coerced like query and header values because form fields always arrive as strings, so D41's "bodies stay strict" now covers non-form bodies only. The route still receives the original `FormData`. `multipleOf` is checked with Ajv's `multipleOfPrecision: 6`, the same tolerance `@schmock/openapi` uses, because the quotient's rounding error grows with the value and 1e-9 refused `1234567.89` against `0.01`.

`queryPlugin` treats a sort or order value it can't use as absent: an `order` other than `asc`/`desc` uses `sorting.defaultOrder`, and an empty or disallowed `sort` uses `sorting.default`. Without a `sorting.default`, the list keeps its original order.

### D48: OpenAPI schema model rules (2026-10-23)

- Recursive schemas end at the first back-reference instead of returning 500. An optional property that closes the cycle is left out of an open object, an array of the enclosing schema defaults to `[]`, an `allOf` branch that closes it is dropped, and any other back-reference becomes `{ default: null }`. On a closed object, or anywhere the schema uses `unevaluatedProperties`, an optional recursive property is declared as that open cut and generates `null` even when the spec doesn't mark it nullable. Unrolling the cycle was rejected because it is exponential on Stripe-size graphs, and a typed cut was rejected because validation would reject real nested data.
- Collections whose paths differ only in parent-parameter names (`/fees/{id}/refunds` beside `/fees/{fee}/refunds/{id}`) stay two resources and are reported in `ParsedSpec.warnings`, because merging needs a per-route parameter mapping and the names can collide.
- A response header named `Content-Type` is ignored, as OpenAPI 3 requires, unless its schema pins a value (`const`, a scalar `enum` member, `default` or `example`).
- A 3.0 `example` and the 3.1 `examples` array feed generation only where the node accepts them (D57). Promoting the first `examples` entry to a pinned default was tried first and reverted, because the bundled Train Travel spec's malformed example uuid then broke every generated id in the e2e data-quality suites.
- Under `security: true`, an OpenAPI 3.1 `mutualTLS` requirement counts as satisfied, because the client certificate travels in the TLS handshake, which `handle()`, fetch interception and a plain-http `listen()` never see. Another scheme in the same requirement is still checked. Schemes of any other unknown type are still skipped with a parse warning and never satisfied.

### D49: OpenAPI validation reads bodies the way they arrive (2026-10-23)

`@schmock/openapi` normalizes a form body (`application/x-www-form-urlencoded`, `multipart/*`) once through the operation's schema, and validates and stores that record. A string field is coerced by its declared property type (plain decimal notation for numbers, `true`/`false`, an empty value as `null` for a nullable property, a single value as a one-element array) unless a string branch accepts that exact text. Bracket keys nest under declared object and array properties. A file part validates as a string as long as its byte size, capped at 64 MiB. Text and bytes under a media type that isn't JSON or a form aren't validated against an object schema. CRUD create and update store the normalized record without its file parts: a `Blob` or `File`, or a list of them under one name, isn't kept in the collection. A body that a plugin piped later replaced is normalized again from the new value.

The validator context uses `multipleOfPrecision: 6`, compiles `pattern` with the `u` flag and falls back to the legacy grammar (as faker does), and logs nothing for unknown vendor formats. Subschemas the dereferenced graph shares are hoisted into `$defs` before compiling, because compiling them inline is exponential (about a minute and tens of GB on Stripe); a schema that still holds a `$ref` is compiled as it is. Compile failures are cached.

### D50: OpenAPI spec loading refuses what it cannot bound (2026-10-23)

A `spec` given as an http(s) URL is read like an http `$ref` and held to the same policy: it loads only under `refs: { external: true, allowHttp: true }`, must pass `allowedHosts` and the address block, and is held to `timeoutMs`, `redirects` and `maxBytes`. Otherwise `openapi()` fails with `OPENAPI_EXTERNAL_REF_BLOCKED` before any request. Under the default policy the root used to be fetched by ref-parser's own resolver, which followed redirects unchecked, waited 60 s and set no size limit. This breaks URL roots under the default policy, which were never documented; fetch the spec and pass the object instead.

A `$ref` that names nothing fails with `OPENAPI_INVALID_REF` on both builds with `strict` on or off. Internal pointers through inherited names, and pointers of more than 64 tokens, are refused before either resolver runs: ref-parser retries a missing token by re-joining runs of later tokens, which is cubic on a crafted pointer.

### D51: CRUD answers in each operation's declared shape (2026-10-23)

- Read, update and delete wrap the stored row in the envelope their own response contract declares, as create already did; the stored row stays bare. A response counts as an envelope only when the resource's own schema declares the id at its top level and the response doesn't, but one of its properties does. A resource schema with no top-level id (the id falls back to the path parameter) is never treated as wrapped, so an item that merely nests an object with an `id` is served bare.
- When the item GET supplies the resource schema (its path is declared before the collection, or there is no list GET), the resource is what that response's envelope wraps. The rule is create's: the response declares neither the path parameter nor `id` at its top level and one property declares one of them. That shape also fits an item nesting an object with an `id` (`User { userId, team: { id } }`), so the property must be corroborated: it is the list GET's item schema (the same object or the same top-level property names), or its key is a conventional envelope name (`data`, `item`, `result`, `resource`, `record`, `entity`, `payload`), and exactly one property qualifies. An item GET whose schema is the list's item is never an envelope, and an envelope under an unconventional key with no list stays the resource, as before.
- A DELETE that declares a confirmation object the row doesn't satisfy (such as Stripe's `{ id, object, deleted: true }`) answers with a body generated from that contract, with every property it shares with the row taken from the row.
- Create and update keep only fields the item contract declares as the request's own names (`Object.hasOwn`, a prototype-less property record), so a JSON `__proto__` key is stored as data. The item contract for an update is its response schema when that declares the id at its top level; otherwise the resource schema, then the declared request-body schema.
- A collection without item routes is served as a singleton item only when its GET and its create answer the same top-level properties.
- `Prefer: code=` is honoured only for 200 to 599, since core can't serve a 1xx.
- A value spliced into a callback URL after its start is percent-encoded; an expression at offset 0 is spliced as it is, so a callback URL taken from the request keeps working. A host or port therefore has to come from that leading expression. A value `encodeURIComponent` can't encode leaves that callback unresolved instead of dropping the rest. Each dispatcher gets its own copy of the fallback payload.
- The `errorSchema` resource override describes the one error CRUD generates itself, the 404 for a missing item.

### D52: Adapter request and response fidelity (2026-10-23)

- The Angular adapter hands the mock the request Angular's backend would send: `serializeBody()` with the detected content type, the `accept`/`content-type` headers the backends add, and `undefined` for a bodyless request. That body is decoded with core's request-body rules, as the fetch interceptor decodes it: a multipart body becomes `FormData`, and with `passthrough` off a JSON body that doesn't parse or nests past the depth cap gets `Sent` and then a 400 `{ error, code }` before any hook or route runs. An unlabelled `URLSearchParams` body, which Angular sends as `application/json`, is therefore refused in strict mode, as `mock.listen()` refuses it. It drops the URL fragment, emits `HttpEventType.Sent` before a mocked response or error, and in the `json` responseType decodes a string body that is a JSON string literal under a JSON content type, so a route returning a `Date` gives Angular code the ISO string. Every other string stays as the route wrote it (D45 holds the full parse for 3.0).
- Express `beforeRequest` and Angular `transformRequest`/`beforeRequest` merge an override's headers and query onto the request instead of replacing them, so an override can no longer remove a header; send the request without it instead. In Express an override header replaces the request's header of the same name regardless of letter case, and keeps its own spelling. A rewrite to a method core doesn't support calls `next()`.
- Express's and Angular's default 500 come from core's `toError` and `buildJsonErrorResponse`; only a `SchmockError`'s code is kept.
- `createSchmockInterceptorFromSpec` and `provideSchmockInterceptorFromSpec` take an optional third argument, `peer?: OpenApiPeer` (`{ openapi }`, the caller's own static import), used instead of the runtime-computed import so the helpers work in a bundled browser app (wave-3 #41). Without it they keep the runtime import, which only Node and test runners resolve. An `@schmock/angular/openapi` subpath wasn't built.
- `baseUrl` keeps both meanings (#104): it filters only under `mock.intercept()` (React, Vue) and filters and strips in the Angular adapter. `schmock({ namespace })` is the portable way to keep a prefix out of route keys. The Angular adapter's `baseUrl` and a mock `namespace` don't compose, so a namespaced mock is used with Angular with `baseUrl` unset. A `stripPrefix` flag waits until someone moving from Angular to fetch asks for it.
- `@schmock/angular`'s rxjs peer mirrors `@angular/common` 15's, `^6.5.3 || ^7.4.0`, because the adapter uses only `Observable` and `Subscriber`; a test pins it so a dependency sweep can't raise it again.
- Angular keeps its local `isPromiseLike` (wave-3 #28, no change): core has no thenable helper meant for adapter hooks, and widening core's `isThenable` would change plugin and listener semantics.
- `SchmockProvider` releases its lease from a passive cleanup, so a Suspense boundary that hides it again keeps interception and dispatch position. (Activity: D60)

### D53: Core packaging and response serialization (2026-10-23)

- `@schmock/core` has a browser build (#114). The root export gains a `browser` condition (`dist/index.browser.js`); the builder no longer imports the Node server, and each entry passes the server its mocks listen with. In the browser build `listen()` rejects with `SERVER_UNAVAILABLE` and `close()` does nothing. Both entries export the same names, described by one `dist/index.d.ts`, and the Node ingress helpers stay exported from both because they import nothing from Node. The literal, self-caught `import("node:http")` stays for bundlers that ignore the condition. No `@schmock/core/node` subpath was added, so no other package's imports changed. An intercept-only Bun browser bundle went from 251,282 B to 47,034 B, and a test holds it under 64 KiB. A test environment that applies `browser` (Jest's jsdom) now gets the browser build. The release gate's two browser stages admit no Node built-in anymore.
- `normalizeResponse` keeps the JSON text it validated, in a module-private `WeakMap` keyed by the parsed tree (#125, option 2). Only consumers of an untouched `handle()` response reuse it: `listen()`, `intercept()` when no `beforeResponse` hook ran, and history, which stores the text and parses it on every read. The public `serializeResponseBody`, `writeSchmockResponse` and `serveNodeRequest` keep validating, because their callers may have edited the tree. A plain-object fast path was declined (it changes `INVALID_RESPONSE` text for contrived bodies), and dropping the second check was rejected (adapter hooks could emit `undefined` silently).
- `normalizeResponse` labels a body `application/json` when it serialized a non-string value (a `Date`, anything whose `toJSON` returns a string) into a JSON string and the response names no content type. Status tuples skip the route's default type and transports label only non-string bodies, so `[200, new Date(0)]` went out untyped while `() => new Date(0)` was JSON. A string the route returns itself stays untyped.
- `RouteTable.define()` checks duplicates through copy-on-write maps keyed by method plus normalized path and method plus pattern source (#127), which removes quadratic registration; the warning text is unchanged. Route lookup stays a linear scan: a literal-prefix index waits until specs over about 500 operations are a stated target, and per-method buckets alone aren't worth it.
- Every subpath export ships a stub directory of the same name, listed in `files`, whose `main`/`types` point into `dist` (`core/adapter`, `openapi/browser`, `react/testing`), so TypeScript's `moduleResolution: node` resolves them; `check:manifests` enforces it. The release gate runs attw with the default profile (node10 included) and `--ignore-rules cjs-resolves-to-esm` instead of `--profile esm-only`, which hid the gap.
- `@schmock/core/adapter` gains `toError`, `buildJsonErrorResponse` and `isCredentialName`, which the adapters, the CLI, devtools, faker and openapi now share instead of local copies, and `requestBodyKindOf`, `parseJsonBody`, `parseFormBody` and `HttpIngressError` (with the `RequestBodyKind` and `HttpIngressErrorCode` types), with which the Angular adapter decodes request bodies. These are additive (a minor release), and every package that imports them needs the core release that ships them; bump.ts resyncs the peer ranges.

### D54: DevTools relay behaviour (2026-10-23)

- The service worker relays keepalive requests (`fetch(url, { keepalive: true })` and `navigator.sendBeacon()`) like any other, but waits at most 5 s for the page's answer and then sends them to the network, because such a request exists to outlive a page that may be unloading. One sent by a page that is already gone therefore reaches the network unmocked. Refusing to relay them at all was tried first and rejected: under a live relay every keepalive fetch then went to the network unmocked.
- The relay's client registry re-reads the stored list for every add, delete and retain, so a write from a new worker version can't restore a page that stopped relaying while the update installed.
- The relay test harness (`createRelayHarness`) models what browsers do with aborts: a page's abort never reaches `FetchEvent.request.signal`, as in Chrome, Firefox and WebKit. `{ forwardAborts: true }` selects the Service Worker spec's behaviour, and only the scenario that asserts the mock's 499 opts in. The harness models the back/forward cache as Chromium's `content/browser/service_worker` source showed it on 2026-10-24. `clients.get` and `matchAll` don't find a cached page, because `GetWindowClientInfo` treats a cached frame as not existing. A cached page is evicted when the worker posts to it through a `Client` it already held (`ServiceWorkerPostMessage`), when a claim reaches it (`ServiceWorkerClaim`; the spec's `claim()` has no bfcache exception), or when a new version activates over its controller (`ServiceWorkerVersionActivation`). An evicted page is gone, as after `close()`. `FakePage.evicted` names the reason, and `show()` throws because going back to it is a fresh load. A statechange, or a message or controllerchange already on its way when the page was hidden, waits until `show()`. The harness doesn't model eviction when a version is doomed, nor does it model Chrome not counting a cached page as a controllee, so a cached page still keeps a waiting worker waiting. A `sendBeacon()` from `pagehide` that the worker looks up after the page is stored goes to the network at once, and the 5 s bound applies only when the lookup came first.
- `npx @schmock/devtools init` refuses to write through a symbolic link, and the console groups redact the header values `SENSITIVE_HEADER_NAMES` names.

### D55: The local release gate audits the lockfile (2026-10-23)

GitHub has never produced a run of `ci.yml` or `registry-verification.yml`, so the release can't depend on them. `bun run publish` and the guarded script's execute mode run ESLint, knip, the e2e suite and `bun audit --audit-level=high` alongside lint, build, `test:all` and `check:publish`, and print the local registry checks (`SCHMOCK_VERSION=x bun run test:smoke` and `test:consumer`) to run after publishing. `test:release-scripts` also runs `scripts/repo-tooling.test.mjs`. A high or critical advisory stops the release until the lockfile is refreshed or an approved `--ignore` clears it. `bun update` moves only direct dependencies and rewrites their ranges, so a refresh that has to reach transitive dependencies regenerates `bun.lock` with `bun install` instead; the 2026-10-23 refresh did that and left every `package.json` range unchanged. This revises e85c4d3, which removed Dependabot in favour of manual updates at release time; that step lapsed for v2.6.0. A security-only `.github/dependabot.yml` (`open-pull-requests-limit: 0`) restores security-update PRs without version-update noise, and needs the repository's "Dependabot security updates" setting. A single-package publish refuses unless npm already serves every `@schmock/*` dependency and peer of the package at the same version.

### D56: An urlencoded body carries its complete form, and OpenAPI reads it through `encoding` (2026-10-24)

Core adds `RequestOptions.form`, `RequestContext.form`, and `PluginContext.form`, typed as `ReadonlyURLSearchParams` (`URLSearchParams` without `append`, `delete`, `set`, and `sort`, exported from `@schmock/core`). It holds every field of an `application/x-www-form-urlencoded` body in the order sent, while `body` remains D40's last-wins record. `mock.listen()`, `serveNodeRequest` (the CLI), `mock.intercept()`, the DevTools relay, and the Angular adapter set it only for urlencoded bodies; otherwise, the key is absent. The fetch interceptor and the Angular adapter drop it when a `beforeRequest` or `transformRequest` hook returns a different body. `handle()` passes it along unchanged and doesn't check it against `body`, and `collectBody()` still resolves to the record alone. Express doesn't set it, because `express.urlencoded()` already builds arrays. A `URLSearchParams` was chosen over an entry list because every transport already builds one, it preserves order and every value, and routes need `getAll()`. A symbol on the body record was ruled out.

`@schmock/openapi` reads each request media type's `encoding` map for `style` and `explode`. An unset `style` is `form`, and any style no query parameter takes is read as `form`. An unset `explode` is true for `form` and false otherwise. Before D49's coercion, an urlencoded body is read from `form`, but only while the form describes the body: the content type is urlencoded and the body is a plain record holding exactly the last value of every name in the form. Then:

- A property declared as an array gets every value of a repeated name.
- With `explode: false`, `form` splits a value on `,`, `spaceDelimited` splits on a space, and `pipeDelimited` splits on `|`. A non-exploded name sent more than once contributes every value it carries. A delimited style with `explode: true` reads repeated names.
- Bracket keys nest as D49 describes (`deepObject`), and a bracketed name repeated onto an array leaf (`filter[sizes]`, `tags[]`) gets every value.
- Every other name keeps its last value.

When a record is read without a form that describes it (from Express, from a `handle()` caller, or after a plugin replaced the body), a string value is split on its delimiter only for an array property whose encoding entry doesn't explode. With no encoding entry, nothing changes, and a value that is already an array, such as Express's `['a,b', 'c']` for a non-exploded name sent twice, isn't split. Validation, the store-without-validation step, and CRUD create and update all read the body this way. It doesn't read `encoding` under `multipart/*`, an object-valued property in `form` style (`color=R,100,G,200`, or exploded properties sent as top-level names), or the Encoding Object's other fields.

### D57: OpenAPI example values feed generation only where their schema accepts them (2026-10-24)

This replaces D48's rule that only a 3.0 `example` becomes a generation default.

- A scalar node that declares no `default` and no 3.0 `example` uses its 3.1 `examples` as a pool: the distinct non-null primitive entries the node accepts, checked with the validator's AJV setup after 3.0 boolean exclusive bounds become numbers. One accepted entry becomes `default`. Several accepted entries become `faker: { "helpers.arrayElement": [entries] }`, drawn by the generator's seeded faker so `fakerSeed` replays the draws. If none are accepted, the node stays as it was. A nullable node keeps its null roll, and a spec-declared `faker` keyword is kept.
- No pool is drawn on a node with two non-null types or a fractional `multipleOf`, because json-schema-faker casts the drawn value to a randomly picked type and snaps it to the step. A single accepted entry still pins.
- A 3.0 `example` that the node rejects is no longer promoted. A `null` example is accepted on a nullable node. A node whose value keywords can't compile (an unparseable `pattern`) vetoes nothing.
- A declared 3.0 `example` turns off the pool whether or not the node accepts it. This is the literal reading of "no `default` and no 3.0 `example`"; treating a rejected example as absent, so generation falls through to the pool, is a one-line change in `applyExampleValues`.
- Acceptance is checked against the whole normalized node, including its composition branches. A composed scalar (`allOf`, `anyOf`, `oneOf`, `not`, `if`) gets `default` from an accepted 3.0 example or from its one accepted 3.1 entry, and never draws from a pool. json-schema-faker honours that `default` only beside `not`; under the other keywords it generates from the branches, so that node never serves a rejected example, but it doesn't pin the accepted one either.
- In every body generated from the schema for a detected CRUD resource, the resource id takes no value from `example` or `examples`: `Prefer: dynamic=true`, `Prefer: code=` with a 2xx status, a list route's declared object body, and a lookup-only read with no stored rows. The id is found where the operation carries the resource: at the item's top level, in an envelope slot, or in each list entry. Derived values are recorded in a side table and never in the schema, so validation compiles what it compiled before, and a spec `default`, a spec `faker`, and any value a hook writes over the derived one are kept. The create base and the delete confirmation aren't filtered, because the minted or stored id overwrites theirs. Before this, the Scalar Galaxy list answered ids `[1, 1, 1]` under `Prefer: dynamic=true`.
- A response header draws from the pool in the slot a single example's `default` takes, after `const` and `enum`. The seeded draw hashes the seed, the request ordinal, and the header name (FNV-1a) instead of calling `@schmock/faker`, because header values are generated synchronously and reserved before the body.
- Values are generation-only: `default` and `faker` are annotations to both validators, and no `enum` or `const` is written. Stored ids still come from `crud-ids.ts`. `ajv-setup.ts` is the one AJV setup for validation and example acceptance, and the acceptance cache holds at most 1024 checks before it and its AJV instance are rebuilt, since AJV's own strong cache rules out a `WeakMap` bound.

### D58: Faker reconciles numeric bounds that meet through `allOf` (2026-10-24)

json-schema-faker merges `allOf` bounds keyword by keyword: it keeps the largest `minimum` and the largest `exclusiveMinimum`, using the exclusive one even when it's looser; it keeps only the last `multipleOf`, and it reads each entry's lone-bound partner as a real bound. Generation now reconciles numeric bounds across a node and everything json-schema-faker merges into it through `allOf`: the entries (inline or behind a `$ref` at any depth) and the declarations of a property that several of those schemas declare, level by level. On each side the tightest bound by value applies, and an exclusive bound wins a tie. Several `multipleOf` combine into their least common multiple. When that can't be computed exactly (a step finer than 15 decimal places, or a multiple past 2^53 once scaled), the last step is kept as before. The result is written onto the node's copy, and the merged entries are inlined without their numeric keywords so shared definitions keep their own bounds. A merged range with no valid value is written as one node's range and generates exactly as that node does; there's no new error.

A keyword beside a `$ref` (on an `allOf` entry, a property declaration, or a chain hop) replaces its target's keyword instead of being narrowed against it. That follows how D46 reads a holder over its target: `{ $ref: S, minimum: 0 }` already generates from 0 outside any `allOf`, and the same shape shouldn't behave two ways. Several cases are left as json-schema-faker merges them: a node whose own `$ref` sits beside `allOf`, bounds that meet through `oneOf`, `anyOf`, or `if`/`then`/`else`, merges of more than 256 schemas, a `$ref` it can't follow, and `$ref` loops. The finite partner for a lone bound past [-1000, 1000] is written after this pass. Seeded output changes from v2.6.0 only for schemas where two or more merged schemas carry numeric bounds; no bundled fixture's output changed.

### D59: Only the CI workflow stays on GitHub (2026-11-06)

`.github/workflows/registry-verification.yml` is removed, along with the `resolve-version` command in `scripts/smoke-tests/registry-fixture.mjs` that read its release and dispatch inputs. GitHub never ran it (D55), and registry verification doesn't need it. After a release, `SCHMOCK_VERSION=X.Y.Z bun run test:smoke` and `bun run test:consumer` install the published packages and check them locally. `ci.yml` stays as the testing workflow, and nothing in the release depends on it because the local gate already runs the same checks.

### D60: A lease can be taken back at an earlier lease's dispatch position (2026-11-07)

Hiding an `<Activity>` above `SchmockProvider` runs its passive cleanups, so the provider releases its lease (D52). Showing it again took a new lease at the front, ahead of leases taken after the provider first mounted (#1).

- `mock.intercept(options, at)` takes a lease at the rank of `at`. Ranks come from a module-wide counter that is never reset. An interception keeps its leases sorted by rank, and dispatch still starts from the highest. The new lease is consulted after every lease registered later than `at`'s and before every live lease registered earlier, also after the stack emptied and fetch was restored. Of two leases with the same rank, the later is consulted first. The rank isn't tied to a mock.
- A value that no `intercept()` or `createFetchInterceptor()` returned, `null` included, throws a TypeError before anything is patched. Ranks order leases within one interception only, so a lease taken over a third-party fetch wrapper nests as before. `createFetchInterceptor` keeps its signature and its handles are valid anchors. There is no new type and no new handle member.
- The provider keeps the lease it last committed and passes it as `at` for every lease it takes again for the same mock: the commit effect's fresh lease and the render-time lease. Hiding still releases, so a hidden provider holds no lease between renders and an unmount while hidden leaves nothing behind. Each hidden render still takes a one-task render lease, and for that task the provider answers every route no newer lease claims: a render can't tell a hidden re-render from a reveal, the reveal's render-time fetches need the lease, and Activity's pre-render may fetch data. That lease goes to the provider's position, not the front: the lease it last committed, or, before its first commit (mounted hidden, a suspended first mount), its first render lease, so leases taken after it mounted stay ahead of it. React renders hidden content after the visible content of the same update, so a pane mounted hidden sits ahead of the visible panes mounted with it and still answers a route they share for one task after each of its re-renders. A new `mock` prop takes the front. The kept restored handle holds its torn-down interception object until the provider goes away.
- Rejected: keeping the lease while hidden and releasing it from a `useInsertionEffect` cleanup. React 19.2.0 and later run insertion cleanups when a hidden tree is deleted and never on a hide or on StrictMode's simulated unmount; 19.0 and 19.1 skip them under a hidden boundary (`commitDeletionEffectsOnFiber`, checked in the react-dom bundles). That is undocumented and changed in 19.2, and a regression would leak a lease with fetch patched until reload. Checking `"Activity" in React` gates on the version, not the behaviour. Hidden Activity panes would also keep answering for visible ones on shared routes.
- Rejected: `pause()`/`resume()`, which needs two methods, a paused state, and an epoch guard against stale render-lease timers. An opaque `InterceptPosition` on `handle.position`, which carries the same rank plus a new type and a required handle member. Deferring the release by a task, since a real hide outlasts it. A public numeric rank, which could be forged.
- `@schmock/vue` is unaffected: its lease is per app, taken at plugin install and released on `app.unmount`.

### D61: Only multipart/form-data decodes as a form (2026-11-26)

Core decodes a body into `FormData` only when its media type is `multipart/form-data` (any letter case, any parameters), because the platform's `formData()` accepts nothing else. Under D40's table a `multipart/mixed` or `multipart/related` body (an OData `$batch`, a Google Drive metadata-and-file upload) never reached the route: `mock.listen()` and the CLI's `serveNodeRequest` answered 400 `MALFORMED_MULTIPART`, and `mock.intercept()` rejected the caller's fetch with a `TypeError`. Every other multipart subtype now arrives as an `ArrayBuffer` of the exact bytes sent, like any media type core doesn't parse, and `Content-Type`, boundary included, stays in the headers so the route can split the parts itself. This holds on `mock.listen()`, `serveNodeRequest`, `mock.intercept()` (React, Vue and the DevTools relay), and the Angular adapter, which all classify through `requestBodyKindOf`. In Angular a `FormData` instance body is still handed over as that same `FormData`, whatever `Content-Type` the caller set. The fetch interceptor never sees the instance: it reads the request's bytes and decodes them by the request's `Content-Type`, so a `FormData` sent with the platform's `multipart/form-data; boundary=...` label arrives as a re-parsed `FormData`, and one sent under an explicit `multipart/mixed` label arrives as an `ArrayBuffer`. Express is unchanged, since it hands over whatever the app's body parser produced. `@schmock/openapi` reads only `multipart/form-data` as a form, so a mixed or related body against an object schema skips body schema validation as XML and CSV bodies do; the media type is still checked and can still answer 415, and `multipart/form-data` is still validated as a record. `@schmock/validation` keys on a `FormData` body, so it judges other multipart subtypes as the bytes received, like `application/octet-stream`. A multipart parser was ruled out: parts of `mixed` and `related` carry no field names, so `FormData` can't hold them; a parser would have to be maintained; and a new body kind would have to run through every transport. This narrows D40, D47, D49 (form bodies are `application/x-www-form-urlencoded` and `multipart/form-data`) and D52's Angular bullet (a `multipart/form-data` body or a `FormData` instance becomes `FormData`). `requestBodyKindOf` is exported from `@schmock/core/adapter`, but its multipart classification had not shipped in a release.

### D62: A pattern is charged for the draws json-schema-faker builds and discards (2026-11-26)

This amends D46's sentence "the shortest match of a `pattern` it generates from (held to `maxLength`, ...)". json-schema-faker 0.6.3 builds the whole match before it checks the length. It draws up to 50 matches and throws away each one shorter than `minLength` or longer than `maxLength`, then draws a 51st and slices or pads it. 0.6.4 has the same loop; the merge order and regex parser below were read in 0.6.3 only. So `generated_chars` charges what a pattern makes it build, kept or not: 51 times the uncut shortest match when every path json-schema-faker can take throws every draw away, and the shortest match once otherwise.

The charge reads the paths in the order json-schema-faker's composition step merges them, after Schmock restates the keywords beside an `allOf` (`carryCompositionThroughAllOf`):
- Nothing is merged unless an `allOf`, `anyOf`, `oneOf`, `not` or `if` is truthy, so a `then` under `if: false` caps nothing.
- Without an `allOf`, only the first of `oneOf`, `anyOf` and `if` is merged: one `oneOf` or `anyOf` branch, or the `if` with its `then`, or with no `then` the `else`.
- Beside an `allOf`, a path merges the schema, then the `if` and every entry, then the `then`, and last one `oneOf` branch, or one `anyOf` branch when there is no `oneOf`. It never merges the `else`. An `if` with only an `else` is merged too, since Schmock gives it a `then` that holds the entries. A boolean `allOf` entry is skipped. So is a boolean `then`, which the restatement puts among the entries. A boolean `oneOf` branch merges nothing.
- Each path keeps the last `pattern` it merges, the smallest `maxLength` and the largest `minLength`. A NaN bound stays NaN in json-schema-faker's merge and discards nothing. A path that merges a `faker`, `format`, `enum`, `const` or `default` counts no pattern.
- A path throws every draw away in three cases: its `maxLength` is below the pattern's shortest match, its `minLength` is above the longest string json-schema-faker can build from the pattern, or its `minLength` is above its `maxLength`.
- A `false` `anyOf` entry, or a `false` `then` or `else` with no `allOf` beside it, makes json-schema-faker generate a value without the pattern on that path. That path is left out of the count, as before. But then not every generation draws 51 times, so each other path counts one shortest match.
- Some schemas keep the old charge, the match cut to the smallest `maxLength`: a merged branch the charge cannot read path by path (one with its own `allOf`, `anyOf`, `oneOf`, `$ref` or `$dynamicRef`, the merged `if` included), a branch typed other than string beside an untyped pattern, and an untyped pattern whose own `not` names a type.

A few boolean branches follow from the engine rather than from the merge order. An `allOf` cap beside `if: false` counts one match, since json-schema-faker drops it with the `allOf`, and so does a schema's own cap beside an `anyOf` whose only entry is `false`, where no path builds the pattern. A `then: false` beside an `allOf` is skipped, because the engine never sees it, so the 51-draw charge still applies: 279 strings of `^a{60000}$` held to `maxLength: 10` that way are rejected with actual 853,740,000. The `if` of an `if` with only an `else` beside an `allOf` is checked for branches the charge cannot read, as one with a `then` is, so an `if` holding `allOf: [{pattern: '^b{3}$'}]` beside an own `^a{60000}$` takes the cut-length fallback and generates `bbb`.

The longest string json-schema-faker can build is `regexLengthBounds`' `longest` only for a pattern its regex parser reads as a RegExp does (`generatedLengthCeiling`). Its parser misreads some syntax:
- It emits the letter of a `\u`, `\x`, `\c`, `\p`, `\P` or `\k` escape and reads what follows as literals or a quantifier: `\x41` builds 3 characters and `\u{41}` builds 41.
- It emits a backreference's digits, so `\12` builds two.
- It reads a lookbehind as a named group up to the next `>`.
- It skips a lookahead by counting parentheses, escaped and classed ones included.
- It closes a class early at a range that ends in an escape.

A pattern that uses any of these has no certain ceiling, and its `minLength` side is not charged. The ceiling is a whitelist of the syntax both parsers read alike, not a list of the misreads. A misread missing from such a list would refuse schemas that generate on the first draw. `^\x41[a-z]{6000}$` at `minLength: 6003` builds 6,003 characters on the first draw, and 60 of them stay accepted.

Measured:
- 300 strings of `^[a-z]{60000}$` held to `maxLength: 10` took 10.0 s and are rejected with actual 918,000,000. The hunt's 100 items of `^a{65536}$` held to `maxLength: 1` took 1.5 s and are rejected with actual 334,233,600.
- 279 such strings with `if: {minLength: 1}, then: {maxLength: 10}` took 8.5 s. They are now rejected with actual 853,740,000. So is the same count with the cap on an `else` and no `then`, and with the schema's own cap beside an `allOf`, an `if` and `then: false`.
- 300 strings with `^a{70000}$` on an `if` under `maxLength: 10` took 4.8 s and are now rejected with actual 1,071,000,000. 200 with `^a{60000}$` on an `allOf` entry under `maxLength: 10` took 2.7 s and are now rejected with actual 612,000,000.
- `anyOf: [{maxLength: 10}, {maxLength: 20}]` beside `^a{100000}$` took 24.1 ms a string, the same as the schema's own cap. 300 strings of `^a{60000}$` with it are now rejected with actual 918,000,000, and 5 still pass.
- 270 strings of `^a{60000}$` with `minLength: 60001` took 4.1 s and are now rejected with actual 826,200,000.
- Realistic schemas keep their charge:
  - A 64-hex-digit hash held to `maxLength: 32` is charged 3,264, and 1,000 generate in 60 ms.
  - Three `[a-z]{20}` held to 10 are charged 1,020 each.
  - A UUID pattern held to 8 is charged 1,836, and 1,000 generate in 74 ms.
  - `^(\d{3}-)?\d{3}-\d{4}$` held to 10 and `^([a-z0-9]{32}|[a-z0-9]{64})$` held to 40 only straddle their cap, so each is charged its shortest match once. 10,000 of each generate in 27 ms and 36 ms.
- A contradictory `^[0-9]{4}$` with `minLength: 6` now counts 204 a string, and 10,000 still generate in 121 to 128 ms across runs.
- The bundled OpenAPI fixtures hold 101 patterns. None has a `minLength` past its ceiling or above its `maxLength`, a shortest match above its `maxLength`, a conditional beside it, or a pattern or length cap on a composition branch, so none is charged differently. One password pattern made of lookaheads has no certain ceiling.

The satisfiable case the `minLength` side reaches is an open quantifier whose `minLength` lies more than five repetitions past its lower bound, since json-schema-faker never repeats further. Every draw is then too short, so it discards them all and pads the 51st with characters outside the pattern: the value it returns does not match its own pattern. The charge is the lower bound 51 times, which is less than the characters actually built. These shapes are common, and each was measured with and without its `minLength`. For three of them, 10,000 rows are rejected and 5,000 pass:

| Pattern | `minLength` | Fields | Counted a string | 10,000 rows | 5,000 rows | 10,000 rows, no `minLength` |
|---|---|---|---|---|---|---|
| `^[0-9a-f]{32,}$` | 40 | 2 | 1,632 | rejected, 32,640,000 | 369 ms | 36 ms |
| `^[a-zA-Z0-9]{8,}$` | 20 | 5 | 408 | rejected, 20,400,000 | 619 ms | 77 ms |
| `^[A-Za-z0-9_-]{16,}$` | 32 | 3 | 816 | rejected, 24,480,000 | 494 ms | 47 ms |

A fourth shape, `^[A-Z]{2}[0-9A-Z]{13,}$` with `minLength: 21`, counted 21 a string and now counts 765. 10,000 rows of one field generate in 326 ms and two in 650 ms. Three fields (30,000 strings) took 918 ms against 51 ms without the `minLength`, and are now rejected with actual 22,950,000. This is the same threshold D62 already draws for the hash: the budget counts what is built.

`string_length` measures what the pattern returns: the longest string on any path, the same way it already rejects an `anyOf` `minLength` that only one branch carries. That is the shortest match cut to the loosest `maxLength` a path applies, following json-schema-faker's merge order:
- `allOf` entries are always merged.
- Without an `allOf`, only the first of `oneOf`, `anyOf` and `if` is merged.
- An `if` with a `then` merges the `then`, and the `else` only when there is no `then`.
- A NaN `maxLength` caps nothing.
- A `false` `anyOf` entry is left out because it generates without the pattern. A `false` `oneOf` entry still returns the full match.

Beside an `allOf`, `string_length` reads every cap as applying, which can only let a schema through. `generated_chars` reads only the caps the paths above merge, since there a cap credited but never applied would refuse a schema. So `^a{70000}$` beside `maxLength: NaN`, or beside `anyOf: [{maxLength: 10}, {minLength: 1}]`, is rejected at creation. Before, it was accepted and then failed the output check. Beside `anyOf: [{maxLength: 10}, {maxLength: 20}]` it stays accepted, and a lone `^a{70000}$` with `maxLength: 10` generates in 24 ms and stays accepted.

Straddling patterns such as `^a{1,60000}$`, `^[a-z]+$` and `^[a-z]{5,200}$` with `maxLength: 10` never discard a draw, because json-schema-faker repeats a quantifier at most five times past its lower bound. Real straddles come from optional or alternated long groups. A draw is kept by chance, so there is no sound bounded rule, and they charge the shortest match once. The same holds for draws that only sometimes fall short of `minLength`. Even odds stay cheap: `^(?:a{60000})?$` and `^(?:b|a{60000})$` at 300 strings took 96 ms and 120 ms. One short arm against nine 60,000-character arms took 656 ms at 300 strings. The cost approaches the 51-draw case as the short arm's odds fall.

Other residuals:
- A `type` list that adds another type is charged nothing, because json-schema-faker may pick the other type, yet it builds all 51 draws each time it picks string. 300 strings of `^[a-z]{60000}$` at `maxLength: 10` took 3.8 s with `['string','integer']` and 10.0 s with `['string','null']`.
- An unregistered format.
- Schemas on the cut-length fallback, whose full-match paths are caught only by the output check, and whose discarded draws are not charged.
  - One example is `anyOf: [{maxLength: 10}, {allOf: [{minLength: 1}]}]`.
  - Another is a composed `if` beside an `allOf`, with a `then` or only an `else`. With `if: {allOf: [{minLength: 2}]}` and an `else`, `^a{60000}$` held to `maxLength: 10` still builds 51 draws, about 15 ms a string, yet 6 of them pass. Before this round's review they were rejected at 18,360,000. The trade buys the `bbb` case above, which builds 3 characters.
- A pattern on a merged branch drops `string_length`'s floor for the schema's own pattern. Since this round that includes an `if` beside an `allOf` with only an `else`. So `^a{70000}$` beside an `allOf`, an `if` holding `^b{70000}$` and an `else` passes creation and fails the output check with `string_length` 70,000. Before, it was rejected at creation. The same `if` holding `^b{3}$` was rejected then, although it generates `bbb`.
- An `else` cap beside an `allOf`, with no `then`. `string_length` credits the cap, but json-schema-faker doesn't apply it there. So `^a{70000}$` with `allOf: [{minLength: 1}]`, an `if` and `else: {maxLength: 10}` passes creation, and every generation then fails the output check. `generated_chars` does not credit it.
- A capped path beside a `false` `anyOf` entry, or a `false` `then` or `else` with no `allOf`, counts one match, because the `false` path builds nothing. 279 strings of `^[a-z]{60000}$` with `anyOf: [false, {maxLength: 10}]` pass creation and take 4.6 s, since about half of them draw 51 times.
- json-schema-faker's own output for the `\u`, `\x`, `\c`, `\p` and `\k` escapes does not match the pattern: `^\x41$` generates `x41`. The charge follows what it builds and leaves that alone.
- `regex-bounds.ts` reads lookarounds as zero-width, but json-schema-faker does not:
  - It reads `(?<=` and `(?<!` as a named group up to the next `>`, which can swallow the rest of the pattern.
  - It skips a lookahead by counting raw parentheses. In `(?=.*\))` it stops at the escaped `)`, and its top-level parser then breaks on the real one and drops the rest of the pattern.

  Either way the shortest match can exceed what is built, and the 51x charge multiplies the error. `^(?<!x)a{60000}$` with `maxLength: 10` builds an empty string in 2 ms, yet 6 of them are rejected with actual 18,360,000. `^(?=.*\))a{60000}$` with `maxLength: 10` returns an empty string, 5 pass in 2.9 ms, and 6 are rejected with actual 18,360,000. The `minLength` side does not multiply the error, because a lookaround has no certain ceiling: 300 of `^(?<!x)a{6000}$` with `minLength: 6001` pass and generate in 109 ms.
- An `allOf` entry's pattern over 65,536 is held to `string_length` at the entry, before the schema's `maxLength` cuts it. `{maxLength: 10, allOf: [{pattern: '^a{70000}$'}]}` is rejected, although json-schema-faker returns 10 characters in about 20 ms. The same pattern on an `if` is cut by the merged `maxLength` and passes.

### D63: Two dev-only advisories are accepted until a fixed release clears the cooldown (2026-11-26)

`bun audit` reports two moderate advisories that no update old enough for the 14-day cooldown fixes: minimatch GHSA-g3hv-75wg-m249, reached through eslint, typescript-eslint's typescript-estree, vitest-cucumber's ts-morph and @vue/test-utils' js-beautify, and glob GHSA-3g3m-2fjr-6pw4, reached only through js-beautify's command-line entry. Both are dev-only: neither is in any published package's runtime dependencies, and no repo code imports them. They are accepted rather than forced with overrides, because `minimatch ^11.0.7` and `glob ^14.0.2` would push semver-majors onto five tools, and minimatch 11 changes the partial `**` matching eslint relies on. The regeneration after 2026-11-30 clears the eslint, typescript-estree and ts-morph paths by itself; the js-beautify paths stay open until it ships a fix. Re-check on 2026-12-01.

### D64: Biome 2.6 leaves the YAML fixtures alone and allows components inside tests (2026-11-26)

Biome moves from 2.5.15 to 2.6.7. 2.6 formats YAML, which would rewrite the vendored OpenAPI specs under `packages/openapi/src/__fixtures__`, so `biome.json` turns the YAML formatter off and excludes `**/__fixtures__/**/*.yaml` and `*.yml`. Its new `noComponentHookFactories` rule flags the components that the React tests define inside their bodies on purpose (18 across four files on the React branch). An override turns the rule off for `*.test.tsx` and `*.steps.tsx` and keeps it on for shipped code. Hoisting those components to module scope was the alternative. 2.6.8 and 2.6.9 were still inside the 14-day cooldown.
