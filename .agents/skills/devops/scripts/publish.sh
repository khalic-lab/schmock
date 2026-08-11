#!/usr/bin/env bash
set -euo pipefail

# Guarded npm publication and unified GitHub release for Schmock.
#
# Usage:
#   publish.sh [all|package] --preflight
#   publish.sh [all|package] --dry-run
#   publish.sh [all|package] --execute --confirm <scope>@vX.Y.Z:<full-commit>

PACKAGES=(core faker validation query express react vue openapi angular cli schmock)
NPM_REGISTRY="https://registry.npmjs.org/"
GITHUB_REPOSITORY="khalic-lab/schmock"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

TARGET="all"
MODE="--preflight"
MODE_SET=0
CONFIRM=""

if [ "${1:-}" != "" ] && [[ "$1" != --* ]]; then
  TARGET="$1"
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --preflight|--dry-run|--execute)
      if [ "$MODE_SET" -eq 1 ]; then
        echo "ERROR: choose exactly one of --preflight, --dry-run, or --execute" >&2
        exit 1
      fi
      MODE="$1"
      MODE_SET=1
      shift
      ;;
    --confirm)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --confirm requires an exact scope@vX.Y.Z:full-commit token" >&2
        exit 1
      fi
      CONFIRM="$2"
      shift 2
      ;;
    *)
      echo "ERROR: unexpected argument: $1" >&2
      exit 1
      ;;
  esac
done

in_list() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

if [ "$TARGET" != "all" ] && ! in_list "$TARGET" "${PACKAGES[@]}"; then
  echo "ERROR: unknown package: ${TARGET}" >&2
  echo "Valid packages: ${PACKAGES[*]}" >&2
  exit 1
fi

if [ "$MODE" != "--execute" ] && [ -n "$CONFIRM" ]; then
  echo "ERROR: --confirm is valid only with --execute" >&2
  exit 1
fi

resolve_root() {
  if [ -n "${SCHMOCK_ROOT:-}" ]; then
    printf '%s\n' "$SCHMOCK_ROOT"
    return
  fi
  git rev-parse --show-toplevel
}

ROOT=$(resolve_root)
cd "$ROOT"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

read_manifest_field() {
  local manifest="$1"
  local field="$2"
  node -e '
    const [manifest, field] = process.argv.slice(1);
    const value = require(manifest)[field];
    if (typeof value !== "string" || value.length === 0) process.exit(2);
    process.stdout.write(value);
  ' "$manifest" "$field"
}

VERSION=""
HEAD_SHA=""

preflight() {
  require_command node
  require_command git
  require_command bun
  require_command npm
  if [ "$TARGET" = "all" ]; then
    require_command gh
  fi

  if [ ! -f package.json ] || [ ! -d packages ]; then
    echo "ERROR: $ROOT is not a Schmock workspace root" >&2
    exit 1
  fi

  local actual_count
  actual_count=$(find packages -mindepth 2 -maxdepth 2 -name package.json -type f | wc -l | tr -d ' ')
  if [ "$actual_count" -ne "${#PACKAGES[@]}" ]; then
    echo "ERROR: expected ${#PACKAGES[@]} workspace manifests, found ${actual_count}" >&2
    exit 1
  fi

  local pkg manifest name pkg_version
  for pkg in "${PACKAGES[@]}"; do
    manifest="./packages/${pkg}/package.json"
    if [ ! -f "$manifest" ]; then
      echo "ERROR: missing workspace manifest: $manifest" >&2
      exit 1
    fi

    name=$(read_manifest_field "$manifest" name)
    if [ "$name" != "@schmock/${pkg}" ]; then
      echo "ERROR: ${manifest} has unexpected package name: ${name}" >&2
      exit 1
    fi

    pkg_version=$(read_manifest_field "$manifest" version)
    if [ -z "$VERSION" ]; then
      VERSION="$pkg_version"
    elif [ "$pkg_version" != "$VERSION" ]; then
      echo "ERROR: workspace versions are not synchronized (${pkg} is ${pkg_version}, expected ${VERSION})" >&2
      exit 1
    fi
  done

  if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: unsupported release version: ${VERSION}" >&2
    exit 1
  fi

  if ! bun "$SCRIPT_DIR/bump.ts" check-lockfile; then
    echo "ERROR: release lockfile does not match the workspace manifests" >&2
    exit 1
  fi

  local branch
  branch=$(git branch --show-current)
  if [ "$branch" != "main" ]; then
    echo "ERROR: releases require the main branch (current: ${branch:-detached})" >&2
    exit 1
  fi

  local worktree_status
  worktree_status=$(git status --porcelain)
  if [ -n "$worktree_status" ]; then
    echo "ERROR: releases require a clean worktree" >&2
    exit 1
  fi

  local fetch_url push_url remote_url
  fetch_url=$(git remote get-url origin)
  push_url=$(git remote get-url --push origin)
  for remote_url in "$fetch_url" "$push_url"; do
    case "$remote_url" in
      git@github.com:khalic-lab/schmock.git|git@github.com:khalic-lab/schmock|https://github.com/khalic-lab/schmock.git|https://github.com/khalic-lab/schmock|ssh://git@github.com/khalic-lab/schmock.git|ssh://git@github.com/khalic-lab/schmock)
        ;;
      *)
        echo "ERROR: origin does not exclusively target the canonical khalic-lab/schmock repository" >&2
        exit 1
        ;;
    esac
  done

  HEAD_SHA=$(git rev-parse HEAD)
  if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: could not resolve the full release commit" >&2
    exit 1
  fi

  echo "Preflight passed: ${#PACKAGES[@]} workspaces synchronized at ${VERSION} on clean canonical main (${HEAD_SHA})."
}

