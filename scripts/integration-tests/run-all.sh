#!/usr/bin/env bash
set -euo pipefail

# Integration tests for @schmock/* packages.
# Creates isolated temp projects, installs from npm, runs vitest suites.
#
# Usage:
#   ./scripts/integration-tests/run-all.sh            # test all packages
#   ./scripts/integration-tests/run-all.sh react vue   # test specific packages

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR=$(mktemp -d)
PASSED=0
FAILED=0
FAILURES=()

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }
bold()  { printf "\033[1m%s\033[0m\n" "$1"; }

run_test() {
  local name="$1"
  local dir="$WORK_DIR/$name"
  mkdir -p "$dir"

  bold "--- @schmock/$name ---"

  # Copy all fixture files into temp dir
  if [[ ! -d "$SCRIPT_DIR/fixtures/$name" ]]; then
    red "  SKIP: no fixture found for $name"
    return
  fi
  cp "$SCRIPT_DIR/fixtures/$name/"* "$dir/" 2>/dev/null || true

  cd "$dir"

  # Install
  if ! bun install --silent 2>&1; then
    red "  FAIL: bun install failed"
    FAILED=$((FAILED + 1))
    FAILURES+=("$name (install)")
    return
  fi

  # Run vitest via package script (bun run test, NOT bun test which uses Bun's runner)
  if bun run test 2>&1; then
    green "  PASS"
    PASSED=$((PASSED + 1))
  else
    red "  FAIL"
    FAILED=$((FAILED + 1))
    FAILURES+=("$name")
  fi
}

# All testable packages
ALL_PACKAGES=(core react vue express react-app vue-app express-dev-proxy testing-patterns)

# Filter by args or run all
if [[ $# -gt 0 ]]; then
  PACKAGES=("$@")
else
  PACKAGES=("${ALL_PACKAGES[@]}")
fi

bold "=== Schmock Integration Tests ==="
echo "Working dir: $WORK_DIR"
echo ""

for pkg in "${PACKAGES[@]}"; do
  run_test "$pkg"
  echo ""
done

bold "=== Results ==="
green "Passed: $PASSED"
if [[ $FAILED -gt 0 ]]; then
  red "Failed: $FAILED"
  for f in "${FAILURES[@]}"; do
    red "  - $f"
  done
  exit 1
else
  green "All integration tests passed!"
fi
