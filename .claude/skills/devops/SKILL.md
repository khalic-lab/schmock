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
3. **Build** — `bun build` for all packages
4. **Publish** — `npm publish` per package with `--access public`
5. **Tag** — `gh release create` per package

## Version Management

8 packages with synchronized versions tracked in `packages/*/package.json`.

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
3. `express`, `angular`, `validation`, `query` (depend on core — parallel)
4. `openapi` (depends on core + faker)
5. `cli` (depends on core + openapi)

### Known Pitfalls

- **CLI shebang**: Must be `#!/usr/bin/env node` (not `bun`) or npm strips the `bin` entry
- **Never use `workspace:*`** in dependencies — npm publishes it literally. Use `^version` ranges instead.

## Publishing Checklist

Before publishing:
- [ ] All tests pass (`bun test:all`)
- [ ] Lint passes (`bun lint`)
- [ ] Build succeeds (`bun build`)
- [ ] Package exports are correct (`bun check:publish`)
- [ ] Versions are bumped
- [ ] On `main` branch

During publishing:
- [ ] `npm publish --access public` per package
- [ ] Verify packages appear on npm

After publishing:
- [ ] Create GitHub release per package with `gh release create`
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
