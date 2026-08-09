# Schmock Codebase Analysis

- Date: 2026-08-09
- Revision: `3f64677` (`chore(release): v2.3.0`)
- Runtime used: Bun 1.3.13, Node.js 26.3.1
- Verification: independently re-verified claim-by-claim on 2026-08-09 at the same revision; 89 of 91 discrete claims confirmed, 2 corrected, none refuted (see "Independent Verification")
- Remediation: the post-review worktree implements and locally verifies all three release blockers and Phase 2 findings M1-M9; public-documentation reconciliation is partially complete (see "Remediation Progress")
- Second pass: an independent adversarial review of the remediation diff confirmed nine defects in it (one blocker, eight major), all fixed in-tree and re-verified; a follow-up review of those repairs confirmed three more (all in the error-formatting paths), also fixed (see "Second-Pass Review And Repairs")

## Executive Summary

Schmock is a well-structured TypeScript monorepo with a clear product idea, unusually broad behavioral coverage, and several good architectural decisions. The callable core, response-preserving plugin pipeline, OpenAPI automation, and thin framework facades form a coherent system. In this warm macOS checkout, every configured local gate passed and Vitest reported 3,089 passing test cases. Canonical GitHub CI for this exact revision is red: the fresh `check-publish` job exposed B1, and the unit job exhausted its 4 GB heap during the OpenAPI suite.

The reviewed revision is nevertheless not release-safe. Three release blockers were reproduced:

1. Clean and incremental builds can publish different JavaScript. A clean TypeScript emit can overwrite Bun bundles and leave Node-incompatible JSON imports.
2. Seven packages publish declarations that fail standalone TypeScript compilation because they reference an unloaded global `Schmock` namespace.
3. The built `@schmock/react/testing` entry contains a second React context, so `renderWithSchmock()` cannot provide context to `useSchmock()` imported from the main entry.

The post-review worktree now contains locally verified repairs for all three blockers and the M1-M9 core lifecycle/transport phase, plus a partial public-documentation reconciliation. The baseline findings remain below for traceability; no replacement remote CI run has yet validated the repairs.

Important runtime defects remain around OpenAPI transactionality and ownership, CRUD resource identity, complete Angular HTTP semantics, CLI exposure, and schema generation safety. Most are not algorithmic complexity problems. They are boundary problems: source versus artifact, route ownership versus global plugins, declared contracts versus generated behavior, and configuration state versus request state.

Overall assessment:

| Area | Assessment |
|---|---|
| Product architecture | Strong and coherent |
| Source readability | Generally good |
| Type hygiene inside the monorepo | Strong |
| Runtime boundary correctness | Mixed |
| OpenAPI fidelity | Broad but has material semantic gaps |
| Test volume | Excellent |
| Test boundary coverage | Package artifact and core lifecycle/transport boundaries repaired; later-phase gaps remain |
| Packaging and declaration integrity | Release-blocking at the reviewed SHA; remediation is green locally |
| Public documentation | Phase 1/2 contracts reconciled; seven baseline drift rows and the schema-generator promise remain open |
| Security defaults | Safe locally, unsafe when explicitly exposed |
| Immediate recommendation | Run fresh CI on the remediation, then proceed to Phase 3 |

## Independent Verification

A second, independent review (Claude, 2026-08-09, same revision) verified every discrete finding in this report against the source, the existing `dist` artifacts, the raw CI job logs, and fresh runtime probes for each claim marked as reproduced. Of 91 discrete claims, 89 are confirmed as stated, 2 are partially correct, and none are refuted.

- Confirmed as stated: B1, B2, B3, M1 through M8, M10 through M29, 28 of 29 minor findings, all 10 dead-code items, all packaging claims, the false-positive test pattern, and all 14 documentation-drift rows.
- Key reproductions matched exactly: the standalone declaration probe produced exactly 27 `TS2503` diagnostics (33 including the React testing subpath); the built React testing helper threw the exact `useSchmock must be used within a SchmockProvider` error; the CI logs for run 29211598580 show `ERR_IMPORT_ATTRIBUTE_MISSING` for `@schmock/openapi/package.json` in `check-publish` and a V8 heap exhaustion inside the `@schmock/openapi` unit suite, as reported.
- Partially correct, corrected inline: M9 (the hardcoded 500 is unreachable for oversized bodies, and the CLI does write a clean 413 when `Content-Length` is declared) and the `http-helpers.ts` MIME minor row (the check is over-permissive, not parameter-sensitive).
- Confirmed with scope refinements, noted inline: B1, B2, M6, M12, M25, M26, M28, M29.
- Not independently re-run: the local full-suite counts (3,089 passing cases); the CI evidence was verified from the raw logs instead. The Residual Operational Risks and implicit-state-machine tables were treated as interpretation, not factual claims.

Inline additions below are marked **Verification note** or **Verification correction**; everything else is the original report text.

## Remediation Progress

Phases 1 and 2 were implemented in the post-review worktree on 2026-08-09. A partial Phase 5 public-documentation reconciliation followed. The findings below still describe revision `3f64677`; this section records the delta and its local evidence.

| Blocker | Local status | Repair and regression coverage |
|---|---|---|
| B1 | Implemented and verified | Every package build removes its own `dist` and build info. Shared type emission is declaration-only. Core uses one dedicated unbundled TypeScript runtime build to preserve browser tree-shaking; the other ten packages use Bun for runtime JavaScript. `check-build-reproducibility` seeds stale artifacts, builds twice, and compares all 119 paths, hashes, and modes. |
| B2 | Implemented and verified | Downstream declarations bind `Schmock.*` through explicit type-only imports from Core. Missing Core type exports were added, and Node helper/ambient CLI types use browser-safe structural protocols; the exact CLI `Server` type remains exported by `@schmock/cli`. Twelve public entries compile independently with `skipLibCheck: false`; non-Node entries use `types: []`, and all nine non-Node declaration trees are scanned for Node-only references. |
| B3 | Implemented and verified | The React testing bundle preserves its `./index.js` import instead of inlining a second context. The packed consumer renders a main-entry `useSchmock()` consumer through `@schmock/react/testing` under both Node and Bun and verifies object identity. |

Phase 2 establishes one request-admission, lifecycle, response, and transport contract:

| Finding | Local status | Repair and regression coverage |
|---|---|---|
| M1 | Implemented and verified | Global configuration is owned by the mock, and every instance has one persistent default state object. |
| M2 | Implemented and verified | Server starts are synchronously reserved and cancellable; close stops acceptance before force-closing connections, and immediate restart waits on the close barrier. |
| M3 | Implemented and verified | Plugin-installed routes are staged atomically behind a synchronous scoped facade, Promise-returning installs are rejected, request plugin generations are snapshotted, and reverse-order uninstall waits for all admitted requests. |
| M4 | Implemented and verified | Lifecycle payloads and listener lists are snapshotted, listener failures are isolated, async rejections are consumed, and stale-generation events are suppressed. |
| M5 | Implemented and verified | Fetch constructs one effective `Request`, honors `RequestInit`, browser-relative URL semantics, media-aware bodies, immutable passthrough, and abort settlement across hooks, generators, adapters, and baseline fetch. |
| M6 | Implemented and verified | One response normalizer validates statuses, bodies, case-insensitive header uniqueness, controls, provenance, and adapter-owned framing. Every transport uses the same serializer; packed Core declarations compile under TypeScript 5.6. |
| M7 | Implemented and verified | Route/state/plugin/history generations are captured at transport admission. Reset is a commit barrier, preserves an explicit interception lease, and defers cleanup without allowing stale history or events. |
| M8 | Implemented and verified | History is snapshotted at insertion and read time; non-cloneable values retain their descriptors, and nested/non-enumerable shared memory is copied into ordinary isolated storage. |
| M9 | Implemented and verified | Node ingress has structured 400/413 errors, exact declared and observed byte limits, normalized JSON media types, malformed-JSON rejection, and connection-close semantics after overflow. |

Public-documentation reconciliation completed part of Phase 5:

- README, contributor guidance, and the project sheet now inventory all 11 workspaces and distinguish historical product milestones from audit-remediation phases.
- Core and adapter guides now document the completed state, reset, history, event, plugin, fetch, cancellation, response, server-lifecycle, and Node-ingress contracts.
- Release guidance now documents reproducibility, packed consumers, standalone declarations, TypeScript 5.6, React cross-entry identity, `publint`, and `attw` checks.
- Six of the 13 baseline documentation-drift rows are resolved. The table under "Documentation And API Drift" identifies the seven open rows; the separate schema-generator API promise also remains open.

Phase 1 local remediation verification passed:

- `bun run lint`, `bun run knip`, and `bun run eslint`
- `bun run test:all`: 1,785 unit, 1,153 BDD, and 137 integration cases
- `bun run test:e2e`: 14 cases
- `bun run check:publish`: reproducible build, 11 packed packages under Node and Bun, 12 strict declaration entries, React cross-entry identity, `publint`, `attw`, CLI, and browser bundle
- Package-generator regression: 19 cases

Final Phase 2 local verification passed:

