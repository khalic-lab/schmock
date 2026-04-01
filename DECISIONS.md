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