print_dry_run() {
  echo ""
  echo "DRY RUN: no registry queries, package publication, push, or GitHub calls will run."
  echo "Would validate and build:"
  echo "  bun run lint"
  echo "  bun run test:all"
  echo "  bun run build"
  echo "  bun run check:publish"
  echo "Would verify release access:"
  echo "  npm whoami --registry ${NPM_REGISTRY}"

  if [ "$TARGET" = "all" ]; then
    local pkg
    echo "  git push --dry-run origin main"
    echo "  gh auth status --hostname github.com"
    echo "  gh release view v${VERSION} --repo ${GITHUB_REPOSITORY} --json tagName"
    echo "  git ls-remote origin refs/tags/v${VERSION} refs/tags/v${VERSION}^{}"
    echo "Would inspect every package before publishing any package:"
    for pkg in "${PACKAGES[@]}"; do
      echo "  npm view @schmock/${pkg}@${VERSION} dist.integrity --json --registry ${NPM_REGISTRY}"
    done
    echo "Would publish packages reported as absent:"
    for pkg in "${PACKAGES[@]}"; do
      echo "  npm publish ./packages/${pkg} --access public --registry ${NPM_REGISTRY}  # only if unpublished"
    done
    echo "Would finalize:"
    echo "  git push origin main"
    echo "  gh release create v${VERSION} --repo ${GITHUB_REPOSITORY} --target ${HEAD_SHA} --title v${VERSION} ...  # only if absent"
  else
    echo "Would inspect every package before publishing any package:"
    echo "  npm view @schmock/${TARGET}@${VERSION} dist.integrity --json --registry ${NPM_REGISTRY}"
    echo "Would publish packages reported as absent:"
    echo "  npm publish ./packages/${TARGET} --access public --registry ${NPM_REGISTRY}  # only if unpublished"
    echo "Single-package mode would not push or create a GitHub release."
  fi
  echo "Execution would require: --confirm ${TARGET}@v${VERSION}:${HEAD_SHA}"
}

REGISTRY_OUTPUT=""

