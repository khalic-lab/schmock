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

After initial implementation, the React and Vue feature files were found to lack error status codes, POST with JSON body, and useSchmock-outside-provider error scenarios. These were added before the PR. Established floor: each framework adapter feature file must cover (1) basic GET mock, (2) passthrough on unmatched routes, (3) error status codes flowing through (4xx/5xx), (4) POST with JSON body, (5) context/provider error (hook or composable used without setup). Final counts: React 8 scenarios/25 steps, Vue 7 scenarios/22 steps.

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
