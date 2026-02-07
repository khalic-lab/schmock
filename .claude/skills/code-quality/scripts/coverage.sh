#!/usr/bin/env bash
set -euo pipefail

# Generate per-package coverage report.
#
# Usage:
#   bash coverage.sh <package>
#
# Example:
#   bash coverage.sh core
#   bash coverage.sh schema

PKG="${1:?Usage: coverage.sh <package>}"
VALID_PACKAGES="core schema express angular validation query"

if ! echo "$VALID_PACKAGES" | grep -qw "$PKG"; then
  echo "Invalid package: ${PKG}"
  echo "Valid packages: ${VALID_PACKAGES}"
  exit 1
fi

PKG_DIR="packages/${PKG}"

if [ ! -d "$PKG_DIR" ]; then
  echo "Package directory not found: ${PKG_DIR}"
  exit 1
fi

echo "Generating coverage for @schmock/${PKG}..."
cd "$PKG_DIR"

bunx vitest run \
  --coverage \
  --coverage.include='src/**/*.ts' \
  --coverage.exclude='src/**/*.test.ts' \
  --coverage.exclude='src/**/*.steps.ts' \
  --coverage.exclude='src/steps/**'
