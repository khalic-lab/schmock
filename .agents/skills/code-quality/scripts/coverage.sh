#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DRY_RUN=0
TARGET=""

usage() {
  echo "Usage: coverage.sh [--dry-run] <package>" >&2
}

for argument in "$@"; do
  case "$argument" in
    --dry-run)
      DRY_RUN=1
      ;;
    *)
      if [ -n "$TARGET" ]; then
        usage
        exit 1
      fi
      TARGET="$argument"
      ;;
  esac
done

if [ -z "$TARGET" ]; then
  usage
  exit 1
fi

WORKSPACE=$(bun "$SCRIPT_DIR/workspaces.ts" resolve "$TARGET" --script test)
IFS=$'\t' read -r SHORT_NAME PACKAGE_DIR FULL_NAME <<< "$WORKSPACE"
ROOT=$(bun "$SCRIPT_DIR/workspaces.ts" root)
VITEST="$ROOT/node_modules/.bin/vitest"

if [ ! -x "$VITEST" ]; then
  echo "ERROR: repository-installed Vitest is missing or not executable: ${VITEST}" >&2
  exit 1
fi

PRETEST_WORKSPACES=$(bun "$SCRIPT_DIR/workspaces.ts" list --script pretest)
HAS_PRETEST=0
while IFS= read -r WORKSPACE_NAME; do
  if [ "$WORKSPACE_NAME" = "$SHORT_NAME" ]; then
    HAS_PRETEST=1
    break
  fi
done <<< "$PRETEST_WORKSPACES"

echo "Generating coverage for ${FULL_NAME}..."
COMMAND=(
  "$VITEST" run
  --coverage
  "--coverage.include=src/**/*.ts"
  "--coverage.include=src/**/*.tsx"
  "--coverage.exclude=src/**/*.test.ts"
  "--coverage.exclude=src/**/*.test.tsx"
  "--coverage.exclude=src/**/*.steps.ts"
  "--coverage.exclude=src/**/*.steps.tsx"
  "--coverage.exclude=src/steps/**"
)

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$HAS_PRETEST" -eq 1 ]; then
    printf "DRY RUN: cd %q &&" "$PACKAGE_DIR"
    printf " %q" bun run pretest
    printf "\n"
  fi
  printf "DRY RUN: cd %q &&" "$PACKAGE_DIR"
  printf " %q" "${COMMAND[@]}"
  printf "\n"
else
  if [ "$HAS_PRETEST" -eq 1 ]; then
    echo "Running pretest lifecycle for ${FULL_NAME}..."
    (cd "$PACKAGE_DIR" && bun run pretest)
  fi
  (cd "$PACKAGE_DIR" && "${COMMAND[@]}")
fi
