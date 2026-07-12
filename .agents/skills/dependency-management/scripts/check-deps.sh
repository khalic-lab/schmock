#!/usr/bin/env bash
set -euo pipefail

# Local preflight and explicit dependency checks for the Schmock monorepo.
#
# Usage:
#   check-deps.sh preflight
#   check-deps.sh check|outdated|publish|audit --dry-run
#   check-deps.sh check|outdated|publish|audit --execute

PACKAGES=(
  core faker validation query express react vue openapi angular cli schmock
)

TARGET="${1:-preflight}"
MODE="${2:-}"

resolve_root() {
  if [ -n "${SCHMOCK_ROOT:-}" ]; then
    printf '%s\n' "$SCHMOCK_ROOT"
    return
  fi

  if git_root=$(git rev-parse --show-toplevel 2>/dev/null); then
    printf '%s\n' "$git_root"
    return
  fi

  cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."
  pwd
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

preflight() {
  require_command node

  if [ ! -f package.json ] || [ ! -d packages ]; then
    echo "ERROR: $ROOT is not a Schmock workspace root" >&2
    exit 1
  fi

  local expected_count=${#PACKAGES[@]}
  local actual_count
  actual_count=$(find packages -mindepth 2 -maxdepth 2 -name package.json -type f | wc -l | tr -d ' ')
  if [ "$actual_count" -ne "$expected_count" ]; then
    echo "ERROR: expected ${expected_count} workspace manifests, found ${actual_count}" >&2
    exit 1
  fi

  local version=""
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
    if [ -z "$version" ]; then
      version="$pkg_version"
    elif [ "$pkg_version" != "$version" ]; then
      echo "ERROR: workspace versions are not synchronized (${pkg} is ${pkg_version}, expected ${version})" >&2
      exit 1
    fi
  done

  echo "Preflight passed: ${expected_count} Schmock workspaces synchronized at ${version}."
}

print_command() {
  printf 'DRY RUN:'
  printf ' %q' "$@"
  printf '\n'
}

run_check() {
  if [ "$MODE" = "--dry-run" ]; then
    print_command "$@"
  else
    "$@"
  fi
}

check_outdated() {
  echo "━━━ Outdated Packages ━━━"
  run_check bun outdated --recursive
  echo ""
}

check_publish() {
  echo "━━━ Package Export Compatibility ━━━"
  run_check bun run check:publish
  echo ""
}

check_audit() {
  echo "━━━ Security Audit ━━━"
  run_check bun audit
  echo ""
}

case "$TARGET" in
  preflight)
    if [ -n "$MODE" ]; then
      echo "ERROR: preflight does not accept a mode" >&2
      exit 1
    fi
    preflight
    ;;
  check|all|outdated|publish|audit)
    if [ "$MODE" != "--dry-run" ] && [ "$MODE" != "--execute" ]; then
      echo "ERROR: ${TARGET} requires --dry-run or --execute" >&2
      exit 1
    fi
    if [ "${3:-}" != "" ]; then
      echo "ERROR: unexpected argument: ${3}" >&2
      exit 1
    fi

    preflight
    require_command bun

    case "$TARGET" in
      check|all)
        check_outdated
        check_publish
        ;;
      outdated) check_outdated ;;
      publish) check_publish ;;
      audit) check_audit ;;
    esac
    ;;
  *)
    echo "ERROR: unknown target: ${TARGET}" >&2
    echo "Usage: check-deps.sh preflight | check|outdated|publish|audit --dry-run|--execute" >&2
    exit 1
    ;;
esac