- `bun run test:all`: 1,928 unit, 1,307 BDD, and 137 integration cases
- `bun run test:e2e`: 14 cases
- `bun run lint`, `bun run eslint`, `bun run knip`, and `git diff --check`
- `bun run build`
- `bun run check:typescript-5-6`: strict isolated consumer against the built Core declaration
- `bun run check:publish`: reproducible 125-artifact build for all 11 packages, packed Node/Bun runtime consumers, 12 strict declaration entries, packed TypeScript 5.6 Core consumer, `publint`, `attw`, CLI, and browser bundle
- Two independent post-implementation reviews found no remaining actionable findings in the Phase 2 lifecycle or transport scope

This is local evidence only. Canonical CI cited later still describes the reviewed baseline SHA. Findings M10 onward and the remaining minor findings remain open in whole or in part and are not claimed complete by this Phase 2 work. Documentation status is tracked separately below so baseline drift that has since been corrected is not presented as remaining work.

## Second-Pass Review And Repairs

A second independent review (Claude, 2026-08-09) examined the uncommitted Phase 1/2 remediation diff itself: ten subsystem reviewers over the full 108-file diff, with every non-minor finding adversarially verified by a separate agent instructed to refute it. Nine defects were confirmed (one blocker, eight major), three candidate findings were refuted, and all nine confirmed defects were then fixed in this same worktree. The gate suite was re-run green after the repairs.

Confirmed and fixed:

| Severity | Defect | Repair |
|---|---|---|
| Blocker | `serializeResponseBody` JSON-quoted string bodies under `application/json`/`+json` content types. Because function generators default to `application/json`, every `mock("GET /x", () => "...")` route changed its wire format, and pre-serialized JSON strings were double-encoded on the Node server, fetch interception (React/Vue), and Express. | String bodies are now emitted verbatim as pre-serialized wire bytes (`response-normalizer.ts`); transport tests pin the corrected contract. |
| Major | `copyBinaryBody` converted `Buffer` bodies to plain `Uint8Array`, so `response.body.toString("utf8")` silently returned a comma-joined byte list. | The copy now preserves the `Uint8Array` subclass via species-preserving `slice`, without referencing the `Buffer` global. |
| Major | A request with no `content-type` delivered a string body on Node but an opaque `ArrayBuffer` on Bun: the Fetch standard stamps `text/plain;charset=UTF-8` on string bodies and Bun's `Request` constructor omits it. | The interceptor now stamps the spec content type on the effective request when the runtime did not (`interceptor.ts`), making both runtimes deliver the same string body. |
| Major | `normalizeResponse` kept `Trailer`/`Transfer-Encoding` on 304 responses; Node's `writeHead` throws on them for bodyless responses, killing the socket with zero bytes sent. A new BDD step pinned the broken header set as "transport-safe". | 304 now keeps only `Content-Length` (RFC 9110); the scenario and unit tests pin the corrected set. |
| Major | The core server's error-response write in `#startHttpServer` was unguarded (unlike the CLI's), so a throwing `writeSchmockResponse` became an unhandled rejection with the client left hanging. | The catch handler is wrapped; on write failure the socket is destroyed. |
| Major | Express routed `errorFormatter` output through `normalizeResponse`, which throws on non-plain-JSON values (e.g. an embedded `Error`); the throw re-invoked the formatter and then escaped to Express's default HTML error page, leaking a stack trace with absolute paths. | A guarded sender falls back to a minimal safe 500 JSON without re-entering the formatter. |
| Major | Angular evaluated `normalizeResponse` on formatter output inside the promise `.catch`; a throw meant `observer.error` never fired and the HttpClient request hung forever. | The normalization is guarded with a safe fallback body so the Observable always settles. |
| Major | The 413 for an oversized body was discarded by a TCP reset whenever the client was still uploading: ending the response makes Node tear down the socket with request bytes in flight (reproduced as ECONNRESET with zero response bytes, and as intermittent failures of the new chunked BDD scenario). | `writeRejectedSchmockResponse` flushes the 413 immediately and defers the response end — a bounded lingering close (400 ms idle, 5 s cap) — until the client finishes or goes quiet. Used by both the core server and the CLI. |
| Major | Both declared-oversize regression tests sent headers only, so they passed without exercising the overflow-during-upload path they were cited as verifying. | The BDD scenario and a new unit test now transmit the declared body while awaiting the 413 and assert a clean structured response with no socket error; the CLI BDD suite passed 10 consecutive runs after the repair. |

Refuted (no action needed): the claim that `reset()` retaining the interception lease is an undisclosed break (it is documented in four guides and pinned by a dedicated test; the retained-lease design itself stands); the claim that `check-build-reproducibility` cannot detect the original B1 divergence (a probe showed a weakened `clean` fails the gate three independent ways); and the claim that the OpenAPI `undefined`-key filter is an undisclosed Phase 3 change (it is unreachable via HTTP ingress and M12 remains accurately listed as open).

Open minor observations from the second pass, left for later phases: cancelling a non-awaited `listen()` can surface an unhandled rejection; plugin `uninstall()` observes pre- or post-wipe state depending on in-flight requests; interceptor passthrough reconstructs the request rather than forwarding the caller's original arguments; `assertDeclaredTargets` skips the CLI `bin` entry; a failed watcher reload still leaves `cliServer` pointing at a closed server (already tracked under M28/Phase 4); and the async-listener isolation test asserts only weakly.

### Review of the repairs themselves

The repairs above were then adversarially reviewed in turn, with runtime probes on Node 26 and Bun 1.3 driving the real interceptor, the real adapters, and Express 5. Three follow-on defects were confirmed and fixed:

- **Interceptor content-type stamp only covered `init.body`.** A body carried by the input `Request` was never stamped, and `fetch(request, { headers })` replaces the whole header list, dropping the content type the input request carried — so the handler received an opaque `ArrayBuffer` where it should have received a string, on Node as well as Bun. The interceptor now restores the inherited body's content type from the input request when `init` replaces the headers. Residual limitation, unfixable at the interception layer: Bun never stamps a string body at `Request` construction, so a type-less string body on an input request (rather than in `init`) still arrives as `ArrayBuffer` on Bun; pass the body via `init` or set an explicit content type.
- **Express: the formatter itself ran outside the guard.** `sendFormattedError` guarded the normalizer, but a formatter that throws was invoked a second time from the outer catch with its own exception, which then escaped to Express's default handler — the exact HTML stack-trace leak the guard was added to prevent (reproduced against Express 5.2.1). The formatter now runs inside the guard: it fires exactly once and any throw lands on the safe 500 fallback. The fallback also no longer appends its JSON body onto a response whose headers were already sent.
- **Angular: same shape.** A formatter throwing inside the promise `.catch` had nothing downstream to catch it, so `observer.error` never fired and the HttpClient request hung; on the resolved-500 path it was additionally invoked twice. Both call sites are now guarded — the Observable always settles and the formatter fires at most once.

Each fix carries a pinning test (interceptor, Express, and Angular suites). The full gate suite was re-run green after these repairs.

The same review cleared the riskiest first-round repairs with direct probes: the 413 lingering close delivers the complete response with no TCP reset, leaks no listeners or timers, and ends the response exactly once; the species-preserving binary copy is correct for `Buffer`, `subarray` views, and `SharedArrayBuffer`-backed views; and the stamped header values cannot throw under any `Headers` guard on either runtime.

Minor observations from this round, recorded for later: `normalizeResponse` now strips a user-set `Content-Length` from ordinary (non-HEAD/304) responses, which lands unevenly across transports (Express recomputes it, the core/CLI servers fall back to chunked, the interceptor emits neither) and costs Range/206 responses their declared length; the 5 s rejected-request drain cap coincides with Vitest's default test timeout; a string body under an explicit `application/json` content type is emitted verbatim even when it is not valid JSON (the documented trade-off of the double-encoding fix); a `Uint8Array` subclass with an incompatible `Symbol.species` now surfaces as a 500 instead of being copied; and `writeRejectedSchmockResponse` resolves the handler promise while the response can stay open for up to five seconds, so in-flight accounting and `server.close()` treat the request as finished early.

## What The Project Does

Schmock creates stateful HTTP mocks either from manually registered routes or from an OpenAPI document.

The central API is callable:

```ts
const mock = schmock({ state: {} })
mock("GET /users/:id", ({ params, state }) => state.users[params.id])
const response = await mock.handle("GET", "/users/1")
```

Its principal capabilities are:

| Workspace | Responsibility |
|---|---|
| `@schmock/core` | Route registration, matching, request state/history, plugins, fetch interception, and a Node HTTP server |
| `@schmock/faker` | JSON Schema data generation and field-name-aware Faker mapping |
| `@schmock/validation` | AJV request and response validation |
| `@schmock/query` | Filtering, sorting, and pagination of array responses |
| `@schmock/openapi` | Spec parsing, schema normalization, route registration, CRUD state, negotiation, validation, security, and callbacks |
| `@schmock/express` | Express request/response facade |
| `@schmock/angular` | Angular `HttpInterceptor` facade |
| `@schmock/react` | Provider, hook, and test helper around core fetch interception |
| `@schmock/vue` | Vue plugin and composable around core fetch interception |
| `@schmock/cli` | Standalone OpenAPI-backed HTTP server |
| `@schmock/schmock` | Aggregate dependency package and core convenience exports |

The normal request path is:

