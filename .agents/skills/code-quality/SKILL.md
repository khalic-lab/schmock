---
name: code-quality
description: >
  Verify Schmock changes with the repository's Bun, Biome, TypeScript, Vitest,
  Knip, ESLint, integration, build, and benchmark checks. Use when testing a
  change, diagnosing a quality-gate failure, reviewing code, checking coverage,
  or preparing work for a commit.
---

# Schmock code quality

Resolve bundled paths relative to this `SKILL.md`. The scripts locate the Git
repository themselves, so they can be invoked from any working directory and
from any supported agent's skill directory.

## Choose the smallest useful check

- During implementation, run the affected package's tests with
  `scripts/test.sh <package>`.
- Verify all unit tests with `scripts/test.sh unit`.
- Verify behavior contracts with `scripts/test.sh bdd`.
- Run the repository suite with `scripts/test.sh all`. This includes typecheck,
  unit, BDD, and integration tests.
- Generate focused coverage with `scripts/coverage.sh <package>`.
- Before a commit, run `scripts/validate.sh`.

Coverage runs the package's `pretest` lifecycle when one is defined, then uses
the repository-installed `node_modules/.bin/vitest`. It fails if that binary is
unavailable; it never downloads a test runner implicitly.

Package arguments may be a short name such as `core` or a full workspace name
such as `@schmock/core`. The scripts discover live workspaces from the root
`package.json`; do not maintain a package-name allowlist in this skill.

Use `--dry-run` to inspect a script's selected commands without executing the
quality checks.

## Validation gate

`scripts/validate.sh` runs every stage and reports all failures:

1. Biome lint
2. TypeScript typecheck
3. Knip dead-code and dependency analysis
4. ESLint type-assertion checks
5. Unit tests
6. BDD tests
7. Integration tests
8. Package builds
9. Throughput benchmark

Each stage streams its normal command output. For a focused rerun, use:

- Lint: `bun run lint`, then `bun run lint:fix` when appropriate.
- Typecheck: `bun run typecheck`.
- Knip: `bun run knip`.
- ESLint: `bun run eslint`.
- Unit: `bun run test:unit`.
- BDD: `bun run test:bdd`.
- Integration: `bun run test:integration`.
- Build: `bun run build`.
- Benchmark: `bun run bench`.

Run `bun run test:e2e` when adapter behavior or published-package integration is
in scope. Run `bun run check:publish` when manifests, exports, declaration
output, or release packaging changes.

## Project expectations

- Treat `packages/core/schmock.d.ts` as the shared ambient-type source of truth.
- Preserve strict TypeScript and prefer runtime narrowing or `satisfies` over
  unsafe assertions.
- Keep `.feature` scenarios and their package step definitions aligned.
- Keep broad verification observable. Do not replace streaming checks with the
  repository's buffered quiet or silent variants.
