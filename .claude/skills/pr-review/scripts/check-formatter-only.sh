#!/usr/bin/env bash
set -uo pipefail

# Prove that churn in a diff is formatter-only.
#
# A dependency bump that moves the formatter rewraps files wholesale. The diff
# then carries hundreds of changed lines that mean nothing -- and a real
# semantic edit can ride along unnoticed, because "it's just the formatter" is
# indistinguishable from "it's mostly the formatter" by eye.
#
# This settles it mechanically: re-run the CURRENT formatter over the OLD
# content of each changed file and compare against what was actually committed.
# Byte-identical means reflow and nothing else. Anything else is a file a human
# has to read.
#
# Usage: check-formatter-only.sh <base-ref> <head-ref> [pathspec...]
#
# Env:   FORMATTER_CMD  format-to-stdout command; the file path is appended as
#                       --stdin-file-path=<path> and content arrives on stdin.
#                       Default: "bunx biome format"
#
# Exit:  0  every changed file is formatter-only
#        1  at least one file carries a semantic change, or could not be checked
#        2  usage error

usage() {
  echo "Usage: check-formatter-only.sh <base-ref> <head-ref> [pathspec...]" >&2
  echo "Example: check-formatter-only.sh HEAD~1 HEAD '*.ts'" >&2
}

BASE="${1:-}"
HEAD_REF="${2:-}"

if [ -z "$BASE" ] || [ -z "$HEAD_REF" ]; then
  usage
  exit 2
fi
shift 2

if [ "$#" -gt 0 ]; then
  PATHSPEC=("$@")
else
  PATHSPEC=('*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs')
fi

FORMATTER_CMD="${FORMATTER_CMD:-bunx biome format}"

for ref in "$BASE" "$HEAD_REF"; do
  if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    echo "Not a commit: ${ref}" >&2
    exit 2
  fi
done

TMPDIR_RUN="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_RUN"' EXIT
OLD="$TMPDIR_RUN/old"
NEW="$TMPDIR_RUN/new"
FMT="$TMPDIR_RUN/fmt"

FORMATTED=()
SEMANTIC=()
ADDED=()
REMOVED=()
UNCHECKED=()

while IFS= read -r f; do
  [ -n "$f" ] || continue

  if ! git show "$BASE:$f" > "$OLD" 2>/dev/null; then
    ADDED+=("$f")
    continue
  fi
  if ! git show "$HEAD_REF:$f" > "$NEW" 2>/dev/null; then
    REMOVED+=("$f")
    continue
  fi

  if ! $FORMATTER_CMD --stdin-file-path="$f" < "$OLD" > "$FMT" 2>/dev/null || [ ! -s "$FMT" ]; then
    UNCHECKED+=("$f")
    continue
  fi

  if cmp -s "$FMT" "$NEW"; then
    FORMATTED+=("$f")
  else
    SEMANTIC+=("$f")
  fi
done < <(git diff --name-only "$BASE" "$HEAD_REF" -- "${PATHSPEC[@]}")

report() {
  local label="$1"
  shift
  [ "$#" -gt 0 ] || return 0
  echo "${label} (${#})"
  for f in "$@"; do
    echo "  ${f}"
  done
  echo ""
}

echo "━━━ Formatter-only check: ${BASE}..${HEAD_REF} ━━━"
echo ""

[ "${#FORMATTED[@]}" -gt 0 ] && report "✓ formatter-only" "${FORMATTED[@]}"
[ "${#SEMANTIC[@]}" -gt 0 ] && report "✗ semantic change — read these" "${SEMANTIC[@]}"
[ "${#ADDED[@]}" -gt 0 ] && report "+ added (no base content to compare)" "${ADDED[@]}"
[ "${#REMOVED[@]}" -gt 0 ] && report "- removed" "${REMOVED[@]}"
[ "${#UNCHECKED[@]}" -gt 0 ] && report "? formatter could not parse — read these" "${UNCHECKED[@]}"

NEEDS_REVIEW=$(( ${#SEMANTIC[@]} + ${#UNCHECKED[@]} ))

echo "━━━ Summary ━━━"
echo "  formatter-only: ${#FORMATTED[@]}"
echo "  needs review:   ${NEEDS_REVIEW}"

if [ "$NEEDS_REVIEW" -gt 0 ]; then
  echo ""
  echo "Re-formatting the old content did not reproduce what was committed."
  echo "Those files carry an edit the formatter did not make."
  exit 1
fi

echo ""
echo "All changed files reproduce exactly from the old content — reflow only."