1. Parse and compile a route during registration.
2. Emit `request:start`.
3. Apply a namespace and find a static or parameterized route.
4. Build a `PluginContext` and run every `beforeRequest` hook.
5. Run the route generator unless a hook supplied a response.
6. Run every plugin `process` hook.
7. Interpret tuples or response envelopes and apply content conversion.
8. Apply delay, append request history, emit `request:end`, and return.
9. A transport adapter converts that response to Fetch, Node HTTP, Express, or Angular semantics.

OpenAPI adds a setup phase:

1. Parse and dereference a document.
2. Normalize OpenAPI schemas to JSON Schema-like data.
3. Detect CRUD resources and non-CRUD operations.
4. Generate/load seed data.
5. Install generated routes.
6. Use global plugin hooks for security, validation, `Prefer`, negotiation, response validation, and callbacks.

## Strong Parts

The following aspects are notably good and should be preserved during repairs:

- The public API is small, expressive, and easy to use in tests.
- Static route lookup uses a map while parameterized routes retain deterministic first-registration precedence.
- Error objects use machine-readable codes and structured context.
- Request guards run before route generators, which is the correct side-effect boundary.
- Response tuples are generally preserved through plugin transformations.
- The fetch dispatcher snapshots its interceptor stack, supports out-of-order restoration, and avoids overwriting a later third-party fetch owner.
- OpenAPI callback delivery is application-owned; Schmock does not silently perform callback network requests.
- Faker creates a separate Faker instance for each generation operation.
- Faker override writes reject `__proto__`, `constructor`, and `prototype`.
- All 11 package versions and internal semver ranges are aligned at 2.3.0.
- The explicit root build order currently includes all 11 workspaces in dependency order.
- All 39 feature files have matching step-definition files.
- The repository has meaningful unit, property, BDD, integration, and E2E layers rather than one monolithic suite.
- Admin mode is disabled by default and the CLI binds to loopback by default.

## Release Blockers

### B1. Fresh/uncached and warm/incremental builds produce different runtime artifacts

- Severity: Blocker
- Evidence: Reproduced with a forced clean TypeScript emit

Locations:

- `package.json:12`
- `tsconfig.json:11-13`
- `packages/faker/package.json:21-23`
- Equivalent build scripts in most workspaces
- `packages/faker/src/index.ts:9`
- `packages/query/src/index.ts:4`
- `packages/validation/src/index.ts:7`
- `packages/openapi/src/plugin.ts:5`

Most package builds run Bun first and TypeScript second:

```text
bun build:lib && bun build:types
```

The shared TypeScript configuration has `emitDeclarationOnly: false`, so a fresh `tsc` invocation emits JavaScript into the same `dist` directory and overwrites Bun's bundle. Whether that emit happens depends on ignored `tsconfig.tsbuildinfo` files. This makes local incremental output, a fresh CI checkout, and a release workstation capable of producing different packages from the same commit.

A forced clean Faker emit produced:

```js
import { version as packageVersion } from "../package.json";
```

Node.js then failed that import with `ERR_IMPORT_ATTRIBUTE_MISSING`. Bun accepts it. The release consumer imports package entries with Bun but also spawns the CLI through its Node shebang. A warm local build retained Bun's OpenAPI bundle and passed; canonical fresh CI emitted TypeScript JavaScript and the Node CLI check correctly failed on `@schmock/openapi/package.json`. Faker, Query, Validation, and OpenAPI all use the same package-version import pattern.

The current output already demonstrates the cache split: some packages are one-file Bun bundles while core is TypeScript's multi-file output. React is especially sensitive: the Bun output has the context bug in B3, while TypeScript's unbundled output preserves the shared relative import.

Smallest safe fix:

- Make every type build declaration-only.
- Clean `dist` before every package build.
- Give one tool sole ownership of runtime JavaScript.
- Eliminate cache-dependent output by using a disposable build directory or always deleting build-info files.
- Compare clean and warm build file lists and hashes in CI.
- Import each packed artifact with Node as well as Bun.

> **Verification note:** confirmed, including the fresh-versus-warm divergence (probed directly: a warm `tsbuildinfo` makes `tsc` skip re-emit, so a Bun bundle written afterward survives; a clean run overwrites it) and the Node `ERR_IMPORT_ATTRIBUTE_MISSING` failure on the clean emit. One scope refinement: the cache gating applies to the 9 packages whose `build:types` is `tsc -p tsconfig.json`. Core forced a fresh TypeScript runtime emit after its Bun build, while Angular forced a fresh declaration-only TypeScript emit after its Bun build; Core was therefore TypeScript-runtime-owned and Angular was Bun-runtime-owned. At the reviewed baseline, `packages/openapi/dist/plugin.js` already contained the raw `from "../package.json"` import that Node rejects.

### B2. Seven packages publish non-self-contained declarations

- Severity: Blocker
- Evidence: Standalone TypeScript consumer compilation

Locations include:

- `packages/faker/dist/index.d.ts:1-4`
- `packages/query/dist/index.d.ts:34`
- `packages/validation/dist/index.d.ts:20`
- `packages/openapi/dist/plugin.d.ts:11-26`
- `packages/express/dist/index.d.ts:36-49`
- `packages/react/dist/index.d.ts:2-9`
- `packages/react/dist/testing.d.ts:4-9`
- `packages/vue/dist/index.d.ts:3-7`

Source files rely on a triple-slash reference to `packages/core/schmock.d.ts`. TypeScript removes that reference from emitted declarations, leaving public signatures such as:

```ts
export declare function queryPlugin(options: QueryPluginOptions): Schmock.Plugin;
```

An isolated consumer of the seven package root entries produced 27 `TS2503: Cannot find namespace 'Schmock'` diagnostics across Faker, Query, Validation, OpenAPI, Express, React, and Vue. Including the public React testing subpath produced 33 diagnostics.

The repository typecheck misses this because all packages compile in one ambient environment. The release candidate test installs all tarballs together and runs JavaScript, not `tsc`, so it also misses it.

Core compounds the issue by embedding CLI and Node server types into its browser-facing root declaration. `packages/core/schmock.d.ts:757` references `node:http`, and `packages/core/src/http-helpers.ts` exposes `Buffer` and `ServerResponse`, while `@types/node` is only a development dependency.

Smallest safe fix:

- Replace public `Schmock.*` references with explicit type imports from `@schmock/core`.
- Keep ambient types internal or expose them through a declaration file that packages explicitly import.
- Move Node-only helpers and CLI types to Node-specific subpaths, or expose browser-safe structural protocols from the root.
- Add one strict standalone TypeScript fixture per tarball with `skipLibCheck: false`.
- Add a browser fixture with `types: []` for Core, React, Vue, and Angular.

> **Verification note:** confirmed — an independent standalone consumer reproduced exactly 27 `TS2503` diagnostics (33 with the React testing subpath), and a `types: []` browser fixture importing only `@schmock/core` fails on `node:http` and `Buffer` as described. One severity nuance: the diagnostics only surface with `skipLibCheck: false`; under the default `skipLibCheck: true` the compile succeeds and the `Schmock.*` signatures silently degrade to error types, so most consumers experience silent type loss rather than a hard build failure.

### B3. `@schmock/react/testing` bundles a second context

- Severity: Blocker
- Evidence: Reproduced against built files

Locations:

- `packages/react/package.json:22-25`
- `packages/react/src/testing.ts:6`
- `packages/react/dist/index.js:1`
- `packages/react/dist/testing.js:1`

Bun independently bundles `src/index.ts` into both public entry points. The testing bundle therefore contains its own `createContext(null)` and private `SchmockProvider` instead of importing the context from `dist/index.js`.

This installed-package usage fails:

```ts
import { useSchmock } from "@schmock/react"
import { renderWithSchmock } from "@schmock/react/testing"
```

A component calling the main entry's `useSchmock()` and rendered by the testing entry throws:

```text
useSchmock must be used within a SchmockProvider
```

Source tests import `./index.js` and `./testing.js` before bundling, so both use the same source module and pass.

Smallest safe fix:

- Preserve `testing.js -> index.js` as a runtime import, or use shared chunks with stable public output.
- Add a packed-artifact test that imports both public specifiers and renders a component calling the main hook.
- Treat shared context/singleton identity as part of the package contract.

## Major Findings: Core And Pipeline

### M1. Default shared state is request-local

Locations: `packages/core/src/builder.ts:79-88`, `packages/core/src/builder.ts:565-599`

`schmock()` does not initialize an internal state object. Both `routeState` and generator state use `this.globalConfig.state || {}`, allocating a new object when the caller did not explicitly provide `state`.

Runtime reproduction:

```json
{"bodies":[1,1],"state":{}}
```

A counter generator increments to 1 on every request rather than 1, then 2. This contradicts `RequestContext.state` being documented as shared mutable state. The constructor also retains the caller's config wrapper, so reset operations replace `config.state` on caller-owned configuration.

Smallest safe fix: shallow-clone `GlobalConfig` and always initialize one internal `state` object at construction.

### M2. Server startup has no `starting` state

Locations: `packages/core/src/builder.ts:350-419`

`listen()` checks `this.server` before the dynamic `node:http` import. Two synchronous calls both pass the guard and create servers. Only the last server is retained, so `close()` leaks the first.

