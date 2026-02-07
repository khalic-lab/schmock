---
name: devops
description: >
  Release management for Schmock packages. Version bumping, npm publishing,
  and GitHub release creation.
argument-hint: "bump patch|minor|major | publish [package]"
disable-model-invocation: true
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

4 packages with independent versions, tracked in two places:

- `packages/*/package.json` — each package's own version
- `.release-please-manifest.json` — central manifest for release-please

Both must stay in sync. The `bump` script handles this automatically.

### Current Versions

Check `.release-please-manifest.json` for current versions.

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
4. Updates `.release-please-manifest.json`
5. Prints a before/after table

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
- **release-please** — Automates version bumps and changelogs on `main`.

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
