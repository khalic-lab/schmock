#!/usr/bin/env bash
set -euo pipefail

# Installs exact released packages into copied consumer fixtures.
# SCHMOCK_VERSION is required whenever at least one fixture applies.
#
# Usage:
#   SCHMOCK_VERSION=2.3.0 ./scripts/integration-tests/run-all.sh
#   SCHMOCK_VERSION=2.3.0 ./scripts/integration-tests/run-all.sh --dry-run -- react vue

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/../smoke-tests/registry-runner.sh" consumer "$@"
