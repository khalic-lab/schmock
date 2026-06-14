# Schmock Code Audit — MiMo 2.5 Free Zen · ~50k tokens

> **Model**: `opencode/mimo-v2-5-free` (MiMo 2.5 Free Zen)
> **Session tokens**: ~50k
> **Date**: Sun Jun 14 2026
> **Scope**: Full codebase — 11 packages, 36 feature files, ~55 unit test files, 35 BDD step files
> **Methodology**: Read-only deep analysis of all source, types, tests, and BDD scenarios. Findings verified against actual source code, not documentation.

---

## Executive Summary

Schmock is a well-architected, production-quality TypeScript HTTP mocking library with a clean plugin pipeline, framework adapters for React/Vue/Express/Angular, and comprehensive BDD coverage. The codebase is mature (v2.1.6) with zero runtime dependencies in core, thorough error handling, and strong patterns.

However, there are **stale declaration files shipping type-level bugs**, **inconsistent type definitions across packages**, and a few design concerns worth addressing. The issues are concentrated in the type system — runtime behavior is solid.

---

## CRITICAL: Type-Level Bugs

### 1. Stale `.d.ts` files ship with `any` and missing parameters

The compiled declaration files are out of sync with their source:

| File | Issue |
|------|-------|
| `packages/faker/src/index.d.ts:5,7` | `overrides?: Record<string, any>` and `state?: any` — source uses `unknown` |
| `packages/faker/src/index.d.ts:18` | `generateFromSchema(): any` — source returns `Promise<unknown>` |
| `packages/openapi/src/request-pipeline.d.ts:15` | `validateRequestBody(context)` — source has 2 params: `(context, validatorCtx)` |
| `packages/openapi/src/request-pipeline.d.ts:19` | `processPreferHeader` missing 4th param `onSchema` |

**Impact**: Consumers importing from these declaration files get weaker types (`any`) than the source provides. The missing `validatorCtx` parameter on `validateRequestBody` means consumers literally cannot call the function correctly.

**Fix**: Regenerate declaration files from source, or delete stale `.d.ts` files and rely on the source's inferred types.

### 2. `OpenApiOptions` type is split — consumers of `@schmock/openapi` lose fields

- **Ambient type** (`packages/core/schmock.d.ts:631-652`): includes `schemas` and `onSchema` fields
- **`@schmock/openapi` export** (`packages/openapi/src/plugin.d.ts:3-26`): **missing** `schemas` and `onSchema`
- **`plugin.ts:38`**: `export type OpenApiOptions = Schmock.OpenApiOptions` — re-exports the full ambient type, but `plugin.d.ts` was generated from an older version without these fields

**Impact**: Users who `import type { OpenApiOptions } from "@schmock/openapi"` cannot pass `schemas` or `onSchema` options without a type error, even though the runtime supports them.

**Fix**: Update `plugin.d.ts` to include `schemas` and `onSchema`, or delete the duplicate and only export from the ambient type.

### 3. `PaginatedResponse<T>` type mismatches query plugin output

- **Ambient type** (`schmock.d.ts:409-415`): `{ data: T[]; page: number; pageSize: number; total: number; totalPages: number }`
- **Query plugin actual output** (`query/src/index.ts:150-158`): `{ data: unknown[]; pagination: { page: number; limit: number; total: number; totalPages: number } }`

The ambient type uses flat `page`/`pageSize` while the plugin uses nested `pagination.limit`. These are structurally incompatible. The ambient type and the `paginate()` helper in `helpers.ts` describe a shape that the query plugin never produces.

**Fix**: Either update the ambient type to match the query plugin's nested `pagination` shape, or update the plugin to match the ambient type.

---

## HIGH: Design Concerns

### 4. `PluginContext.state` is `Map<string, unknown>` but nobody uses it

`builder.ts:547` initializes `pluginContext.state = new Map()`, but:

- The `RequestContext.state` is `Record<string, unknown>` (line 528)
- The faker plugin reads `context.routeState` (a `Record<string, unknown>`), not `context.state`
- No plugin in the codebase reads `PluginContext.state`

The `Map` on `PluginContext` is dead weight. The real shared state is `routeState`.

**Fix**: Convert `PluginContext.state` to `Record<string, unknown>` to match `RequestContext.state`, or remove it if unused.

### 5. `RouteConfig` index signature defeats type safety

`schmock.d.ts:128-135`:

```typescript
interface RouteConfig {
    contentType?: string;
    delay?: number | [number, number];
    [key: string]: unknown;  // ← any key accepted
}
```

