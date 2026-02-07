#!/usr/bin/env bash
set -uo pipefail

# Full quality validation gate for Schmock.
# Runs lint, typecheck, unit tests, and BDD tests sequentially.
# Reports pass/fail per stage.

PASS=0
FAIL=0
RESULTS=()

run_stage() {
  local name="$1"
  shift
  echo "━━━ ${name} ━━━"
  if "$@" 2>&1; then
    RESULTS+=("✓ ${name}")
    ((PASS++))
  else
    RESULTS+=("✗ ${name}")
    ((FAIL++))
  fi
  echo ""
}

run_stage "Lint"      bun lint:quiet
run_stage "Typecheck" bun typecheck:quiet
run_stage "Unit"      bun test:unit:quiet
run_stage "BDD"       bun test:bdd:quiet

echo "━━━ Results ━━━"
for r in "${RESULTS[@]}"; do
  echo "  ${r}"
done
echo ""
echo "Passed: ${PASS}  Failed: ${FAIL}"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
