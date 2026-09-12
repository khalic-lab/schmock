#!/usr/bin/env bash
set -euo pipefail

# `bun run publish` — the single local entry point for a release.
#
#   bun run publish                       # check everything, publish nothing
#   bun run publish -- --help
#   bun run publish -- all --execute --confirm all@vX.Y.Z:<40-char-commit>
#   bun run publish -- openapi --execute --confirm openapi@vX.Y.Z:<40-char-commit>
#
# With no arguments this runs every check a release runs — the release preflight
# (11 synchronized manifests, lockfile parity, clean canonical `main`), the full
# quality gate, and the dry-run plan — then prints the exact execute command and
# stops. Nothing is published, pushed, or tagged.
#
# Checking and publishing are deliberately separate. The confirmation token
# names both the version and the release commit so that a human, not a script,
# affirms what is going out; this wrapper prints that token but never passes it
# on your behalf. Anything you do pass is handed straight to the guarded script.

# `SCHMOCK_ROOT` exists for this wrapper's own tests, which drive it against a
# fixture workspace; the guarded script honours the same variable.
ROOT="${SCHMOCK_ROOT:-$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

# Overridable so the wrapper's own tests can drive a stub instead of the real
# script, which talks to npm and GitHub.
GUARDED_SCRIPT="${SCHMOCK_PUBLISH_SCRIPT:-.agents/skills/devops/scripts/publish.sh}"

if [ ! -f "$GUARDED_SCRIPT" ]; then
  echo "ERROR: guarded publish script not found: ${GUARDED_SCRIPT}" >&2
  exit 1
fi

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '4,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

# Any argument means the caller is driving the guarded script directly — a real
# `--execute`, a narrower `--dry-run`, a single package. Hand it over untouched.
if [ "$#" -gt 0 ]; then
  exec bash "$GUARDED_SCRIPT" "$@"
fi

echo "==> Release preflight"
bash "$GUARDED_SCRIPT" all --preflight

echo ""
echo "==> Quality gate (the same commands --execute runs)"
bun run lint
bun run test:all
bun run build
bun run check:publish

if [ -n "$(git status --porcelain)" ]; then
  echo "" >&2
  echo "ERROR: the checks changed the worktree — a release must publish exactly" >&2
  echo "what is committed. Inspect 'git status' before continuing." >&2
  exit 1
fi

echo ""
echo "==> Release plan"
bash "$GUARDED_SCRIPT" all --dry-run

VERSION=$(node -p "require('./packages/core/package.json').version")
HEAD_SHA=$(git rev-parse HEAD)

echo ""
echo "All checks passed. Nothing has been published, pushed, or tagged."
echo "To publish all 11 packages at ${VERSION}, push main and create the v${VERSION} release:"
echo ""
echo "    bun run publish -- all --execute --confirm all@v${VERSION}:${HEAD_SHA}"
echo ""