A typo like `{ contenType: "json" }` compiles without error. The OpenAPI plugin stores many custom keys here, so a `RouteMetadata` bag type or branded extension would be safer.

### 6. Interceptor header casing is inconsistent

`interceptor.ts:84-109`: `Headers` instances preserve key casing, but plain objects get lowercased. A user passing `new Headers({"X-Custom": "val"})` sees different behavior than `{ "X-Custom": "val" }` in the intercepted request.

### 7. `isStatusTuple` ambiguity with real data

`constants.ts:63-72`: Any array `[number, unknown]` or `[number, unknown, Record]` is treated as a status tuple. A legitimate response like `[200, 300]` (two prices) would be misinterpreted. The code documents this as a known tradeoff.

---

## MEDIUM: Code Quality

### 8. `any` leaks in production code

- `packages/faker/src/jsf-config.ts:30,40` — `schema as any` for json-schema-faker compatibility
- `packages/angular/src/index.ts:106,199,230,232,282` — `HttpRequest<any>` / `HttpEvent<any>` — should be `<unknown>`
- `packages/core/src/builder.ts:72` — `Map<string, Set<Function>>` — should be `Set<(data: unknown) => void>`

### 9. `AdapterRequestOverride` duplicates `Partial<AdapterRequest>`

`schmock.d.ts` defines both `AdapterRequest` (lines 419-425) and `AdapterRequestOverride` (lines 578-584) — structurally identical except all fields are optional. `Partial<AdapterRequest>` would suffice.

### 10. `history()` overloads are stricter than implementation

`schmock.d.ts:288-319`: The overloads require both `method` and `path` together, or neither. The implementation (`builder.ts:194-232`) accepts either independently. Users cannot filter by method-only via the typed API.

---

## LOW: Testing Gaps

### 11. BDD features with thin coverage

| Feature | Scenarios | Concern |
|---------|-----------|---------|
| `deterministic-seeds.feature` | 1 | Only tests "same seed = same output", not different seeds or seed isolation |
| `errors-mode.feature` | 2 | Minimal edge case coverage for body validation |
| `content-negotiation.feature` | 2 | Missing wildcard Accept, quality factors |
| `watch-mode.feature` | 2 | Missing error recovery, rapid reload |

### 12. Flaky test risks

- `performance-reliability.feature:10` — hardcoded `50ms` threshold
- `response-delay.feature:11,19,25` — timing assertions under CI load
- `cli-standalone.steps.ts:106` — hardcoded port `9876` risks conflicts
- React/Vue adapter steps manually save/restore `globalThis.fetch` instead of using `AfterEachScenario`

### 13. BDD configs have no coverage measurement

None of the `vitest.config.bdd.ts` files configure coverage. BDD test coverage is invisible.

---

## What's Done Well

1. **Zero runtime deps** in core — clean dependency graph
2. **Property-based testing** in `parser.property.test.ts` — ReDoS resistance, unicode, path traversal
3. **Error hierarchy** — `SchmockError` → 7 specific subclasses with `code` and `context`
4. **Plugin pipeline** — clean lifecycle (`install` → `process` → `onError`) with good error recovery
5. **Framework adapters** — consistent pattern across React/Vue/Express/Angular with framework-idiomatic APIs
6. **Angular adapter** — AOT-safe `useFactory` provider, proper RxJS Observable teardown
7. **Faker test-utils** — schema factories, statistical validators, performance benchmarks
8. **36 feature files** with 200+ scenarios covering core through E2E
9. **CI matrix** — 6 parallel jobs with BDD tolerance on non-main branches
10. **BDD-first workflow** — feature files serve as both specs and automated tests

---

## Recommended Priority

| # | Action | Severity |
|---|--------|----------|
| 1 | Fix stale `.d.ts` files — regenerate or delete `faker/src/index.d.ts`, `faker/src/overrides.d.ts`, `openapi/src/plugin.d.ts`, `openapi/src/request-pipeline.d.ts` | Critical |
| 2 | Unify `OpenApiOptions` — make `plugin.d.ts` include `schemas` and `onSchema`, or delete the duplicate | Critical |
| 3 | Align `PaginatedResponse<T>` — update ambient type to match query plugin's nested `pagination` shape, or update the plugin | Critical |
| 4 | Remove dead `PluginContext.state` Map or convert to `Record<string, unknown>` | High |
| 5 | Add `AfterEachScenario` to React/Vue adapter step files for fetch restoration | Medium |
| 6 | Add BDD coverage config to `vitest.config.bdd.ts` files | Low |

---

*Audit generated by MiMo 2.5 Free Zen (opencode/mimo-v2-5-free), ~50k tokens, Sun Jun 14 2026*
