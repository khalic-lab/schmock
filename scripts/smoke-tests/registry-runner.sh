#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY_HELPER="$SCRIPT_DIR/registry-fixture.mjs"

if [[ $# -lt 1 ]]; then
  printf 'Usage: %s <smoke|consumer> [--dry-run] [--] [fixture ...]\n' "$0" >&2
  exit 2
fi

SUITE="$1"
shift
case "$SUITE" in
  smoke)
    FIXTURES_DIR="$SCRIPTS_DIR/smoke-tests/fixtures"
    OTHER_FIXTURES_DIR="$SCRIPTS_DIR/integration-tests/fixtures"
    TITLE="Schmock Smoke Tests"
    ;;
  consumer)
    FIXTURES_DIR="$SCRIPTS_DIR/integration-tests/fixtures"
    OTHER_FIXTURES_DIR="$SCRIPTS_DIR/smoke-tests/fixtures"
    TITLE="Schmock Consumer Tests"
    ;;
  *)
    printf 'Unknown registry verification suite: %s\n' "$SUITE" >&2
    exit 2
    ;;
esac

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1" >&2; }
bold() { printf "\033[1m%s\033[0m\n" "$1"; }

DRY_RUN=0
REQUESTED=()
OPTIONS_ENDED=0
while [[ $# -gt 0 ]]; do
  if [[ $OPTIONS_ENDED -eq 1 ]]; then
    if [[ ! "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
      red "Invalid package filter '$1'; use fixture names such as core or react."
      exit 2
    fi
    REQUESTED+=("$1")
    shift
    continue
  fi
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --)
      OPTIONS_ENDED=1
      ;;
    --*)
      red "Unknown option '$1'."
      exit 2
      ;;
    *)
      if [[ ! "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
        red "Invalid package filter '$1'; use fixture names such as core or react."
        exit 2
      fi
      REQUESTED+=("$1")
      ;;
  esac
  shift
done

if ! FIXTURE_LIST="$(
  node "$REGISTRY_HELPER" validate-fixtures "$SUITE" "$FIXTURES_DIR"
)"; then
  exit 1
fi
ALL_FIXTURES=()
read -r -a ALL_FIXTURES <<< "$FIXTURE_LIST"
if [[ ${#ALL_FIXTURES[@]} -eq 0 ]]; then
  red "No $SUITE fixtures were discovered; refusing to report success."
  exit 1
fi

PACKAGES=()
OTHER_SUITE_MATCHES=0
UNKNOWN=()
if [[ ${#REQUESTED[@]} -eq 0 ]]; then
  PACKAGES=("${ALL_FIXTURES[@]}")
else
  for package in "${REQUESTED[@]}"; do
    if [[ -d "$FIXTURES_DIR/$package" ]]; then
      PACKAGES+=("$package")
    elif [[ -d "$OTHER_FIXTURES_DIR/$package" ]]; then
      OTHER_SUITE_MATCHES=$((OTHER_SUITE_MATCHES + 1))
    else
      UNKNOWN+=("$package")
    fi
  done
fi

if [[ ${#UNKNOWN[@]} -gt 0 ]]; then
  if [[ ${#PACKAGES[@]} -eq 0 && $OTHER_SUITE_MATCHES -eq 0 ]]; then
    red "No registry fixture applies to package filter: ${UNKNOWN[*]}; refusing an all-suites no-op."
  else
    red "Unknown package filter with no registry fixture: ${UNKNOWN[*]}"
  fi
  exit 2
fi

if [[ ${#PACKAGES[@]} -eq 0 ]]; then
  bold "=== $TITLE ==="
  printf 'SKIP: no %s fixtures apply to the requested package filter: %s\n' \
    "$SUITE" "${REQUESTED[*]}"
  exit 0
fi

if [[ -z "${SCHMOCK_VERSION:-}" ]]; then
  red "SCHMOCK_VERSION is required and must be an exact released version."
  exit 2
fi
if ! node "$REGISTRY_HELPER" validate-version "$SCHMOCK_VERSION"; then
  exit 2
fi

WORK_DIR="$(mktemp -d)"
PASSED=0
FAILED=0
FAILURES=()

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

run_test() {
  local name="$1"
  local fixture_dir="$FIXTURES_DIR/$name"
  local directory="$WORK_DIR/$name"
  local test_file=""
  mkdir -p "$directory"

  bold "--- @schmock/$name ---"
  if ! cp "$fixture_dir/"* "$directory/"; then
    red "  FAIL: could not copy fixture"
    FAILED=$((FAILED + 1))
    FAILURES+=("$name (copy)")
    return
  fi
  if [[ ! -f "$directory/package.json" ]]; then
    red "  FAIL: fixture has no package.json"
    FAILED=$((FAILED + 1))
    FAILURES+=("$name (manifest)")
    return
  fi

  if ! node "$REGISTRY_HELPER" pin-manifest \
    "$WORK_DIR" "$directory/package.json" "$SCHMOCK_VERSION"; then
    red "  FAIL: could not pin @schmock dependencies"
    FAILED=$((FAILED + 1))
    FAILURES+=("$name (pin dependencies)")
    return
  fi

  if [[ "$SUITE" == "smoke" ]]; then
    for extension in ts tsx; do
      if [[ -f "$directory/smoke.$extension" ]]; then
        test_file="smoke.$extension"
        break
      fi
    done
    if [[ -z "$test_file" ]]; then
      red "  FAIL: fixture has no smoke.ts or smoke.tsx"
      FAILED=$((FAILED + 1))
      FAILURES+=("$name (test file)")
      return
    fi
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  DRY RUN: bun install\n'
    if [[ "$SUITE" == "smoke" ]]; then
      printf '  DRY RUN: bun %s\n' "$test_file"
    else
      printf '  DRY RUN: bun run test\n'
    fi
    green "  DRY RUN PASS"
    PASSED=$((PASSED + 1))
    return
  fi

  if ! (cd "$directory" && bun install); then
    red "  FAIL: bun install failed"
    FAILED=$((FAILED + 1))
    FAILURES+=("$name (install)")
    return
  fi

  if [[ "$SUITE" == "smoke" ]]; then
    if (cd "$directory" && bun "$test_file"); then
      green "  PASS"
      PASSED=$((PASSED + 1))
    else
      red "  FAIL"
      FAILED=$((FAILED + 1))
      FAILURES+=("$name")
    fi
  elif (cd "$directory" && bun run test); then
    green "  PASS"
    PASSED=$((PASSED + 1))
  else
    red "  FAIL"
    FAILED=$((FAILED + 1))
    FAILURES+=("$name")
  fi
}

bold "=== $TITLE ==="
printf 'Released version: %s\n' "$SCHMOCK_VERSION"
printf 'Working dir: %s\n\n' "$WORK_DIR"

for package in "${PACKAGES[@]}"; do
  run_test "$package"
  printf '\n'
done

bold "=== Results ==="
green "Passed: $PASSED"
if [[ $FAILED -gt 0 || $PASSED -eq 0 ]]; then
  red "Failed: $FAILED"
  for failure in "${FAILURES[@]}"; do
    red "  - $failure"
  done
  if [[ $PASSED -eq 0 ]]; then
    red "No $SUITE fixture ran; refusing to report success."
  fi
  exit 1
fi
green "All $SUITE fixtures passed!"
