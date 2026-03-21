# Schmock Project Instructions

Schmock is a TypeScript HTTP mocking library with a callable API, extensible plugin pipeline (`.pipe()`), and framework adapters for Express and Angular.

## Quick Reference

| Resource | Path |
|----------|------|
| Getting started | `docs/getting-started.md` |
| OpenAPI guide | `docs/openapi.md` |
| Testing patterns | `docs/testing.md` |
| API reference | `docs/api.md` |
| Plugin development | `docs/plugins.md` |
| Express adapter | `docs/express.md` |
| Angular adapter | `docs/angular.md` |
| CLI guide | `docs/cli.md` |
| Debug mode | `docs/debug-mode.md` |
| Coding standards | `docs/coding-standards.md` |
| Project roadmap | `project/schmock-project-sheet.md` |

## Packages

| Package | Description |
|---------|-------------|
| `@schmock/core` | Core mock builder, routing, and plugin pipeline |
| `@schmock/faker` | Faker-powered automatic data generation plugin |
| `@schmock/validation` | Request/response validation via AJV |
| `@schmock/query` | Pagination, sorting, and filtering for list endpoints |
| `@schmock/openapi` | Auto-register routes from OpenAPI/Swagger specs |
| `@schmock/express` | Express middleware adapter |
| `@schmock/angular` | Angular HTTP interceptor adapter |
| `@schmock/cli` | Standalone CLI server from OpenAPI specs |

## Skills

| Command | Purpose |
|---------|---------|
| `/development` | BDD-first workflow: scaffold features, reproduce bugs |
| `/code-quality` | Run tests, check coverage, validate quality gate |
| `/pr-review` | Review PRs against project standards |
| `/plugin-authoring` | Create new plugins following the Plugin interface |
| `/devops` | Version bumping, npm publishing, and GitHub release creation |

## Commands

```bash
bun install && bun run setup   # Initial setup (installs deps + git hooks)
bun test:all                   # Full suite: typecheck + unit + BDD
bun test:bdd                   # BDD tests only
bun lint                       # Lint check
```

**Claude must use quiet variants:** `bun test:quiet`, `bun lint:quiet`, `bun build:quiet`

## Workflow

- **Branches**: `feature/*` -> `develop` -> `main`
- **BDD-first**: Write `.feature` file -> step definitions -> implement -> refactor
- **Before committing**: Git hooks run lint + `test:all` automatically
- **Conventional commits**, no Claude signatures in commit messages
- **Features** in `/features/*.feature`, steps in `packages/*/src/steps/*.steps.ts`
- **Ambient types** in `packages/core/schmock.d.ts` — single source of truth for shared types
