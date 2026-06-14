---
name: devops
description: >
  Release management for Schmock packages. Version bumping, npm publishing,
  and GitHub release creation.
argument-hint: "bump patch|minor|major | publish [package]"
allowed-tools:
  - Bash(bun .claude/skills/devops/scripts/bump.ts *)
  - Bash(bash .claude/skills/devops/scripts/publish.sh *)
---

# Schmock DevOps Skill

## Release Process

End-to-end release flow:

1. **Validate** — All quality gates pass (`/code-quality validate`)
2. **Bump** — Increment versions across all packages
3. **Build** — `bun build:quiet` for all packages
4. **Publish** — `npm publish ./packages/<pkg> --access public` per package (note the `./` — see Known Pitfalls)
5. **Tag** — push `main`, then a single unified `gh release create vX.Y.Z` for the whole version (NOT per-package)

## Version Management

11 packages with synchronized versions tracked in `packages/*/package.json`:
`core`, `faker`, `validation`, `query`, `express`, `react`, `vue`, `openapi`, `angular`, `cli`, `schmock`.

### Current Versions

Check any `packages/*/package.json` for the current version (all are kept in sync).

### Bumping

```
/devops bump patch   # 1.0.1 → 1.0.2
/devops bump minor   # 1.0.1 → 1.1.0
/devops bump major   # 1.0.1 → 2.0.0
```

The bump script:
1. Reads all `packages/*/package.json` versions
2. Increments by the specified level
3. Writes back to `package.json` files
4. Syncs cross-package `@schmock/*` dependency ranges (e.g., `"@schmock/core": "^1.8.0"`)
5. Prints a before/after table

### Publish Order

Dependencies must be published before dependents:
1. `core` (no deps)
2. `faker` (depends on core)
3. `validation`, `query`, `express`, `react`, `vue` (depend on core — parallel)
4. `openapi` (depends on core + faker)
5. `angular` (depends on core; optional peer on openapi — publish after openapi)
6. `cli` (depends on core + openapi)
7. `schmock` (meta-package — depends on core, faker, validation, query, openapi, cli — publish LAST)

### Known Pitfalls

- **CLI shebang**: Must be `#!/usr/bin/env node` (not `bun`) or npm strips the `bin` entry
- **Never use `workspace:*`** in dependencies — npm publishes it literally. Use `^version` ranges instead.
- **`npm publish` needs a `./` on the folder**: `npm publish packages/core` is parsed as a GitHub `owner/repo` shorthand — npm tries to clone `ssh://git@github.com/packages/core.git` and fails with "Repository not found". Use `npm publish ./packages/core --access public` (leading `./`), or `cd` into the package dir first.
- **zsh doesn't word-split unquoted vars**: a publish loop like `for pkg in $order` runs ONCE with the whole string in zsh (this session's shell). Use a literal list — `for pkg in core faker validation …` — or a zsh array `order=(core faker …)`.

## Publishing Checklist

Before publishing:
- [ ] All tests pass (`bun test:all:quiet`)
- [ ] Lint passes (`bun lint:quiet`)
- [ ] Build succeeds (`bun build:quiet`)
- [ ] Versions are bumped
- [ ] On `main` branch

During publishing:
- [ ] `npm publish ./packages/<pkg> --access public` per package (in dependency order)
- [ ] Verify packages appear on npm (`npm view @schmock/<pkg> version`)

After publishing:
- [ ] Push `main` to origin, then create a single unified GitHub release `vX.Y.Z` with `gh release create` (not per-package) — `publish.sh` does both automatically
- [ ] Update CHANGELOG if needed

## CI/CD Awareness

### GitHub Actions Workflows

- **develop.yml** — Runs on push to `develop` and PRs. Runs lint, typecheck, unit, BDD.

### Package Registry

- Scope: `@schmock/`
- Registry: npm (default)
- Access: `--access public` (scoped packages are private by default)

## Commands

| Command | Description |
|---------|-------------|
| `/devops bump patch\|minor\|major` | Bump all package versions |
| `/devops publish` | Full publish flow: validate → build → publish → release |
| `/devops publish <package>` | Publish a single package |
