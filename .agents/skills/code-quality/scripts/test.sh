#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DRY_RUN=0
TARGET=""

usage() {
  echo "Usage: test.sh [--dry-run] all|unit|bdd|<package>" >&2
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

ROOT=$(bun "$SCRIPT_DIR/workspaces.ts" root)

run_command() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf "DRY RUN:"
    printf " %q" "$@"
    printf "\n"
    return 0
  fi

  (cd "$ROOT" && "$@")
}

case "$TARGET" in
  all)
    echo "Running repository tests (typecheck + unit + BDD + integration)..."
    run_command bun run test:all
    ;;
  unit)
    echo "Running all unit tests..."
    run_command bun run test:unit
    ;;
  bdd)
    echo "Running all BDD tests..."
    run_command bun run test:bdd
    ;;
  *)
    WORKSPACE=$(bun "$SCRIPT_DIR/workspaces.ts" resolve "$TARGET" --script test)
    IFS=$'\t' read -r SHORT_NAME PACKAGE_DIR FULL_NAME <<< "$WORKSPACE"
    echo "Running tests for ${FULL_NAME}..."
    if [ "$DRY_RUN" -eq 1 ]; then
      printf "DRY RUN: cd %q &&" "$PACKAGE_DIR"
      printf " %q" bun run test
      printf "\n"
    else
      (cd "$PACKAGE_DIR" && bun run test)
    fi
    ;;
esac
