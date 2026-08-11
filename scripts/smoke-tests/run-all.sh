#!/usr/bin/env bash
set -euo pipefail

# Installs exact released packages into copied fixtures. SCHMOCK_VERSION is
# required whenever at least one smoke fixture applies.
#
# Usage:
#   SCHMOCK_VERSION=2.3.0 ./scripts/smoke-tests/run-all.sh
#   SCHMOCK_VERSION=2.3.0 ./scripts/smoke-tests/run-all.sh --dry-run -- react vue

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/registry-runner.sh" smoke "$@"
