#!/usr/bin/env bash
set -uo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi
if [ "$#" -ne 0 ]; then
  echo "Usage: validate.sh [--dry-run]" >&2
  exit 1
fi

if [ -n "${SCHMOCK_REPO_ROOT:-}" ]; then
  ROOT="$SCHMOCK_REPO_ROOT"
else
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
fi

if [ ! -f "$ROOT/package.json" ]; then
  echo "Repository package.json not found under $ROOT" >&2
  exit 1
fi

PASS=0
FAIL=0
PLANNED=0
RESULTS=()
FIXES=()

run_stage() {
  local name="$1"
  local fix_hint="$2"
  shift 2
  echo "━━━ ${name} ━━━"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf "DRY RUN:"
    printf " %q" "$@"
    printf "\n"
    RESULTS+=("○ ${name} (planned)")
    PLANNED=$((PLANNED + 1))
  elif (cd "$ROOT" && "$@") 2>&1; then
    RESULTS+=("✓ ${name}")
    PASS=$((PASS + 1))
  else
    RESULTS+=("✗ ${name}")
    FIXES+=("  ${name}: ${fix_hint}")
    FAIL=$((FAIL + 1))
  fi
  echo ""
}

run_stage "Lint" "Run 'bun run lint:fix', then inspect remaining Biome errors" \
  bun run lint
run_stage "Typecheck" "Run 'bun run typecheck' for complete diagnostics" \
  bun run typecheck
run_stage "Knip" "Run 'bun run knip' and resolve unintended dead code or dependencies" \
  bun run knip
run_stage "ESLint" "Run 'bun run eslint' and replace unsafe assertions with narrowing" \
  bun run eslint
run_stage "Unit" "Run 'bun run test:unit' for complete failing assertions" \
  bun run test:unit
run_stage "BDD" "Run 'bun run test:bdd' and compare steps with feature scenarios" \
  bun run test:bdd
run_stage "Integration" "Run 'bun run test:integration' for complete diagnostics" \
  bun run test:integration
run_stage "Build" "Run 'bun run build' for complete build diagnostics" \
  bun run build
run_stage "Bench" "Run 'bun run bench' and inspect throughput regressions" \
  bun run bench

echo "━━━ Results ━━━"
for result in "${RESULTS[@]}"; do
  echo "  ${result}"
done
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Planned: ${PLANNED}. No quality gate was executed."
  exit 0
fi

if [ "$FAIL" -gt 0 ]; then
  echo "━━━ How to fix ━━━"
  for fix in "${FIXES[@]}"; do
    echo "${fix}"
  done
  echo ""
  echo "Passed: ${PASS}  Failed: ${FAIL}"
  exit 1
fi

echo "Passed: ${PASS}  Failed: ${FAIL}"
echo "All gates passed — ready to commit."