Runtime reproduction started two ports; after `mock.close()`, one still returned 200 while the other was closed.

The same state gap allows `listen(); close()` or `listen(); reset()` to start a server after cleanup. A synchronous `server.listen()` exception can also leave partial state.

Smallest safe fix: model `idle -> starting -> listening -> closing` explicitly, reserve the pending start synchronously, and invalidate/cancel it from `close()` and `reset()`.

### M3. Plugin installation is non-atomic and request plugin lists are live

Locations: `packages/core/src/builder.ts:186-200`, `packages/core/src/plugin-pipeline.ts:67-117`, `packages/core/src/plugin-pipeline.ts:145-205`

The plugin is pushed before `install()` runs. If installation throws, `.pipe()` throws but the failed plugin remains active. A runtime probe showed `processed: 1` on the next request after a failed install.

The declared `install(): void` does not prevent an async implementation from being assigned. Such an install is not awaited and can reject later or register routes after requests begin. Pipeline loops also iterate the mutable plugin array, so a plugin appended during processing can run in the same request or grow the loop without bound.

The plugin contract also has no uninstall/dispose hook. `reset()` simply discards the array, so a third-party plugin that allocates timers, listeners, or other resources has no supported cleanup path.

Smallest safe fix: install first, register only after success, reject thenables from a synchronous install contract, snapshot the plugin list once at request admission, and add a cleanup hook before reset discards installed plugins.

### M4. Lifecycle observers can mutate or crash request handling

Locations: `packages/core/src/builder.ts:283-313`, `packages/core/src/builder.ts:467-471`, `packages/core/src/builder.ts:674-724`

Listeners execute synchronously without isolation. `request:start` is emitted before the request try/catch. A throwing listener made `handle()` reject, violating the documented public error boundary. A throwing `request:end` listener can enter the catch path, trigger a second `request:end`, and reject again. Async listener rejections are not observed.

Listener payloads also share mutable request objects, so a nominal observer can change headers or params before the generator receives them.

Smallest safe fix: define listeners as observational, pass snapshots, iterate a listener snapshot, catch synchronous failures, and explicitly consume returned thenables.

### M5. Fetch interception does not model the effective Fetch request

Locations: `packages/core/src/interceptor.ts:98-172`, `packages/core/src/interceptor.ts:174-247`, `packages/core/src/interceptor.ts:268-337`

The interceptor independently reconstructs URL, method, headers, and body instead of normalizing an effective `Request`.

Reproduced differences:

- `fetch(new Request(url, { method: "POST" }), { method: "PATCH" })` routed as POST.
- A pre-aborted matched request returned `200:completed` instead of rejecting with `AbortError`.
- Fragments can remain in relative path and query parsing.
- `FormData`, Blob, ArrayBuffer, typed-array, stream, and several override cases become `undefined` or differ from native Fetch behavior.
- String bodies are parsed as JSON regardless of media type, unlike the Node transport.

Canceled requests can therefore mutate state and history after consumers have abandoned them.

Smallest safe fix: construct one effective `Request` when possible, honor all `RequestInit` precedence, carry an `AbortSignal` through request context/delay, and parse body data according to content type and body kind.

### M6. Final response semantics are not normalized centrally

Locations: `packages/core/src/response-parser.ts:41-114`, `packages/core/src/interceptor.ts:365-392`, `packages/core/src/http-helpers.ts:102-148`, `packages/angular/src/index.ts:330-378`

`handle()`, Fetch, Node HTTP, Express, and Angular disagree on valid status codes and body suppression.

Reproduced case:

```json
{"direct":{"status":204,"body":{"impossible":true}},"intercepted":"TypeError:Response constructor: Invalid response status code 204"}
```

Node's Fetch implementation rejected a 204 body while direct handling retained it. Similar divergence exists for HEAD, 205, 304, informational statuses, and fractional statuses. Angular exposes bodies for HEAD/no-content responses and treats 1xx/3xx as successful emissions. Node HTTP may suppress or reject values independently.

The public result body is effectively `unknown`, so generators can also return streams and other non-serializable values. Fetch stringifies a `ReadableStream` to `{}`, Node JSON serialization can throw, and a function generator returning a string is labeled `application/json` even though transports send the unquoted string.

Smallest safe fix: create one final response normalizer/serializer that validates a finite integer transport-safe status, strips bodies for HEAD, 204, 205, and 304, and either supports or explicitly rejects each public body category before every adapter sees it.

> **Verification note:** confirmed. The 204-with-body rejection is runtime-specific: it throws under Node/undici exactly as documented, while Bun's fetch returns the body without throwing — a hard failure on Node, a silent spec violation on Bun.

### M7. `reset()` is not a lifecycle barrier

Locations: `packages/core/src/builder.ts:317-330`, `packages/core/src/builder.ts:577-672`, `packages/react/src/index.ts:38-57`, `packages/vue/src/index.ts:17-27`

An in-flight request can outlive `reset()`, observe a changed plugin list between phases, and repopulate newly cleared history. Reset also restores fetch interception. A mounted React or Vue adapter has no notification to reacquire it.

Runtime reproduction with a mounted React provider:

```json
{"before":"200:first","after":"299:real"}
```

After `mock.reset()` and route re-registration, the still-mounted provider silently used the baseline fetch.

Smallest safe fix: separate route/state/history reset from transport teardown, snapshot request dependencies, and use a lifecycle generation token to suppress stale commits.

### M8. Request history is not a snapshot at insertion time

Locations: `packages/core/src/builder.ts:206-220`, `packages/core/src/builder.ts:651-661`

History stores request and response references, then clones only when history is read. Mutating the returned response or original request options retroactively changes the historical record. A probe changed a nested response value to 9 and history reported 9.

When `structuredClone` fails, the fallback only spreads the record and response, leaving nested values shared.

Smallest safe fix: snapshot at insertion time and define a deliberate policy for non-cloneable values rather than silently retaining shared containers.

### M9. Node ingress loses intended client-error semantics

Locations: `packages/core/src/http-helpers.ts:55-95`, `packages/core/src/builder.ts:369-396`, `packages/cli/src/cli.ts:193-248`

`collectBody()` destroys the request socket before rejecting an oversized body. The core server then ignores the attached 413 and hardcodes 500; the CLI often cannot write its intended 413 because the socket is already gone.

Malformed JSON is silently returned as text. A CRUD POST can consequently accept malformed JSON and commit an ID-only item. Media-type matching is case-sensitive and checks any string containing `json`, rather than a normalized JSON media type.

Smallest safe fix: precheck declared length, stop buffering safely, return 413 before closing, normalize the base media type, accept `application/json` and `+json`, and return a structured 400 for malformed JSON.

> **Verification correction:** the direction is right but two details are wrong. First, the hardcoded 500 (`builder.ts:385-396`) is unreachable for oversized bodies: `req.destroy()` at `http-helpers.ts:69` preempts any response, so the client observes a connection reset — not a 500 and not a 413 (probed against a port-0 core server with an 11 MB body). The lost client-error semantics come from the destroy; the 500 branch is dead code for this input. Second, "the CLI often cannot write its intended 413" is overstated: `assertBodySize` prechecks the declared `Content-Length` (`cli.ts:160-168`, thrown at `cli.ts:220`) before `collectBody` runs, so the ordinary declared-length case writes a clean 413. Only chunked/undeclared uploads, or a lying `Content-Length`, reach the destroy path. The malformed-JSON and media-type sub-claims are confirmed as stated.

## Major Findings: OpenAPI

### M10. OpenAPI hooks are not scoped to routes owned by the plugin

Locations: `packages/openapi/src/plugin.ts:166-243`, `packages/openapi/src/request-pipeline.ts:48-93`

Every OpenAPI plugin runs against every matched route. With global security enabled, an unrelated manual route is protected by the spec. This was reproduced as a manual `GET /manual` returning 401.

Multiple OpenAPI plugins can similarly apply one spec's security, negotiation, validation, or callbacks to routes installed by another spec.

Smallest safe fix: assign a unique owner token to each generated route and return unchanged from every OpenAPI hook unless that token matches.

### M11. CRUD detection changes the declared method surface

Locations: `packages/openapi/src/crud-detector.ts:106-169`, `packages/openapi/src/crud-registration.ts:93-137`

A PUT or PATCH operation becomes the single internal `update` operation, and registration always creates both PUT and PATCH routes. A PUT-only spec therefore exposes PATCH. This was reproduced in `getRoutes()`.

The reverse also occurs: HEAD, OPTIONS, and methods in a group recognized as CRUD are consumed by detection but are not retained as non-CRUD routes. If PUT and PATCH both exist, only the first operation's metadata is retained.

Smallest safe fix: retain method-specific operation metadata and register exactly the methods declared by the spec. Return every unclassified path to non-CRUD registration.

### M12. CRUD mutations commit before the final response is accepted

Locations: `packages/openapi/src/generators.ts:222-316`, `packages/openapi/src/plugin.ts:199-243`

Create, update, and delete mutate shared state in the route generator. Only afterward does the plugin apply `Prefer`, content negotiation, and response validation.

Reproduction:

```json
{"rejectedStatus":400,"list":[{"name":"ghost","petId":1}]}
```

