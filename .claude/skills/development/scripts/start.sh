#!/usr/bin/env bash
set -euo pipefail

# Create a feature branch from develop.
#
# Usage:
#   bash .claude/skills/development/scripts/start.sh <branch-name>
#
# Example:
#   bash .claude/skills/development/scripts/start.sh add-caching

BRANCH="${1:?Usage: start.sh <branch-name>}"

git fetch origin develop
git checkout develop
git pull origin develop
git checkout -b "feature/${BRANCH}"

echo ""
echo "Created branch: feature/${BRANCH}"
echo "Ready for development."
