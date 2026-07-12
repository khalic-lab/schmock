#!/usr/bin/env bash
set -euo pipefail

# Create feature/<name> directly from origin/develop without switching local develop.

DRY_RUN=0
ROOT=""
BRANCH_NAME=""

usage() {
  echo "Usage: start.sh <name> [--dry-run] [--root <repo>]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --root)
      if [ "$#" -lt 2 ]; then
        usage
        exit 1
      fi
      ROOT="$2"
      shift 2
      ;;
    --*)
      usage
      exit 1
      ;;
    *)
      if [ -n "$BRANCH_NAME" ]; then
        usage
        exit 1
      fi
      BRANCH_NAME="$1"
      shift
      ;;
  esac
done

if [ -z "$BRANCH_NAME" ]; then
  usage
  exit 1
fi

if [ -z "$ROOT" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
else
  ROOT=$(cd "$ROOT" && pwd -P)
fi

BRANCH="feature/${BRANCH_NAME}"
if ! git check-ref-format --branch "$BRANCH" >/dev/null 2>&1; then
  echo "ERROR: invalid branch name: ${BRANCH}" >&2
  exit 1
fi

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "ERROR: refusing to switch branches with a dirty worktree" >&2
  exit 1
fi

if git -C "$ROOT" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "ERROR: local branch already exists: ${BRANCH}" >&2
  exit 1
fi

if git -C "$ROOT" ls-remote --exit-code --heads origin "refs/heads/${BRANCH}" >/dev/null; then
  echo "ERROR: remote branch already exists: origin/${BRANCH}" >&2
  exit 1
else
  REMOTE_QUERY_STATUS=$?
  if [ "$REMOTE_QUERY_STATUS" -ne 2 ]; then
    echo "ERROR: could not query origin for remote branch ${BRANCH} (git ls-remote exited ${REMOTE_QUERY_STATUS})" >&2
    exit 1
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'DRY RUN: git -C %q fetch origin develop\n' "$ROOT"
  printf 'DRY RUN: git -C %q switch -c %q origin/develop\n' "$ROOT" "$BRANCH"
  exit 0
fi

git -C "$ROOT" fetch origin develop
if ! git -C "$ROOT" rev-parse --verify --quiet refs/remotes/origin/develop >/dev/null; then
  echo "ERROR: origin/develop was not available after fetch" >&2
  exit 1
fi
git -C "$ROOT" switch -c "$BRANCH" origin/develop

echo "Created ${BRANCH} from origin/develop."