`Prefer: code=400` returned 400 while still creating the item. A 406 or response-validation 500 can likewise commit a mutation.

Smallest safe fix: stage CRUD changes in request-local state and commit only after negotiation and response validation succeed.

> **Verification note:** confirmed for `Prefer` and response validation on all mutating operations (the 400-while-creating probe reproduced). One scope nuance: for create specifically, a 406 does not commit — create negotiation runs in `beforeRequest` via `openapi:preflightResponseStatus` (`crud-registration.ts:50-52`, `plugin.ts:178-186`) and short-circuits before the generator. The 406-commits-a-mutation case applies to update and delete.

### M13. CRUD state keys do not identify a resource

Locations: `packages/openapi/src/crud-registration.ts:162-190`, `packages/openapi/src/generators.ts:157-185`

Collections, counters, and seed flags are keyed only by the final resource name. `/users` and `/admins/users` both use `openapi:collections:users`. A created `/users` record was immediately visible through `/admins/users`.

Nested resources also share one collection across parent IDs, so `/owners/1/pets` and `/owners/2/pets` are not isolated.

Smallest safe fix: key by a stable route/resource identity and include resolved parent parameter values for nested collections.

### M14. Schema overrides happen after resource detection, and normal CRUD omits `onSchema`

Locations: `packages/openapi/src/plugin.ts:71-75`, `packages/openapi/src/plugin.ts:96-155`

Resources and seed data are built from original schemas before `options.schemas` is applied during install. CRUD metadata holds old schema references after an entry is replaced. Generated seeds, CRUD wrappers, and returned bodies can therefore use the old shape while validation uses the replacement.

`onSchema` is correctly defined as a request-time callback because it receives params, query, and headers. Normal CRUD generators never invoke it; only static generation and `Prefer`-driven generation do.

Even without an override, create does not generate the declared response contract. It echoes the request and adds a numeric property named after the path parameter. A route such as `/pets/{petId}` whose response requires `{ id: string, createdAt: string }` receives `petId` instead. CRUD metadata also collapses response content to the selected JSON-like schema, so another negotiated media type can receive the wrong body shape.

Smallest safe fix: apply static `options.schemas` replacement before CRUD detection and seed generation. Invoke `onSchema` during normal CRUD response generation, then generate the resulting declared response schema and overlay only compatible request fields using an explicit identifier policy.

### M15. Schema normalization corrupts reused references and nullability

Locations: `packages/openapi/src/normalizer.ts:24-37`, `packages/openapi/src/normalizer.ts:46-52`

The `WeakSet` is never backtracked. If two properties reference the same dereferenced schema object, the first is normalized and the second becomes `{}`. A direct probe produced:

```json
{"first":{"type":"string"},"second":{}}
```

`nullable: true` is replaced with `schmockNullable` but the original non-null type remains. AJV therefore rejects null while Faker can post-process the same schema into null. The probe returned `nullValid: false`.

Smallest safe fix: use an active recursion stack with backtracking or memoized normalized nodes, and preserve validation nullability separately from Faker's generation probability.

### M16. External references lose their source base and have no resolver policy

Locations: `packages/openapi/src/parser.ts:128-150`

For a string source, the code first parses the file/URL and then dereferences the resulting object through a new static operation. Relative external references no longer carry the original source location and can resolve relative to the process working directory.

The parser also never invokes full OpenAPI validation. A document with a recognized version but malformed operations/responses can be partially skipped and served as a plausible mock instead of failing startup.

The same path accepts external file and HTTP references with no project-level byte, timeout, redirect, or trust policy. This is a local-file and outbound-request risk when a CLI user loads a remote or otherwise untrusted spec.

Smallest safe fix: parse and dereference through one parser instance with the source URI retained. Disable external resolution by default for CLI usage or constrain it to the canonical spec directory, with explicit opt-in for network references and resource limits.

### M17. Important OpenAPI request and server contracts are parsed away or ignored

Locations: `packages/openapi/src/parser.ts:156-178`, `packages/openapi/src/parser.ts:220-242`, `packages/openapi/src/parser.ts:378-443`

OpenAPI 3 request content is flattened to one JSON-like schema. Request `Content-Type` is never selected or rejected, so unsupported media types can be accepted and validated against the wrong schema. Swagger 2 `consumes` and `produces` are not retained.

Swagger `basePath` and OpenAPI server pathname are calculated into `ParsedSpec.basePath` but never applied during route registration. This is either a missing semantic or dead internal parsed state; current tests intentionally use unprefixed paths, so the intended contract needs a decision.

Smallest safe fix: retain request content maps, select by normalized request media type, return 415 when unsupported, and either apply server/base paths or explicitly document and remove the ignored field.

### M18. Generation limits and failure behavior are incomplete

Locations: `packages/openapi/src/seed.ts:18-80`, `packages/openapi/src/generators.ts:319-443`, `packages/openapi/src/request-pipeline.ts:708-727`, `packages/cli/src/cli.ts:68-90`

Seed count has no upper bound and runs one async generation per item. A count in the millions is accepted. Schema-generation failures on normal routes are converted to a declared success status with `{}`, so core error handlers do not see them. Operations with no 2xx response return an undeclared 200.

CLI seed manifests accept string file entries that are read without a byte/item limit or path boundary. Relative entries resolve from the process working directory rather than the manifest directory, and invalid manifest entry shapes are silently dropped.

This combines badly with Faker's incomplete recursive resource checks described in M20.

Smallest safe fix: enforce a centralized item/node/byte budget, choose a deterministic declared status when no 2xx exists, and return a structured 500 for generation failures.

### M19. Callback and response metadata are only partially honored

Locations: `packages/openapi/src/parser.ts:57-70`, `packages/openapi/src/parser.ts:247-275`, `packages/openapi/src/parser.ts:682-719`, `packages/openapi/src/crud-registration.ts:42-55`, `packages/openapi/src/crud-registration.ts:68-75`, `packages/openapi/src/callbacks.ts:19-44`, `packages/openapi/src/generators.ts:319-355`

Callback request body schemas are parsed but ignored. Dispatch sends the primary endpoint's response body instead of generating or validating the callback operation's declared request body.

Static route generation also omits declared response headers, while CRUD generators add them. `operationId` and tags are parsed but never attached to route metadata despite the ambient type documenting OpenAPI metadata extension keys.

Smallest safe fix: centralize response construction for all route kinds and build callback payloads from callback operation metadata.

## Major Findings: Data Plugins

### M20. Faker safety traversal and smart mapping can violate schemas

Locations: `packages/faker/src/validation.ts:62-175`, `packages/faker/src/validation.ts:188-373`, `packages/faker/src/schema-enhancement.ts:51-77`, `packages/faker/src/field-name-matcher.ts:98-145`

Safety validation walks only explicitly typed object properties and array items. It omits definitions, `$defs`, composition, conditionals, pattern properties, `contains`, and several other schema-bearing keywords. Enhancement does traverse some omitted branches without cycle detection.

A self-referential `allOf` schema passed validation and failed with `RangeError: Maximum call stack size exceeded`. Large nested `minItems` values can also bypass the advertised maximum.

Smart field mapping overwrites an existing non-UUID format and does not treat `multipleOf` as a numeric constraint. Reproduced output included an email address for a field declared `format: "date-time"` and age 44 for `multipleOf: 10`.

Smallest safe fix: use one cycle-aware schema walker for every schema-bearing Draft 7 keyword, enforce a cumulative generation budget, never replace an existing format, and include all numeric constraints in mapping guards.

### M21. Faker determinism and ownership are incomplete

Locations: `packages/faker/src/jsf-config.ts:12-21`, `packages/faker/src/jsf-config.ts:138-155`, `packages/faker/src/overrides.ts:61-99`, `packages/faker/src/overrides.ts:128-168`

Seeded Faker date methods still use the wall clock because no stable reference date is configured. The same seed can therefore produce different recent dates.

Generated defaults, enum objects, override objects/arrays, and single-expression state templates can retain caller-owned references. Mutating one generated item can affect other items, later requests, or caller configuration.

The package externalizes `json-schema-faker`, whose extension/format registries are module-global. Consumer calls to its global registration API can change Schmock generation despite per-call Faker instances.

Smallest safe fix: provide a deterministic reference date, clone non-primitive assigned/generated values, and isolate or encapsulate JSF registries rather than relying on shared module globals.

### M22. Query pagination and property access accept invalid states

Locations: `packages/query/src/index.ts:122-185`, `packages/query/src/index.ts:198-231`

Options are not validated. `maxLimit: 0` produced limit 0 and `totalPages: Infinity`, serialized as `null`. Negative, fractional, overflowing, and partially numeric query values also produce contradictory metadata or permissive parsing.

`queryPlugin()` is documented as valid but throws on an array response because implementation options are required. Plain filtering falls back to `query[field]`, reads inherited properties, and can collide with pagination controls. Mixed numeric/string sorting uses a non-transitive comparator and produces input-order-dependent results.

Smallest safe fix: validate options at creation, parse exact finite safe integers, use own-property reads, reject dangerous keys, remove or document the plain-key fallback, and define a total mixed-type order.

### M23. Validation can validate a different body from the one delivered

