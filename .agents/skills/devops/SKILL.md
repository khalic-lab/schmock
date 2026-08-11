---
name: devops
description: Plan and execute guarded releases for the 11-package Schmock monorepo, including synchronized version bumps, npm publishing, and one GitHub release. Use only when explicitly invoked for release work; never change manifests, publish, push, or create a release without the user's explicit approval of the exact version and scope.
---

# Schmock Release Operations

Treat release planning, manifest mutation, package publication, Git pushing,
and GitHub release creation as separate authorization boundaries. Never infer
permission for a later boundary from an earlier request.

## Current release topology

The release version is synchronized across these 11 workspaces:

`core`, `faker`, `validation`, `query`, `express`, `react`, `vue`, `openapi`,
`angular`, `cli`, `schmock`.

Publish in this dependency order:

1. `core`
2. `faker`
3. `validation`, `query`, `express`, `react`, `vue`
4. `openapi`
5. `angular`
6. `cli`
7. `schmock`

Read the live version from all `packages/*/package.json` files before acting.
Stop if there are not exactly 11 manifests, names do not match their directory,
versions are not synchronized, or `bun.lock` does not contain exact matching
workspace records and workspace resolutions. To run only this local check:

```bash
bun .agents/skills/devops/scripts/bump.ts check-lockfile
```

CI is defined in `.github/workflows/ci.yml` for pushes and pull requests to
`develop` and `main`.

## Guarded workflow

1. Run a local-only release preflight:

   ```bash
   bash .agents/skills/devops/scripts/publish.sh all --preflight
   ```

2. Preview a synchronized bump. Preview is the default and does not write:

   ```bash
   bun .agents/skills/devops/scripts/bump.ts patch
   ```

3. Ask the user to approve the bump level. Apply only after approval:

   ```bash
   bun .agents/skills/devops/scripts/bump.ts patch --apply
   ```

4. Inspect the 11 manifest diffs and cross-workspace ranges. Run the full
   quality gate, then commit the bump only if the user asked for a commit.

5. On a clean `main` checkout containing the committed bump, preview every
   external action:

   ```bash
   bash .agents/skills/devops/scripts/publish.sh all --dry-run
   ```

6. Report the exact version, package scope, npm actions, `main` push, and GitHub
   release that would occur. Ask for explicit approval of that exact release.

7. Only after approval, execute with the exact confirmation token:

   ```bash
   bash .agents/skills/devops/scripts/publish.sh all --execute \
     --confirm all@vX.Y.Z:<40-character-full-commit-sha>
   ```

For an explicitly requested single-package repair publish, replace `all` with
the workspace name. A single-package publish never pushes or creates a GitHub
release, but still requires the exact confirmation token.

## Script guarantees

- `bump.ts` defaults to dry-run and writes only with `--apply`.
- Applied bumps update the 11 manifests and exact `bun.lock` workspace records
  in one guarded transaction. Writes use same-directory atomic replacement,
  reject stale snapshots, and roll back only files still owned by the failed
  transaction.
- `publish.sh` defaults to `--preflight`; preflight and dry-run never query npm,
  publish, push, or call GitHub. Preflight invokes the real lockfile parity
  check before accepting release state.
- Execute mode requires
  `--confirm <scope>@v<live-version>:<full-commit-sha>`, a clean worktree, and
  the `main` branch.
- Execute mode runs lint, the full test suite, and the build before publication.
- Existing npm versions are skipped only when the registry query succeeds.
  Registry or authentication errors stop the release instead of being treated
  as an unpublished version.
- All-package execution pushes `main` and creates one unified `vX.Y.Z` GitHub
  release after package publication.

Keep the existing Bun and Bash shebangs. Never publish `workspace:*` ranges.
Always pass package directories to npm with a leading `./`.
