#!/usr/bin/env bash
set -euo pipefail

# Smoke tests for all @schmock/* packages.
# Creates isolated temp projects, installs from npm, verifies APIs work.
#
# Usage:
#   ./scripts/smoke-tests/run-all.sh           # test all packages
#   ./scripts/smoke-tests/run-all.sh react vue  # test specific packages

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

  # Copy test files into temp dir
  if [[ -f "$SCRIPT_DIR/fixtures/$name/package.json" ]]; then
    cp "$SCRIPT_DIR/fixtures/$name/package.json" "$dir/"
  fi

  # Find the test file (supports .ts and .tsx)
  local test_file=""
  for ext in ts tsx; do
    if [[ -f "$SCRIPT_DIR/fixtures/$name/smoke.${ext}" ]]; then
      test_file="smoke.${ext}"
      cp "$SCRIPT_DIR/fixtures/$name/$test_file" "$dir/"
      break
    fi
  done

  if [[ -z "$test_file" ]]; then
    red "  SKIP: no test fixture found for $name"
    return
  fi

  # Copy any extra files (e.g., spec.yaml for openapi)
  for f in "$SCRIPT_DIR/fixtures/$name/"*; do
    local basename=$(basename "$f")
    if [[ "$basename" != "package.json" && "$basename" != smoke.* ]]; then
      cp "$f" "$dir/"
    fi
  done

  cd "$dir"

  # Install
  if ! bun install --silent 2>&1; then
    red "  FAIL: bun install failed"
    FAILED=$((FAILED + 1))
    FAILURES+=("$name (install)")
    return
  fi

  # Run test
  if bun "$test_file" 2>&1; then
    green "  PASS"
    PASSED=$((PASSED + 1))
  else
    red "  FAIL"
    FAILED=$((FAILED + 1))
    FAILURES+=("$name")
  fi
}

# All testable packages
ALL_PACKAGES=(core faker express react vue openapi cli schmock)

# Filter by args or run all
if [[ $# -gt 0 ]]; then
  PACKAGES=("$@")
else
  PACKAGES=("${ALL_PACKAGES[@]}")
fi

bold "=== Schmock Smoke Tests ==="
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
  green "All smoke tests passed!"
fi
