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

## Testing Strategy

### Unit Tests (`.test.ts`)

- Located in `packages/*/src/**/*.test.ts`
- Test internal logic, pure functions, edge cases
- Config: `packages/*/vitest.config.ts`
- Run: `bun test:unit` or per-package: `bun run --filter "@schmock/<pkg>" test`

### BDD Tests (`.steps.ts`)

- Located in `packages/*/src/steps/*.steps.ts`
- Test behavior against `.feature` specifications in `features/`
- Config: `packages/*/vitest.config.bdd.ts`
- Run: `bun test:bdd` or per-package: `bun run --filter "@schmock/<pkg>" test:bdd`
- 1:1 mapping: each `.feature` file has exactly one `.steps.ts` in the implementing package

### When to Run Each

| Situation | Command |
|-----------|---------|
| Quick check during development | `bun test:unit` |
| Verifying behavior contracts | `bun test:bdd` |
| Before committing | `bun test:all` (typecheck + unit + BDD) |
| Single package | `bun run --filter "@schmock/<pkg>" test` |

## Quality Gates

Before any commit, all of these must pass:

1. **Lint** — `bun lint` (Biome)
2. **Typecheck** — `bun typecheck` (tsc --build per package)
3. **Unit tests** — `bun test:unit`
4. **BDD tests** — `bun test:bdd`

Run all at once: `bun test:all`

The pre-commit Git hook runs these automatically. Use `/code-quality validate` to run the full gate manually.

## Coverage

Run per-package coverage reports with:

```
/code-quality coverage core
/code-quality coverage schema
```

Coverage excludes test files (`.test.ts`, `.steps.ts`). Focus on source coverage only.

## BDD Alignment Verification

To verify that `.feature` files and `.steps.ts` files are in sync:

1. Read the `.feature` file — note all Scenario names
2. Read the corresponding `.steps.ts` — verify each Scenario is implemented
3. Check that step text in `.steps.ts` matches the Gherkin steps exactly

This is a manual review — Claude reads and compares the files natively.

## Output Levels

All script categories support three output levels:

| Level | Suffix | Output | Use case |
|-------|--------|--------|----------|
| Normal | _(none)_ | Full output | Interactive development |
| Quiet | `:quiet` | Summary only | Claude assistant, CI logs |
| Silent | `:silent` | No output (exit code only) | Pre-commit hooks, CI gates |

### Quiet variants

- `bun test:quiet` — dots + final summary
- `bun lint:quiet` — last summary line only
- `bun build:quiet` — last summary line only
- `bun typecheck:quiet` — no output on success

### Silent variants

- `bun test:silent` — unit + BDD, no output
- `bun test:all:silent` — typecheck + unit + BDD, no output
- `bun lint:silent` — no output
- `bun build:silent` — no output
- `bun typecheck:silent` — no output

## Commands

| Command | Description |
|---------|-------------|
| `/code-quality test all` | Run typecheck + unit + BDD |
| `/code-quality test unit` | Run unit tests only |
| `/code-quality test bdd` | Run BDD tests only |
| `/code-quality test <package>` | Run tests for a specific package |
| `/code-quality validate` | Full quality gate (lint → typecheck → unit → BDD) |
| `/code-quality coverage <package>` | Per-package coverage report |
