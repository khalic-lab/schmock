---
name: dependency-management
description: >
  Manage Schmock project dependencies. Check for outdated packages, update
  safely, verify compatibility, and run publish checks.
argument-hint: "check | update [package] | audit"
disable-model-invocation: true
allowed-tools:
  - Bash(bash .claude/skills/dependency-management/scripts/check-deps.sh *)
---

# Schmock Dependency Management Skill

## Dependency Categories

### Root devDependencies

Shared tooling installed at the workspace root:

| Package | Purpose |
|---------|---------|
| `@biomejs/biome` | Linting and formatting |
| `typescript` | TypeScript compiler |
| `publint` | Package publishing validation |
| `@arethetypeswrong/cli` | Type export validation |
| `@vitest/coverage-v8` | Test coverage |
| `bun-types` | Bun runtime types |

### Per-package Dependencies

| Package | Key Deps |
|---------|----------|
| `@schmock/core` | None (zero deps) |
| `@schmock/schema` | `json-schema-faker`, `@faker-js/faker` (dev) |
| `@schmock/express` | None (express is peer dep) |
| `@schmock/angular` | None (angular packages are peer deps) |

### Peer Dependencies

Critical compatibility ranges:

| Package | Peer Dep | Range |
|---------|----------|-------|
| `@schmock/express` | `express` | `^4.18.0 \|\| ^5.0.0` |
| `@schmock/angular` | `@angular/core` | `>=15.0.0` |
| `@schmock/angular` | `@angular/common` | `>=15.0.0` |
| `@schmock/angular` | `rxjs` | `^7.0.0` |
| `@schmock/schema`, `express`, `angular` | `@schmock/core` | `^1.0.0` |

## Update Workflow

1. **Check outdated:**
   ```
   /dependency-management check
   ```

2. **Update specific package:**
   ```bash
   bun update <package>
   ```

3. **Verify after update:**
   ```bash
   bun check:publish    # Package exports still valid
   bun test:all         # All tests pass
   ```

4. **Commit the update:**
   ```bash
   git add bun.lockb package.json packages/*/package.json
   git commit -m "chore(deps): update <package> to <version>"
   ```

## Compatibility Rules

When updating dependencies, respect these constraints:

- **Angular** peer dep range: `>=15.0.0` — must support Angular 15 through latest
- **Express** peer dep range: `^4.18.0 || ^5.0.0` — must support both Express 4.18+ and 5.x
- **RxJS** peer dep: `^7.0.0` — Angular adapter relies on RxJS 7+ APIs
- **TypeScript** must stay compatible with all packages — test with `bun typecheck`
- **Vitest** — all packages must use the same major version

## Audit

Check for known security vulnerabilities:

```bash
npm audit
```

## Commands

| Command | Description |
|---------|-------------|
| `/dependency-management check` | Check outdated + compatibility |
| `/dependency-management update <pkg>` | Update a specific dependency |
| `/dependency-management audit` | Security audit |
