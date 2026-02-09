#!/usr/bin/env bash
set -euo pipefail

# Publish Schmock packages to npm and create GitHub releases.
#
# Usage:
#   bash publish.sh            # Publish all packages
#   bash publish.sh <package>  # Publish a single package (core, faker, express, angular, query, validation, openapi, cli)

TARGET="${1:-all}"
VALID_PACKAGES="core faker express angular query validation openapi cli"

publish_package() {
  local pkg="$1"
  local pkg_dir="packages/${pkg}"
  local pkg_json="${pkg_dir}/package.json"

  if [ ! -f "$pkg_json" ]; then
    echo "ERROR: ${pkg_json} not found"
    return 1
  fi

  local name
  name=$(grep '"name"' "$pkg_json" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
  local version
  version=$(grep '"version"' "$pkg_json" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')

  echo "Publishing ${name}@${version}..."
  cd "$pkg_dir"
  npm publish --access public
  cd - > /dev/null

  echo "Creating GitHub release for ${name}@${version}..."
  gh release create "${pkg}-v${version}" \
    --title "${name}@${version}" \
    --notes "Release ${name}@${version}" \
    --latest=false

  echo "Published ${name}@${version}"
  echo ""
}

# Validate first
echo "Running validation..."
bun lint:quiet
bun test:all:quiet

echo ""
echo "Building..."
bun run build

echo ""
echo "Publishing..."

if [ "$TARGET" = "all" ]; then
  for pkg in $VALID_PACKAGES; do
    publish_package "$pkg"
  done
elif echo "$VALID_PACKAGES" | grep -qw "$TARGET"; then
  publish_package "$TARGET"
else
  echo "Unknown package: ${TARGET}"
  echo "Valid packages: ${VALID_PACKAGES}"
  exit 1
fi

echo "Done."
