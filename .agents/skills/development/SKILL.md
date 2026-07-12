---
name: development
description: >
  Implement Schmock features, bug fixes, tests, and refactors with the
  repository's BDD-first workflow and TypeScript conventions. Use whenever
  changing production code, feature scenarios, package step definitions, or
  starting an explicitly requested feature branch in the Schmock monorepo.
---

# Schmock development

Resolve bundled paths relative to this `SKILL.md`. The scripts locate the Git
repository themselves and do not depend on a particular agent directory.

## Orient first

- Read the relevant package manifest and nearby implementation and tests.
- Treat the root workspace configuration as authoritative. The repository
  currently has eleven `@schmock/*` workspaces; scripts discover them live
  rather than maintaining a package allowlist.
- Treat `packages/core/schmock.d.ts` as the shared ambient-type source of truth.
- Search existing `features/*.feature` scenarios before adding a new feature.

Run `bun scripts/scaffold.ts --check` using this skill's resolved script path to
list existing features, scenarios, and owning packages. The command recognizes
both `.steps.ts` and `.steps.tsx` definitions.

## Develop behavior first

1. Add or update a `.feature` scenario that states observable behavior.
2. Add matching step definitions in the package that implements the behavior.
3. Run the affected package's BDD test and confirm the intended failure.
4. Implement the smallest production change that satisfies the scenario.
5. Add focused unit or property tests for internal logic and edge cases.
6. Run focused tests, then the repository quality gate from the code-quality
   skill before handing off.

Follow the established feature style. Scenario Outlines and data tables are
valid when they make repeated cases clearer; the repository already uses both.
Keep step text synchronized exactly with its feature file and use DocStrings for
multiline code or JSON when appropriate.

To scaffold a feature and step pair, run:

```text
bun scripts/scaffold.ts <feature-name> <package>
```

Use `--dry-run` to inspect output paths without writing. The script accepts a
short package name or full `@schmock/*` name, discovers packages with a
`test:bdd` script, and emits `.steps.tsx` for JSX workspaces such as React.

## Keep changes safe and focused

- Preserve strict TypeScript and narrow `unknown` values before use.
- Prefer runtime validation or `satisfies` over unsafe type assertions.
- Follow nearby package patterns rather than introducing a new abstraction for
  one use case.
- Never overwrite an existing feature or step-definition file.
- Do not create or switch branches unless the user explicitly asks or approves
  that repository mutation.

After explicit approval, `scripts/start.sh <name>` creates
`feature/<name>` directly from `origin/develop`. It refuses a dirty worktree,
invalid branch names, an existing local branch, or a matching branch on
`origin`. A failed remote query is an error, not evidence that the branch is
absent. Use `--dry-run` to inspect the Git operations without fetching or
switching; the read-only remote existence check still runs.
