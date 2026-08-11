---
name: dependency-management
description: Inspect, audit, and deliberately update dependencies in the Schmock Bun monorepo. Use when explicitly invoked to review outdated packages, security findings, publish compatibility, peer ranges, or a named dependency update; never mutate manifests or lockfiles without the user's explicit approval.
---

# Schmock Dependency Management

Start with the bundled preflight. It reads local manifests only:

```bash
bash .agents/skills/dependency-management/scripts/check-deps.sh preflight
```

Registry-backed checks require an explicit mode:

```bash
# Show commands without executing Bun or contacting a registry.
bash .agents/skills/dependency-management/scripts/check-deps.sh check --dry-run

# Execute only after the user explicitly asks for current dependency data.
bash .agents/skills/dependency-management/scripts/check-deps.sh check --execute
bash .agents/skills/dependency-management/scripts/check-deps.sh audit --execute
bash .agents/skills/dependency-management/scripts/check-deps.sh publish --execute
```

Do not treat `--dry-run` as evidence that packages are current or secure. The
script checks every workspace with `bun outdated --recursive` and propagates
failures from that command, `bun audit`, and `bun run check:publish`.

## Workspace invariants

The repository has 11 synchronized workspaces. Read the live version and all
dependency ranges from `packages/*/package.json`; stop if versions differ.

| Workspace | Important runtime or peer dependencies |
|---|---|
| `core` | No runtime dependencies |
| `faker` | `@faker-js/faker`, `json-schema-faker`; peer on `core` |
| `validation` | `ajv`, `ajv-formats`; peer on `core` |
| `query` | Peer on `core` |
| `express` | Peers on `core` and Express `^4.18.0 || ^5.0.0` |
| `react` | Peers on `core`, React `^18 || ^19`, and Testing Library `^16` |
| `vue` | Peers on `core` and Vue `^3.5.0` |
| `openapi` | Swagger Parser, `faker`, and AJV; peer on `core` |
| `angular` | Peers on `core`, `openapi`, Angular `>=15 <23`, and RxJS `^7.8.2` |
| `cli` | Runtime dependencies on `core` and `openapi` |
| `schmock` | Meta-package depending on `core`, `faker`, `validation`, `query`, `openapi`, and `cli` |

Cross-workspace `@schmock/*` ranges must track the synchronized live release.
Read root tool versions from `package.json` and `bun.lock`; do not copy versions
from this skill into an update proposal.

## Update workflow

1. Run local preflight, then `check --execute`.
2. Name the dependency and proposed version or range. Review all workspace and
   peer constraints before changing anything.
3. Ask for explicit approval to run `bun update <package>` or edit manifests.
   Do not infer approval from a request to check or audit dependencies.
4. Inspect the manifest and lockfile diff immediately after the update.
5. Run `bun run check:publish`, `bun run test:all`, and the relevant adapter
   compatibility tests.
6. Report results. Commit only when the user separately asks for a commit.

Preserve these compatibility floors unless the user deliberately approves a
breaking support change: Express 4.18 and 5, Angular 15 through 22, React 18 and
19, Vue 3.5+, and RxJS 7.8+.
