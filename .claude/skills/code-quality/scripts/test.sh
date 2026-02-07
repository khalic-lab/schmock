#!/usr/bin/env bash
set -euo pipefail

# Run tests for Schmock packages.
#
# Usage:
#   bash test.sh all        # typecheck + unit + BDD
#   bash test.sh unit       # unit tests only
#   bash test.sh bdd        # BDD tests only
#   bash test.sh <package>  # tests for a specific package (core, schema, express, angular)

TARGET="${1:?Usage: test.sh all|unit|bdd|<package>}"

case "$TARGET" in
  all)
    echo "Running full test suite (typecheck + unit + BDD)..."
    bun test:all:quiet
    ;;
  unit)
    echo "Running unit tests..."
    bun test:unit:quiet
    ;;
  bdd)
    echo "Running BDD tests..."
    bun test:bdd:quiet
    ;;
  core|schema|express|angular)
    echo "Running tests for @schmock/${TARGET}..."
    bun run --filter "@schmock/${TARGET}" test
    ;;
  *)
    echo "Unknown target: ${TARGET}"
    echo "Usage: test.sh all|unit|bdd|<package>"
    echo "Packages: core, schema, express, angular"
    exit 1
    ;;
esac