Locations: `packages/validation/src/index.ts:29-74`, `packages/validation/src/index.ts:103-190`, `packages/core/src/response-parser.ts:12-107`

AJV is constructed without `ownProperties: true`; inherited properties can satisfy `required` and `additionalProperties: false`. This was reproduced with a body that had no own `role` property but inherited `role: "admin"`.

Validation duplicates core's response-envelope detection with a weaker guard. It can validate an inner body that core later treats as a plain object. It also runs before core's `text/plain` conversion, so the delivered string can differ from the validated object.

Schema patterns compile to native regular expressions with no safety screening. Schemas are configuration and should be treated as trusted, but a catastrophic pattern still lets request-controlled data synchronously block an exposed mock server.

Smallest safe fix: enable own-property validation, centralize response decomposition/replacement in core, strengthen tuple headers, and define whether response validation targets the semantic body or final transport body.

## Major Findings: Adapters And CLI

### M24. Angular does not preserve Angular HTTP semantics

Locations: `packages/angular/src/index.ts:198-210`, `packages/angular/src/index.ts:330-378`

Reproduced behavior:

```json
{
  "headers":{"authorization":null,"raw":{"Authorization":"Bearer token"}},
  "text":{"channel":"next","body":{"object":true},"ok":true},
  "redirect":{"channel":"next","body":{"moved":true},"ok":false}
}
```

Header names keep caller casing, so handlers expecting normalized `headers.authorization` miss `Authorization`. `HttpRequest.responseType` is ignored, allowing an object where Angular promises text. Only statuses at least 400 enter the error channel; Angular's real backends treat every non-2xx status as an error. HEAD/no-content bodies are retained, and response URLs use `req.url` instead of `urlWithParams`.

Smallest safe fix: lowercase header keys, normalize by `responseType`, treat only 200-299 as success, strip prohibited bodies, and use `urlWithParams`.

### M25. Error formatting infers exception provenance from public body fields

Locations: `packages/express/src/index.ts:228-256`, `packages/angular/src/index.ts:336-415`

Both adapters assume any status 500 body containing `error` and `code` came from a thrown core error. A deliberate domain response was rewritten by `errorFormatter`, and Express discarded its `retry-after` header:

```json
{"status":500,"body":{"formatted":true},"retryAfter":null}
```

If the formatter itself throws, both adapters can invoke it a second time. Angular can then leave the Observable without `next`, `error`, or `complete`; Express 4 can be left with a rejected async middleware promise. Angular's `transformRequest` also runs outside its Observable error boundary.

Smallest safe fix: carry non-public error provenance from core, invoke formatters once behind a guarded boundary, preserve headers, and move Angular transformation into the Observable chain.

> **Verification note:** confirmed on Express 5 (the installed 5.2.1 forwards the rejected middleware promise to the error handler) and on Angular. The Express 4 dangling-rejection clause follows from Express 4 semantics and the declared `^4.18.0` peer range but was not reproduced here. The header loss is Express-only; Angular's error path preserves headers (`index.ts:363`).

### M26. Browser adapter ownership and cleanup are under-specified

Locations: `packages/core/src/builder.ts:435-448`, `packages/react/src/index.ts:38-57`, `packages/vue/src/index.ts:17-27`

One mock can own only one interception handle. Nested React providers, concurrent roots, two Vue apps, or a framework adapter plus manual interception using the same mock throw `ALREADY_INTERCEPTING` rather than sharing ownership.

Vue acquires interception during `app.use()` but releases it only through `app.onUnmount()`. An SSR app or an app that never mounts leaves fetch patched. This was reproduced: fetch remained patched after `unmount()` on an unmounted SSR app.

React option updates remove and re-add an interceptor, changing global stack precedence relative to other roots.

Smallest safe fix: introduce reference-counted ownership leases per mock, preserve stack position on option updates, and define explicit SSR/mount-failure behavior.

> **Verification note:** confirmed. Mechanism detail for the fix: the precedence change is a reorder inside Schmock's single shared interceptor registry (dispatched in reverse-registration order, `interceptor.ts:36-53`; `restore()` only splices the entry and restores baseline fetch when the array empties), not re-wrapping of `globalThis.fetch`. It only manifests when two or more mocks are registered concurrently.

### M27. CLI admin and history become unsafe when exposed

Locations: `packages/cli/src/cli.ts:93-131`, `packages/cli/src/cli.ts:251-269`, `packages/core/src/builder.ts:651-672`

`--admin` provides unauthenticated state, route, and full request-history reads plus destructive reset. When combined with `--hostname 0.0.0.0`, any reachable client can inspect bodies and headers, including authorization data. `--cors` adds wildcard CORS to admin responses.

The CLI does not configure `maxHistorySize`; history remains unbounded even when admin is disabled and retains potentially expanding response bodies.

The safe defaults reduce exposure, but an explicitly supported deployment combination creates credential disclosure and memory-exhaustion risk without warning.

Smallest safe fix: require an admin token, separate admin CORS, warn/refuse non-loopback admin binds, redact sensitive headers, and use a conservative configurable history cap or zero history when admin is off.

### M28. Watch and shutdown lifecycle can leak or drop servers

Locations: `packages/cli/src/cli.ts:272-307`, `packages/cli/src/cli.ts:386-447`, `packages/cli/src/cli.ts:464-498`

Watch setup occurs after the server is bound. If `fs.watch()` fails, `run()` rejects but leaves the live server open. Reload prepares a mock, then force-closes all active connections, unbinds the port, and opens a replacement; a bind failure leaves the service offline.

Signal handlers are never removed. Shutdown uses `server.close()` without a grace timeout or forced active-connection closure, so a partial request can prevent process termination. `createCliServer({ watch: true })` silently ignores the public `watch` option.

Smallest safe fix: keep one HTTP server and atomically swap the current mock, own watcher/signal cleanup in the returned server object, and implement bounded graceful shutdown.

> **Verification note:** confirmed, with two refinements. The realistic `fs.watch` failure triggers are permissions, descriptor exhaustion, or an unlink race — the spec was already read successfully by that point, so a plain missing file is not the normal path. And a failed reload has one further consequence the report understates: the catch at `cli.ts:431-435` only logs, leaving `cliServer` pointing at the already-closed old server, so a later shutdown closes a dead server.

### M29. CORS and response framing are not transport-owned

Locations: `packages/cli/src/cli.ts:38-45`, `packages/cli/src/cli.ts:193-229`, `packages/openapi/src/generators.ts:91-143`, `packages/core/src/http-helpers.ts:102-148`

With CORS enabled, every OPTIONS request is intercepted as a 204, including an OPTIONS operation explicitly declared in the spec. The fixed allow-header list blocks ordinary custom preflight headers.

Spec-generated headers are passed to Node unchanged. A declared `Content-Length`, `Transfer-Encoding`, `Connection`, or related hop-by-hop/framing header can conflict with the actual serialized body and cause truncation or parser desynchronization.

Smallest safe fix: recognize actual preflight requests, make CORS policy configurable, and strip/recompute all transport-controlled headers at the adapter boundary.

> **Verification note:** confirmed. Scope detail: declared response headers are only generated on CRUD routes (`crud-detector.ts:215`, `generators.ts:206-315`); non-CRUD routes emit none, so the framing-header passthrough risk arises specifically on CRUD-generated responses.

## Minor Findings And Smells

These are actionable but lower priority than the findings above.

