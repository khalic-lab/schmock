#!/usr/bin/env bash
set -uo pipefail

# Full quality validation gate for Schmock.
# Runs all 6 stages sequentially and reports pass/fail with fix hints.

PASS=0
FAIL=0
RESULTS=()
FIXES=()

run_stage() {
  local name="$1"
  local fix_hint="$2"
  shift 2
  echo "━━━ ${name} ━━━"
  if "$@" 2>&1; then
    RESULTS+=("✓ ${name}")
    ((PASS++))
  else
    RESULTS+=("✗ ${name}")
    FIXES+=("  ${name}: ${fix_hint}")
    ((FAIL++))
  fi
  echo ""
}

run_stage "Lint"      "Run 'bun lint:fix' to auto-fix, then review remaining issues in biome output" \
  bun lint:quiet

run_stage "Typecheck" "Run 'bun typecheck' for full error output, fix type errors in reported files" \
  bun typecheck:quiet

run_stage "Knip"      "Run 'bun knip' to see dead exports/unused deps, remove or re-export them" \
  bun knip:quiet

run_stage "ESLint"    "Run 'bun eslint' to see 'as' casts, replace with type guards/runtime validators" \
  bun eslint:quiet

run_stage "Unit"      "Run 'bun test:unit' for full output, fix failing assertions" \
  bun test:unit:quiet

run_stage "BDD"       "Run 'bun test:bdd' for full output, check step text matches .feature files" \
  bun test:bdd:quiet

echo "━━━ Results ━━━"
for r in "${RESULTS[@]}"; do
  echo "  ${r}"
done
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "━━━ How to fix ━━━"
  for f in "${FIXES[@]}"; do
    echo "${f}"
  done
  echo ""
  echo "Passed: ${PASS}  Failed: ${FAIL}"
  exit 1
else
  echo "Passed: ${PASS}  Failed: ${FAIL}"
  echo "All gates passed — ready to commit."
fi
