#!/usr/bin/env bash
set -uo pipefail

# Check dependencies: outdated packages + publish compatibility.
#
# Usage:
#   bash check-deps.sh           # Full check
#   bash check-deps.sh outdated  # Only outdated packages
#   bash check-deps.sh publish   # Only publish compatibility
#   bash check-deps.sh audit     # Security audit

TARGET="${1:-all}"

check_outdated() {
  echo "━━━ Outdated Packages ━━━"
  bun outdated 2>&1 || true
  echo ""
}

check_publish() {
  echo "━━━ Package Export Compatibility ━━━"
  bun check:publish 2>&1 || true
  echo ""
}

check_audit() {
  echo "━━━ Security Audit ━━━"
  npm audit 2>&1 || true
  echo ""
}

case "$TARGET" in
  all)
    check_outdated
    check_publish
    ;;
  outdated)
    check_outdated
    ;;
  publish)
    check_publish
    ;;
  audit)
    check_audit
    ;;
  *)
    echo "Unknown target: ${TARGET}"
    echo "Usage: check-deps.sh [all|outdated|publish|audit]"
    exit 1
    ;;
esac