| Location | Finding | Direction |
|---|---|---|
| `packages/core/src/route-matcher.ts:32-44` | Static routes accept trailing slashes but parameterized routes do not, while duplicate detection treats them as equivalent. | Canonicalize route and request paths once. |
| `packages/core/src/parser.ts:23-35` | The documented strict `METHOD /path` grammar accepts `GET users`. | Require a leading slash and refine `RouteKey`. |
| `packages/core/src/route-matcher.ts:63-66` | Parameter names such as `__proto__` disappear when assigned into `{}`. Similar loss exists in query parsing. | Use null-prototype records or own-property definitions. |
| `packages/core/src/builder.ts:662-671` | Fractional, negative, `NaN`, and infinite history limits are not validated. | Require a finite non-negative integer at construction. |
| `packages/core/src/helpers.ts:46-57` | `paginate()` produces nonsensical slices/pages for invalid numeric options. | Normalize or reject public numeric inputs. |
| `packages/core/src/errors.ts:1-3` | Non-Error throws lose their useful value as `Unknown error`. | Preserve strings and safely stringify other values. |
| `packages/core/src/response-parser.ts:12-27` | Any domain object with numeric `status` and `body` is treated as an undocumented response envelope. | Export/document an explicit envelope or remove public ambiguity. |
| `packages/core/src/response-parser.ts:57-83` | Tuple header objects are retained and can be mutated by response parsing or later consumers. | Clone headers before mutation/return. |
| `packages/core/src/constants.ts:63-72` | A three-element tuple is accepted without validating the header element; `[200, [], null]` becomes a core 500. | Validate tuple headers in the type guard. |
| `packages/core/src/http-helpers.ts:84-90` | MIME matching is case-sensitive and over-permissive (bare substring match on `json`). **Verification correction:** media-type parameters such as `; charset=` do not break the check; the original "parameter-sensitive" wording was wrong. | Normalize the base media type. |
| `packages/core/src/builder.ts:645-723` | Matched generator/plugin failures are not recorded in history and use global delay instead of the matched route override. | Use one matched-request finalizer for success and failure. |
| `packages/core/src/interceptor.ts:101-117`, `packages/core/src/route-matcher.ts:56-68` | Unicode/literal path behavior differs between direct handling and encoded transport URLs; captured params remain percent-encoded. | Define one encoded path representation and decode captures safely. |
| `packages/core/src/builder.ts:456-464` | Debug logging records full headers, including credentials, and labels falsy bodies as absent. | Redact sensitive headers and check body presence explicitly. |
| `packages/core/src/builder.ts:492-545` | Namespace misses skip `request:notfound` and event paths alternate between original/stripped forms. | Route all misses through one finalizer. |
| `packages/openapi/src/content-negotiation.ts:14-52` | A high-q wildcard can override a more-specific `q=0` exclusion. | Score each representation using its most specific matching range. |
| `packages/openapi/src/generators.ts:319-355` | Static responses omit declared response headers. | Use one response constructor for static and CRUD operations. |
| `packages/openapi/src/generators.ts:94-143` | `fakerSeed` does not control UUID/date response headers. | Derive all random/time values from one seeded context. |
| `packages/openapi/src/normalizer.ts:55-91` | Discriminator mappings are paired with branches by object order rather than mapping target. | Preserve target identity through dereference/normalization. |
| `packages/openapi/src/plugin.ts:97-130` | Invalid schema override keys/status strings are silently ignored or partially parsed. | Validate every override key up front. |
| `packages/validation/src/index.ts:53-74` | One plugin AJV registry rejects separate validators with duplicate `$id` values. | Isolate validator registries or deliberately deduplicate identical schemas. |
| `packages/query/src/index.ts:6-41`, `packages/validation/src/index.ts:9-27` | Public option interfaces are named in docs but are not exported. | Export the owning configuration types. |
| `packages/faker/src/overrides.ts:17-28` | `NaN` and fractional explicit counts produce surprising array sizes. | Require a finite non-negative integer. |
| `packages/faker/src/test-utils.ts` | Test-only utilities are emitted during clean TypeScript builds but are not exported. | Exclude test helpers from production emission. |
| `packages/angular/src/index.ts:27-52` | Many standard status texts become `Unknown`. | Use the platform table or a complete mapping. |
| `packages/express/src/index.ts:173-267` | Hooks may send an Express response, but middleware does not check `headersSent` before continuing. | Stop after a hook-owned response. |
| `packages/cli/src/cli.ts:310-356` | `--seed-random` accepts `NaN`, extra positionals are ignored, and empty hostname can broaden binding. | Validate all command inputs exactly. |
| `packages/cli/src/cli.ts:286-302` | The startup `error` listener remains after listen and silently consumes later server errors. | Use a temporary `once` handler, then explicit runtime reporting. |
| `packages/cli/src/cli.ts:405-447` | Watching a file inode is fragile across atomic editor saves; watcher errors are unhandled. | Watch/re-arm the parent directory and handle watcher errors. |
| `package.json:26` | `test:all:silent` omits integration tests unlike the normal aggregate. | Keep aggregate variants behaviorally identical. |

## Residual Operational Risks

These are not necessarily defects under the current development-mock contract, but they should be explicit:

| Risk | Current behavior |
|---|---|
| Concurrent state updates | Shared state is mutable with no transaction/atomic update API; async read-await-write generators can lose updates. |
| Collection growth | OpenAPI CRUD collections and response bodies have no size/retention policy. |
| History memory | Core history remains intentionally unbounded unless the caller opts into a count cap; the cap does not account for body bytes. |
| Route scale | Parameterized matching is linear and duplicate registration is linear, so bulk registration can become quadratic during setup. |
| Regex work | Route regexes are generated safely, but user-supplied JSON Schema regexes can impose unbounded synchronous work. |
| Development server exposure | The CLI is a development server, not a hardened production gateway; this should be explicit near `--hostname`, `--admin`, and `--cors`. |

## FSM And Dead-Code Analysis

No formal finite-state machine implementation or FSM library exists in the repository. The phrase "state machine" does not appear in production code. The important finding is that several subsystems are state machines in behavior but are represented by loosely related booleans/references:

| Implicit machine | Current representation | Consequence |
|---|---|---|
| Core HTTP server | `server?: Server`, `serverInfo?` | No `starting` state; concurrent startup leaks a server. |
| Per-mock interception | `interceptHandle` plus module-global session | Same-mock owners cannot share; reset invalidates mounted adapters. |
| Request lifecycle | Live routes/plugins/history plus no epoch | Reset is not a barrier for in-flight requests. |
| CLI watcher/reloader | `closed`, timer, Promise queue, mutable server | Partial startup and replacement races are hard to reason about. |
| Angular passthrough | `innerSub` plus `aborted` | Underlying core work is not canceled; the extra subscription state is only partly useful. |

Introducing small explicit lifecycle states would remove several bugs. A generic FSM dependency is not needed.

Likely dead or stale production surface:

- `packages/core/src/builder.ts:74`: `serverInfo` is stored and cleared but never read after resolving `listen()`.
- `packages/core/src/errors.ts:52-60`: `ResponseGenerationError` is exported and tested but never raised by runtime code.
- `packages/openapi/src/parser.ts:24-31`: `ParsedSpec.basePath` is computed and returned but never consumed.
- `packages/openapi/src/parser.ts:61-70`: `operationId` and `tags` are parsed but not propagated to route configuration.
- `packages/core/src/plugin-pipeline.ts:197-201`: the `recoveredFromError` marker returned from the response pipeline is not used by its caller.
- `packages/faker/src/test-utils.ts`: production TypeScript emission includes a test helper that has no public export.
- `@vitest/ui` has no command/import.
- Root `@tsconfig/strictest` and `bun-types` are explicitly hidden from Knip and have no active configuration reference.
- `jsr.json` points to nonexistent root `src/index.ts`.
- `tsconfig.build.json` has no discovered caller.

Knip passes because public exports, ignored dependencies, and configured entry points make most of these invisible to graph-based dead-code analysis. The pass is still useful; it should not be treated as proof that lifecycle fields or published files are necessary.

## Package And Release Integrity

### Warm release checks still mask declaration and subpath failures

`bun run check:publish` passed locally for all 11 packages, including `publint` and `attw`, because the warm workspace retained several Bun bundles. Canonical fresh CI failed the same gate and correctly exposed B1 through the Node CLI check. The local pass and current gate design still do not protect B2 or B3:

- The release consumer is JavaScript, so declarations are never compiled.
- Every tarball is installed into one project, masking missing or ambient type edges.
- Direct runtime imports use Bun; Node coverage is limited to the CLI process.
- The React testing entry is imported but never used with the main hook.
- Browser verification bundles only Validation.
- No clean-versus-warm artifact comparison exists.

The standalone smoke and integration runners under `scripts/` are not called by root scripts or CI. Missing fixtures return success, and an all-skipped run can still print "All ... tests passed".

The architectural decisions describe framework adapters as single-install packages that bring core automatically, while React, Vue, Express, and Angular declare core only as a peer. Modern installers may auto-install peers, but every smoke fixture explicitly installs core and therefore does not verify the stated single-install promise.

### Published package payload is unnecessarily large

Core, Faker, Query, Validation, and OpenAPI include all of `src` in their package `files`. This publishes tests, BDD steps, fixtures, and ignored generated declaration maps.

Observed dry-run pack sizes:

| Package | Unpacked size | Main cause |
|---|---:|---|
| `@schmock/core` | 0.48 MB | Source tests and BDD steps |
| `@schmock/openapi` | 7.45 MB | Source tests plus a 6.1 MB Stripe fixture |

The OpenAPI browser bundle is also 0.56 MB minified. Much of that is a Node crypto polyfill pulled in for `randomUUID`; the Web Crypto API can avoid that cost.

There is no root `LICENSE` file and no package README. Angular is the only workspace without a manifest `license` field. Repository/homepage/bugs/engines metadata is absent across packages, including the Node CLI.

## Test And Quality-Gate Analysis

### Canonical CI is red

