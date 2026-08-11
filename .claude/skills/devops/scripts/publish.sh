#!/usr/bin/env bash
set -euo pipefail

# Always operate from the repo root so the ./packages/* paths and the version
# lookup below resolve regardless of where the script is invoked from.
cd "$(git rev-parse --show-toplevel)"

# Publish Schmock packages to npm and create one unified GitHub release.
#
# Run from the repo root:
#   bash .claude/skills/devops/scripts/publish.sh           # all 11 packages + vX.Y.Z release
#   bash .claude/skills/devops/scripts/publish.sh <package> # a single package (no release)
#
# Packages are listed in dependency order (deps before dependents):
#   core -> faker -> {validation,query,express,react,vue} -> openapi -> angular -> cli -> schmock

PACKAGES=(core faker validation query express react vue openapi angular cli schmock)

TARGET="${1:-all}"

# Tallied as packages are processed so we can tell "published something" from
# "everything was already on npm" (a no-op run that usually means: bump first).
PUBLISHED_COUNT=0
SKIPPED_COUNT=0

# Versions are kept in sync across all packages — read the canonical one from core.
VERSION=$(node -p "require('./packages/core/package.json').version")

# True if @schmock/<pkg>@<VERSION> is already on npm (makes the script resumable
# after a mid-run failure — npm refuses to republish an existing version).
is_published() {
  npm view "@schmock/${1}@${VERSION}" version >/dev/null 2>&1
}

in_list() {
  local needle="$1"; shift
  local item
  for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
  return 1
}

publish_package() {
  local pkg="$1"
  local pkg_dir="packages/${pkg}"

  if [ ! -f "${pkg_dir}/package.json" ]; then
    echo "ERROR: ${pkg_dir}/package.json not found"
    return 1
  fi

  if is_published "$pkg"; then
    echo "skip    @schmock/${pkg}@${VERSION} (already on npm)"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi

  echo "publish @schmock/${pkg}@${VERSION}..."
  # The leading ./ is REQUIRED: `npm publish packages/core` is parsed as a GitHub
  # owner/repo shorthand and fails with "Repository not found".
  npm publish "./${pkg_dir}" --access public
  PUBLISHED_COUNT=$((PUBLISHED_COUNT + 1))
}

# --- Validate -------------------------------------------------------------
echo "Running validation..."
bun lint:quiet
bun test:all:quiet

echo ""
echo "Building..."
bun run build:quiet

# --- Publish --------------------------------------------------------------
echo ""
echo "Publishing @schmock/* @ ${VERSION}..."

if [ "$TARGET" = "all" ]; then
  for pkg in "${PACKAGES[@]}"; do
    publish_package "$pkg"
  done

  echo ""
  echo "Summary: published ${PUBLISHED_COUNT}, skipped ${SKIPPED_COUNT} of ${#PACKAGES[@]} at ${VERSION}."

  # Nothing published + release already tagged => true no-op. The usual cause is
  # a re-run without bumping. Point the operator at the bump script and stop here.
  if [ "$PUBLISHED_COUNT" -eq 0 ] && gh release view "v${VERSION}" >/dev/null 2>&1; then
    echo ""
    echo "Nothing to publish — all ${#PACKAGES[@]} packages are already at ${VERSION} on npm and the"
    echo "v${VERSION} GitHub release already exists. If you have new changes to ship, bump first:"
    echo "    bun .claude/skills/devops/scripts/bump.ts patch   # or minor / major"
    echo ""
    echo "Done."
    exit 0
  fi

  # --- Tag: ONE unified release for the whole version (not per-package) ---
  # Push first so origin/main always reflects the published commit, then create
  # the release only if it doesn't already exist (resumable after a partial run).
  echo ""
  echo "Pushing main..."
  git push origin main
  if gh release view "v${VERSION}" >/dev/null 2>&1; then
    echo "skip    GitHub release v${VERSION} (already exists)"
  else
    echo "Creating GitHub release v${VERSION}..."
    gh release create "v${VERSION}" \
      --target main \
      --title "v${VERSION}" \
      --notes "Release v${VERSION} — all 11 @schmock/* packages."
  fi
elif in_list "$TARGET" "${PACKAGES[@]}"; then
  publish_package "$TARGET"
  if [ "$PUBLISHED_COUNT" -eq 0 ]; then
    echo "@schmock/${TARGET}@${VERSION} is already on npm — bump the version to publish new changes."
  fi
  echo "(single-package publish — no GitHub release created)"
else
  echo "Unknown package: ${TARGET}"
  echo "Valid packages: ${PACKAGES[*]}"
  exit 1
fi

echo ""
echo "Done."
