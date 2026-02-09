---
name: code-quality
description: >
  Code quality verification for Schmock. Run tests, check coverage, validate
  compliance. Use when testing, reviewing code, or preparing for commits.
argument-hint: "test all|unit|bdd|<package> | validate | coverage <package>"
allowed-tools:
  - Bash(bash .claude/skills/code-quality/scripts/test.sh *)
  - Bash(bash .claude/skills/code-quality/scripts/validate.sh)
  - Bash(bash .claude/skills/code-quality/scripts/coverage.sh *)
---

# Schmock Code Quality Skill

## The Gate: `/code-quality validate`

The primary command. Runs all 6 quality stages in order and reports pass/fail with fix hints:

| # | Stage | What it checks | Auto-fix? |
|---|-------|---------------|-----------|
| 1 | **Lint** | Biome: formatting, imports, code smells | `bun lint:fix` |
| 2 | **Typecheck** | tsc --build per package | Manual |
| 3 | **Knip** | Dead exports, unused dependencies | Manual |
| 4 | **ESLint** | `as` type assertions (zero tolerance) | Manual |
| 5 | **Unit** | `packages/*/src/**/*.test.ts` | Manual |
| 6 | **BDD** | `packages/*/src/steps/*.steps.ts` vs `features/*.feature` | Manual |

All 6 must pass before committing. The pre-commit hook enforces Lint + Typecheck + Unit + BDD automatically.

### When a stage fails

| Failed stage | What to do |
|-------------|------------|
| **Lint** | Run `bun lint:fix` — most issues auto-fix. For remaining: check biome output for the rule name and fix manually. |
| **Typecheck** | Run `bun typecheck` for full errors. Usually a missing import, wrong return type, or ambient type mismatch in `packages/core/schmock.d.ts`. |
| **Knip** | Run `bun knip` to see unused exports/deps. Either delete the dead code or, if intentional, add to `knip.json` ignore. |
| **ESLint** | Run `bun eslint` to see `as` casts. Replace with: `toHttpMethod()` for HttpMethod, `errorMessage()` for unknown errors, `"prop" in obj` narrowing, `FakerSchema` interface for jsf extensions. Never add `as` — use `satisfies` if needed. |
| **Unit** | Run `bun test:unit` for full output. Read the failing assertion, fix the source or update the test expectation. |
| **BDD** | Run `bun test:bdd` for full output. Common issues: step text doesn't match `.feature` file exactly, or a new Scenario is missing step definitions. Each step text must be unique within a Scenario. |

### Zero `as` policy

The codebase has zero unsafe type assertions. Patterns to avoid `as`:

| Instead of | Use |
|-----------|-----|
| `method as HttpMethod` | `toHttpMethod(method)` — runtime validation |
| `(error as Error).message` | `errorMessage(error)` helper or `instanceof Error` guard |
| `(obj as any).faker` | `FakerSchema` interface extending JSONSchema7, or `"faker" in obj` guard |
| `body as Record<string, unknown>` | `"code" in body && body.code === ...` narrowing |
| `error as SchmockError` | Redundant after `instanceof SchmockError` — just use `error.code` |
| `value as SomeType` | `satisfies SomeType` (checks without asserting) |

### Code smell detection stack

| Tool | Rules | Config |
|------|-------|--------|
| **Biome** | `noNonNullAssertion`, `noShadow`, `noEvolvingTypes`, `noFloatingPromises`, `noMisusedPromises`, `noImportCycles` | `biome.json` |
| **Knip** | Dead exports, unused dependencies, unlisted deps | `knip.json` |
| **typescript-eslint** | `no-unsafe-type-assertion` (error) | `eslint.config.js` |

## Testing

### Commands

| Command | Description |
|---------|-------------|
| `/code-quality validate` | **Full gate** — Lint, Typecheck, Knip, ESLint, Unit, BDD |
| `/code-quality test all` | Typecheck + Unit + BDD (no lint/knip/eslint) |
| `/code-quality test unit` | Unit tests only |
| `/code-quality test bdd` | BDD tests only |
| `/code-quality test <pkg>` | Tests for one package: core, schema, express, angular, validation, query |
| `/code-quality coverage <pkg>` | Per-package coverage report |

### Test types

| Type | Location | Config | Purpose |
|------|----------|--------|---------|
| Unit (`.test.ts`) | `packages/*/src/**/*.test.ts` | `vitest.config.ts` | Internal logic, edge cases |
| BDD (`.steps.ts`) | `packages/*/src/steps/*.steps.ts` | `vitest.config.bdd.ts` | Behavior contracts vs `.feature` specs |

### When to run what

| Situation | Command |
|-----------|---------|
| Quick check during dev | `/code-quality test unit` |
| Verifying behavior contracts | `/code-quality test bdd` |
| Before committing | `/code-quality validate` |
| Single package focus | `/code-quality test core` |
| After fixing lint/types only | `bun lint:quiet && bun typecheck:quiet` |

## Coverage

```
/code-quality coverage core
/code-quality coverage schema
/code-quality coverage validation
/code-quality coverage query
```

Excludes test files. Focus on source coverage only.

## Output Levels

| Level | Suffix | Use case |
|-------|--------|----------|
| Normal | _(none)_ | Interactive development |
| Quiet | `:quiet` | Claude assistant, CI |
| Silent | `:silent` | Pre-commit hooks |

Quiet variants: `bun test:quiet`, `bun lint:quiet`, `bun typecheck:quiet`, `bun knip:quiet`, `bun eslint:quiet`