GitHub Actions run [29211598580](https://github.com/khalic-lab/schmock/actions/runs/29211598580) targets the exact reviewed SHA `3f646775d107164727b00afd999972a8e2ff1d62` and concluded failure.

- `check-publish` failed with `ERR_IMPORT_ATTRIBUTE_MISSING` for `@schmock/openapi/package.json`, directly confirming B1 on a fresh Linux build.
- `test-unit` reached the V8 heap limit during OpenAPI tests after 306 of 328 cases and 12 of 13 files. Other package unit suites had passed.
- Lint, ESLint, Knip, typecheck, build, BDD, integration, and E2E jobs passed.

The OpenAPI memory failure is itself a major quality-gate reliability issue. The stress suite and large specifications should run in bounded/isolated workers, and retained spec/schema graphs should be profiled rather than merely increasing the heap indefinitely.

### Local observed results

| Check | Result |
|---|---|
| `bun run lint` | Passed |
| `bun run knip` | Passed |
| `bun run eslint` | Passed |
| `bun run typecheck` | Passed |
| `bun run test:unit` | 1,785 passed |
| `bun run test:bdd` | 1,153 passed |
| `bun run test:integration` | 137 passed |
| `bun run test:e2e` | 14 passed |
| `bun run check:publish` | Passed locally for all 11 packages in the warm workspace |
| Canonical CI for reviewed SHA | Failed (`test-unit`, `check-publish`) |

Total locally reported Vitest test cases: 3,089 passed, zero failed. The 1,153 BDD count is step-level Vitest cases, not 1,153 independent Gherkin scenarios.

Repository scale observed:

- 166 package TypeScript/TSX files
- 44,853 package TypeScript/TSX lines, including tests and configs
- 59 unit/property test files
- 39 feature files
- 39 matching step-definition files

### Why the defects survive

The suites are extensive but predominantly exercise source modules inside the monorepo. Missing boundary cases include:

- Packed main/subpath singleton identity.
- Standalone strict declaration compilation.
- Node runtime import of each tarball.
- Clean versus incremental build equality.
- Concurrent `listen()` and close-during-start.
- Throwing/rejecting lifecycle listeners.
- Aborted matched fetches and full `RequestInit` precedence.
- Reset while requests or framework adapters are active.
- OpenAPI plugin route ownership.
- Mutation rollback after `Prefer`, 406, or response validation failure.
- Same-name and parent-scoped OpenAPI resources.
- Shared dereferenced schema objects and nullable AJV behavior.
- Angular header casing, `responseType`, 1xx/3xx, HEAD, and no-content bodies.
- Vue SSR, mount failure, and unmounted-app cleanup.
- CLI authentication, history bounds, framing headers, signal cleanup, and watch setup failure.

The post-review remediation closes the package-artifact and core lifecycle/transport gaps in this list. The later OpenAPI, adapter, CLI exposure, and plugin-safety gaps remain.

The official typecheck compiles package production code and BDD steps. Unit tests, integration tests, E2E tests, examples, and most TSX test code are not part of a strict semantic type gate.

One concrete false-positive test pattern exists at `packages/faker/src/plugin-integration.test.ts:304-310`: the catch block catches its own `expect.fail("Should have thrown")`, then accepts that assertion error because its name contains `Error`.

## Documentation And API Drift

Locations and drift descriptions refer to the reviewed baseline. The final column records the current worktree status.

| Baseline location | Baseline drift | Current worktree status |
|---|---|---|
| `docs/angular.md:16-24` | Registers `/api/users` while `baseUrl: "/api"` strips the prefix and routes to `/users`. | Resolved: the guide registers `/users`. |
| `docs/testing.md:203-215` | Repeats the Angular path mismatch and uses the unsupported runtime-generated `useClass` setup. | Open. |
| `docs/api.md:502-510` | Documents `useClass` even though implementation deliberately returns `useFactory`. | Open. |
| `docs/getting-started.md:145`, `docs/api.md:102` | Say `resetState()` restores initial values; implementation clears to `{}`. | Resolved: both guides document replacement with `{}` and caller-state preservation. |
| `docs/api.md:244-250` | Documents synchronous `generateFromSchema`; implementation returns a Promise. | Open. |
| `docs/api.md:355-363` | Documents optional Query options; implementation requires them and returns a plugin 500 when omitted on arrays. | Open. |
| `docs/api.md:300-311` | Documents custom Faker schema keywords that are absent from public schema types and rejected by ordinary strict AJV. | Open. |
| `docs/react.md:28`, `docs/vue.md:25` | Claim axios or any HTTP library is intercepted; only libraries using `globalThis.fetch` are covered. | Resolved: both guides limit interception to clients using `globalThis.fetch`. |
| `docs/vue.md:109-130` | Registers the same route twice; first-registration-wins means the empty-state example still returns Alice. | Resolved: each test registers exactly one route on a fresh mock. |
| `examples/debug-example.ts:71-83` | Calls the route API without the required generator and expects Faker to synthesize one. | Open. |
| `examples/content-type-example.ts:81-105` | Reads lowercase headers but direct calls pass title-case headers; output also reads the wrong header casing. | Open. |
| `docs/cli.md:15-18` | Startup output does not match the implementation. | Resolved: startup output matches `run()`. |
| `README.md:28-40` | Package table omits React, Vue, and the aggregate package. | Resolved: all 11 workspaces are listed. |

Six baseline drift rows are resolved and seven remain open. The ambient `Generator` type issue below is separate and also remains open.

The ambient `Generator` type includes `JSONSchema7`, but core treats schema objects as ordinary static data. Combined with the broken debug example, this is an API promise without an implementation. Either remove the schema branch or introduce an explicit schema-generator wrapper; heuristic object detection would be ambiguous.

## Recommended Remediation Order

### Phase 1: Make artifacts trustworthy

Status: implemented and locally verified in the post-review worktree; fresh remote CI remains pending.

1. Make type emission declaration-only and clean every package output.
2. Replace global public types with explicit imports.
3. Fix React cross-entry context identity.
4. Add clean/warm build equality, standalone TypeScript consumers, Node imports, and main/subpath interoperability tests.

Do not start broad runtime refactoring before this phase. Otherwise it will remain unclear which code is actually shipped.

### Phase 2: Establish one core lifecycle and transport contract

Status: implemented and locally verified in the post-review worktree; fresh remote CI remains pending.

1. Initialize shared state unconditionally.
2. Add explicit server/interceptor/request lifecycle states or generation tokens.
3. Make plugin installation atomic and snapshot plugins per request.
4. Isolate lifecycle observers.
5. Normalize final status/body/header semantics once.
6. Normalize Fetch requests and propagate abort signals.
7. Snapshot history at insertion.
8. Repair Node body-limit and malformed-JSON behavior.

### Phase 3: Make OpenAPI operations transactional and owned

1. Tag routes with plugin/resource identity.
2. Preserve exact declared HTTP methods.
3. Apply schema overrides before detection/seeding.
4. Stage and commit CRUD mutations only after final validation.
5. Key collections by route and parent parameters.
6. Repair shared-reference and nullable normalization.
7. Retain request content maps and decide server/base-path semantics.
8. Add resolver policy and generation budgets.

### Phase 4: Repair adapters and exposed server behavior

1. Complete Angular HttpClient `responseType` and URL semantics.
2. Define explicit Vue SSR behavior.
3. Secure/cap CLI admin and history.
4. Make watcher reload atomic and shutdown bounded.
5. Define an explicit CORS policy at the transport layer.

### Phase 5: Tighten plugins, tests, and documentation

Status: partially started for public documentation only. Six of 13 baseline drift rows are resolved; the remaining corrections, executable documentation tests, and other Phase 5 work are still open.

1. Replace Faker's multiple walkers with one exhaustive traversal.
2. Validate Query/Validation numeric and own-property boundaries.
3. Wire packed smoke/integration fixtures into CI and fail on skipped fixtures.
4. Typecheck test and example code in suitable positive/negative projects.
5. Finish the remaining public-doc corrections and execute getting-started snippets as tests.
6. Remove dead fields, exports, dependencies, and package payload.

## Verification Notes

The review combined source tracing, caller/test tracing, static gates, full configured tests, package dry runs, strict in-memory TypeScript consumer compilation, and focused runtime probes.

Remote check evidence was also inspected. Canonical CI for the reviewed SHA failed in the fresh release-candidate check and from an OpenAPI unit-test heap exhaustion, despite the warm local commands passing.

Important probes reproduced:

- Default state counter: `1, 1`, with `getState()` still `{}`.
- Failed plugin install remained active.
- Throwing lifecycle listener rejected `handle()`.
- Fetch method override routed to the original Request method.
- Pre-aborted fetch returned a mocked 200.
- Concurrent `listen()` left one port alive after `close()`.
- History changed after mutating the returned response.
- Node Fetch rejected a 204 body retained by direct handling.
- OpenAPI global security protected a manual route.
- OpenAPI returned 400 while committing a create.
- Same-name OpenAPI resources shared records.
- PUT-only OpenAPI operation exposed PATCH.
- Reused normalized schema became `{}` on its second occurrence.
- OpenAPI nullable schema rejected null under AJV.
- Cyclic Faker `allOf` overflowed the stack.
- Faker smart mapping violated `date-time` and `multipleOf`.
- Query `maxLimit: 0` produced Infinity/null metadata.
- Validation accepted an inherited required property.
- Angular preserved `Authorization` casing, ignored text response type, and emitted 302 through `next` with `ok: false`.
- Vue SSR/unmounted setup left fetch patched.
- Mounted React interception died after `mock.reset()`.
- Built React testing helper could not provide the main hook's context.
- Standalone declaration probe found 27 `Schmock` namespace errors across roots and 33 when the React testing subpath was included.
- Forced fresh/uncached TypeScript output preserved a Node-invalid JSON import.

One ad-hoc Express probe produced the expected rewritten response and lost header, then retained an open process handle until the shell timeout terminated it. The normal Express unit and BDD suites passed.

The two pre-existing modified files under `.claude/skills/` were not reviewed or changed. Build and package verification also changed ignored generated output. After the review, the Phase 1 and Phase 2 source, package, release-gate, and documentation changes, plus the partial Phase 5 public-documentation reconciliation described in "Remediation Progress", were intentionally added to the worktree.