is_published() {
  local pkg="$1"
  local pkg_dir="packages/${pkg}"
  local remote_integrity local_pack_output local_integrity

  if REGISTRY_OUTPUT=$(npm view "@schmock/${pkg}@${VERSION}" dist.integrity --json --registry "$NPM_REGISTRY" 2>&1); then
    if ! remote_integrity=$(node -e '
      const value = JSON.parse(process.argv[1]);
      if (typeof value !== "string" || !value.startsWith("sha512-")) process.exit(2);
      process.stdout.write(value);
    ' "$REGISTRY_OUTPUT"); then
      echo "ERROR: npm returned no valid integrity for @schmock/${pkg}@${VERSION}" >&2
      return 3
    fi

    if ! local_pack_output=$(npm pack "./${pkg_dir}" --dry-run --json --ignore-scripts); then
      echo "ERROR: could not pack @schmock/${pkg}@${VERSION} for integrity verification" >&2
      return 3
    fi
    if ! local_integrity=$(node -e '
      const value = JSON.parse(process.argv[1]);
      const integrity = Array.isArray(value) && value.length === 1 ? value[0]?.integrity : undefined;
      if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) process.exit(2);
      process.stdout.write(integrity);
    ' "$local_pack_output"); then
      echo "ERROR: local pack returned no valid integrity for @schmock/${pkg}@${VERSION}" >&2
      return 3
    fi

    if [ "$local_integrity" != "$remote_integrity" ]; then
      echo "ERROR: @schmock/${pkg}@${VERSION} exists on npm with different package contents" >&2
      return 3
    fi
    return 0
  fi

  if [[ "$REGISTRY_OUTPUT" == *"E404"* ]] || [[ "$REGISTRY_OUTPUT" == *"404 Not Found"* ]]; then
    return 1
  fi

  echo "ERROR: could not determine npm status for @schmock/${pkg}@${VERSION}" >&2
  echo "$REGISTRY_OUTPUT" >&2
  return 2
}

PUBLISHED_COUNT=0
SKIPPED_COUNT=0
PUBLISH_QUEUE=()

plan_package() {
  local pkg="$1"
  local status

  if is_published "$pkg"; then
    echo "skip    @schmock/${pkg}@${VERSION} (already on npm)"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  else
    status=$?
  fi

  if [ "$status" -ne 1 ]; then
    return "$status"
  fi

  echo "plan    @schmock/${pkg}@${VERSION} (not yet on npm)"
  PUBLISH_QUEUE+=("$pkg")
}

publish_package() {
  local pkg="$1"
  local pkg_dir="packages/${pkg}"

  echo "publish @schmock/${pkg}@${VERSION}..."
  npm publish "./${pkg_dir}" --access public --registry "$NPM_REGISTRY"
  PUBLISHED_COUNT=$((PUBLISHED_COUNT + 1))
}

RELEASE_EXISTS=0

inspect_release() {
  local tag="v${VERSION}"
  local output
  if output=$(gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json tagName 2>&1); then
    RELEASE_EXISTS=1
    echo "ready   GitHub release ${tag} already exists"
    return 0
  fi

  if [[ "$output" != *"release not found"* ]] && \
     [[ "$output" != *"Release not found"* ]] && \
     [[ "$output" != *"HTTP 404"* ]]; then
    echo "ERROR: could not determine GitHub release status for ${tag}" >&2
    echo "$output" >&2
    return 1
  fi

  RELEASE_EXISTS=0
  echo "ready   GitHub release ${tag} does not exist"
}

inspect_remote_tag() {
  local tag="v${VERSION}"
  local output direct_sha="" peeled_sha="" tag_sha="" sha ref

  if ! output=$(git ls-remote origin "refs/tags/${tag}" "refs/tags/${tag}^{}"); then
    echo "ERROR: could not inspect remote tag ${tag}" >&2
    return 1
  fi

  if [ -z "$output" ]; then
    if [ "$RELEASE_EXISTS" -eq 1 ]; then
      echo "ERROR: GitHub release ${tag} exists but its remote Git tag is absent" >&2
      return 1
    fi
    echo "ready   remote tag ${tag} does not exist"
    return 0
  fi

  while IFS=$'\t' read -r sha ref; do
    case "$ref" in
      "refs/tags/${tag}") direct_sha="$sha" ;;
      "refs/tags/${tag}^{}") peeled_sha="$sha" ;;
    esac
  done <<< "$output"

  tag_sha="${peeled_sha:-$direct_sha}"
  if ! [[ "$tag_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: remote tag ${tag} did not resolve to a commit" >&2
    return 1
  fi
  if [ "$tag_sha" != "$HEAD_SHA" ]; then
    echo "ERROR: remote tag ${tag} does not point to the confirmed release commit" >&2
    return 1
  fi

  echo "ready   remote tag ${tag} matches ${HEAD_SHA}"
}

create_release() {
  local tag="v${VERSION}"
  gh release create "$tag" \
    --repo "$GITHUB_REPOSITORY" \
    --target "$HEAD_SHA" \
    --title "$tag" \
    --notes "Release ${tag} — all 11 @schmock/* packages."
}

preflight

case "$MODE" in
  --preflight)
    echo "No external actions executed."
    exit 0
    ;;
  --dry-run)
    print_dry_run
    exit 0
    ;;
  --execute)
    EXPECTED_CONFIRM="${TARGET}@v${VERSION}:${HEAD_SHA}"
    if [ "$CONFIRM" != "$EXPECTED_CONFIRM" ]; then
      echo "ERROR: execute mode requires --confirm ${EXPECTED_CONFIRM}" >&2
      exit 1
    fi
    ;;
esac

echo "Running validation..."
bun run lint
bun run test:all
bun run build
bun run check:publish

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: validation changed the worktree; refusing to publish" >&2
  exit 1
fi

echo ""
echo "Verifying release access..."
npm whoami --registry "$NPM_REGISTRY"

if [ "$TARGET" = "all" ]; then
  git push --dry-run origin main
  gh auth status --hostname github.com
  inspect_release
  inspect_remote_tag
fi

echo ""
echo "Inspecting npm state before publication..."

if [ "$TARGET" = "all" ]; then
  for pkg in "${PACKAGES[@]}"; do
    plan_package "$pkg"
  done
else
  plan_package "$TARGET"
fi

echo "Plan complete: publish ${#PUBLISH_QUEUE[@]}, skip ${SKIPPED_COUNT}."
echo ""
echo "Publishing planned packages at ${VERSION}..."

for pkg in "${PUBLISH_QUEUE[@]}"; do
  publish_package "$pkg"
done

if [ "$TARGET" = "all" ]; then
  echo "Summary: published ${PUBLISHED_COUNT}, skipped ${SKIPPED_COUNT} of ${#PACKAGES[@]} at ${VERSION}."
  echo "Pushing main..."
  git push origin main
  if [ "$RELEASE_EXISTS" -eq 1 ]; then
    echo "skip    GitHub release v${VERSION} (already exists)"
  else
    create_release
  fi
else
  echo "Single-package publish complete; no push or GitHub release was performed."
fi

echo "Done."
