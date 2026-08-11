# Schmock Project Guidance

Schmock is a Bun/TypeScript monorepo for an HTTP mocking library with a callable API, an extensible `.pipe()` plugin pipeline, and framework adapters.

## Sources of Truth

- Follow `docs/coding-standards.md` for TypeScript and project conventions.
- Follow `CONTRIBUTING.md` for setup, testing, and branch workflow.
- Treat `packages/core/schmock.d.ts` as the single source of truth for shared ambient types.
- Consult `DECISIONS.md` before changing an established architectural choice.
- Keep the existing Claude setup under `.claude/` intact unless the user explicitly asks to change it. Codex-specific skill copies live under `.agents/skills/`.

## Workspaces

| Package | Responsibility |
|---|---|
| `@schmock/core` | Callable mock API, routing, request history, and plugin pipeline |
| `@schmock/faker` | Faker-backed schema data generation |
| `@schmock/validation` | Request and response validation with AJV |
| `@schmock/query` | Pagination, sorting, and filtering |
| `@schmock/openapi` | OpenAPI parsing, route registration, CRUD, and content negotiation |
| `@schmock/express` | Express middleware adapter |
| `@schmock/angular` | Angular HTTP interceptor adapter |
| `@schmock/react` | React provider, hooks, and test utilities |
| `@schmock/vue` | Vue plugin and composables |
| `@schmock/cli` | Standalone server CLI |
| `@schmock/schmock` | All-in-one aggregate package |

Derive workspace names and capabilities from `packages/*/package.json`. When release order is intentionally curated, validate the explicit order against every discovered manifest and fail on divergence rather than silently omitting a workspace.

## Development Workflow

1. Inspect the relevant implementation, feature files, tests, and architectural decisions before editing.
2. Check for an existing behavior contract before adding a new feature file.
3. For behavioral changes, work BDD-first: update `features/*.feature`, then the matching `packages/*/src/steps/*.steps.ts` or `.tsx`, then implementation and focused unit tests.
4. Preserve strict TypeScript. Prefer runtime narrowing and `satisfies`; do not add unsafe assertions, `any`, `@ts-ignore`, or `@ts-expect-error`.
5. Keep public API errors structured and preserve the established plugin lifecycle and response tuple behavior.
6. Prefer a direct, cohesive implementation first. Extract only at a proven reuse point, change boundary, or test seam; small duplication is better than a premature shared abstraction.
7. Make the smallest coherent change and avoid unrelated generated or historical files.

## Verification

Use focused checks while iterating, then scale verification to the change:

```bash
bun run --filter @schmock/<package> test
bun run --filter @schmock/<package> test:bdd
bun run lint
bun run test:all
bun run build
```

- `bun run test:all` covers typecheck, unit, BDD, and integration tests.
- Run `bun run check:publish` for package manifests, exports, build output, or release work.
- Run `bun run test:e2e` when adapter data quality or cross-framework behavior changes.
- For commands expected to take more than a few seconds, use the normal streaming variants so progress remains observable.
- Report exactly which checks ran and any checks that could not run.

## Repository Skills

Codex may invoke these with `$skill-name` or select them from their descriptions:

| Skill | Purpose |
|---|---|
| `$development` | Implement features and bug fixes with the BDD-first workflow |
| `$code-quality` | Select and run project quality checks |
| `$pr-review` | Perform a read-only, evidence-based change or PR review |
| `$plugin-authoring` | Design and implement Schmock plugins |
| `$dependency-management` | Audit or update dependencies when explicitly requested |
| `$package-generator` | Generate a new workspace package when explicitly requested |
| `$devops` | Prepare versioning or releases when explicitly requested |

Treat dependency updates, package generation, branch switching, publishing, pushing, releases, and remote PR mutations as explicit-request operations. A review request is read-only unless the user separately authorizes changes or comments.

## Git Discipline

- Preserve user changes and inspect `git status` before editing.
- Use the `feature/*` → `develop` → `main` flow when branch work is requested.
- Use conventional commits and never add AI-generated signatures or attribution trailers.
- Do not commit, push, publish, create releases, or change remote state unless the user explicitly asks.
