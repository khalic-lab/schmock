#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

if [[ "$#" -ne 0 ]]; then
  echo "Usage: scripts/check-release-candidate.sh [--dry-run]" >&2
  exit 2
fi

read_manifest_field() {
  node -e '
    const { readFileSync } = require("node:fs");
    const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const value = manifest[process.argv[2]];
    if (typeof value !== "string" || value.length === 0) process.exit(1);
    process.stdout.write(value);
  ' "$1" "$2"
}

read_manifest_dependency() {
  node -e '
    const { readFileSync } = require("node:fs");
    const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const value = manifest[process.argv[2]]?.[process.argv[3]];
    if (typeof value !== "string" || value.length === 0) process.exit(1);
    process.stdout.write(value);
  ' "$1" "$2" "$3"
}

declare -a MANIFESTS=()
while IFS= read -r manifest; do
  MANIFESTS+=("$manifest")
done < <(find "$ROOT_DIR/packages" -mindepth 2 -maxdepth 2 -name package.json -print | LC_ALL=C sort)

TOTAL="${#MANIFESTS[@]}"
if [[ "$TOTAL" -eq 0 ]]; then
  echo "No package manifests found under packages/*/package.json" >&2
  exit 1
fi

declare -a PACKAGE_NAMES=()
declare -a PACKAGE_VERSIONS=()
declare -a PACKAGE_DIRS=()
declare -a EXTRA_CONSUMER_DEPENDENCIES=()

for manifest in "${MANIFESTS[@]}"; do
  package_name="$(read_manifest_field "$manifest" name)"
  package_version="$(read_manifest_field "$manifest" version)"

  for existing_name in "${PACKAGE_NAMES[@]}"; do
    if [[ "$existing_name" == "$package_name" ]]; then
      echo "Duplicate workspace package name: $package_name" >&2
      exit 1
    fi
  done

  PACKAGE_NAMES+=("$package_name")
  PACKAGE_VERSIONS+=("$package_version")
  PACKAGE_DIRS+=("$(dirname "$manifest")")

  if [[ "$package_name" == "@schmock/angular" ]]; then
    compiler_version="$(read_manifest_dependency "$manifest" devDependencies @angular/compiler)"
    EXTRA_CONSUMER_DEPENDENCIES+=("@angular/compiler@$compiler_version")
  fi

  if [[ "$package_name" == "@schmock/react" ]]; then
    testing_library_version="$(read_manifest_dependency "$manifest" devDependencies @testing-library/react)"
    EXTRA_CONSUMER_DEPENDENCIES+=("@testing-library/react@$testing_library_version")
  fi
done

echo "Discovered $TOTAL release-candidate packages"

if [[ "$DRY_RUN" -eq 1 ]]; then
  for ((index = 0; index < TOTAL; index += 1)); do
    step=$((index + 1))
    echo "[pack $step/$TOTAL] ${PACKAGE_NAMES[$index]}@${PACKAGE_VERSIONS[$index]}"
    echo "[publint $step/$TOTAL] ${PACKAGE_NAMES[$index]}"
    echo "[attw $step/$TOTAL] ${PACKAGE_NAMES[$index]}"
  done
  echo "[install 1/1] Install all $TOTAL local tarballs and their opt-in test peers in one isolated consumer"
  echo "[exports 1/1] Import every candidate entry point and exercise the CLI"
  echo "[browser 1/1] Bundle the validation candidate for a browser target"
  exit 0
fi

PUBLINT_BIN="$ROOT_DIR/node_modules/.bin/publint"
ATTW_BIN="$ROOT_DIR/node_modules/.bin/attw"
if [[ ! -x "$PUBLINT_BIN" || ! -x "$ATTW_BIN" ]]; then
  echo "Install repository dependencies before checking release candidates" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/schmock-release-candidate.XXXXXX")"
PACK_DIR="$WORK_DIR/packs"
FIXTURE_DIR="$WORK_DIR/consumer"
mkdir -p "$PACK_DIR" "$FIXTURE_DIR"

cleanup() {
  if [[ "${KEEP_RELEASE_CANDIDATE:-0}" == "1" ]]; then
    echo "Release-candidate workspace retained at $WORK_DIR"
  else
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT

declare -a TARBALLS=()
CANDIDATES_FILE="$FIXTURE_DIR/candidates.tsv"
: > "$CANDIDATES_FILE"

for ((index = 0; index < TOTAL; index += 1)); do
  step=$((index + 1))
  package_name="${PACKAGE_NAMES[$index]}"
  package_version="${PACKAGE_VERSIONS[$index]}"
  package_dir="${PACKAGE_DIRS[$index]}"
  safe_name="${package_name//@/}"
  safe_name="${safe_name//\//-}"
  filename="$safe_name-$package_version.tgz"
  tarball="$PACK_DIR/$filename"

  echo "[pack $step/$TOTAL] $package_name@$package_version"
  (
    cd "$package_dir"
    bun pm pack \
      --destination "$PACK_DIR" \
      --ignore-scripts \
      --quiet
  )

  if [[ ! -s "$tarball" ]]; then
    echo "Packing $package_name did not create $tarball" >&2
    exit 1
  fi

  TARBALLS+=("$tarball")
  printf '%s\t%s\n' "$package_name" "$package_version" >> "$CANDIDATES_FILE"
done

if [[ "${#TARBALLS[@]}" -ne "$TOTAL" ]]; then
  echo "Packed ${#TARBALLS[@]} of $TOTAL discovered packages" >&2
  exit 1
fi

for ((index = 0; index < TOTAL; index += 1)); do
  step=$((index + 1))
  echo "[publint $step/$TOTAL] ${PACKAGE_NAMES[$index]}"
  "$PUBLINT_BIN" "${TARBALLS[$index]}"

  echo "[attw $step/$TOTAL] ${PACKAGE_NAMES[$index]}"
  "$ATTW_BIN" \
    "${TARBALLS[$index]}" \
    --profile esm-only
done

node -e '
  const { writeFileSync } = require("node:fs");
  writeFileSync(
    process.argv[1],
    `${JSON.stringify({ name: "schmock-release-candidate-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
' "$FIXTURE_DIR/package.json"

cp "$ROOT_DIR/scripts/release-candidate-consumer.js" "$FIXTURE_DIR/consumer.mjs"
cp "$ROOT_DIR/scripts/release-candidate-browser.js" "$FIXTURE_DIR/browser-consumer.mjs"

echo "[install 1/1] Installing all $TOTAL local tarballs in an isolated consumer"
(
  cd "$FIXTURE_DIR"
  bun add --exact "${TARBALLS[@]}" "${EXTRA_CONSUMER_DEPENDENCIES[@]}"
)

echo "[exports 1/1] Importing every candidate entry point and exercising the CLI"
(
  cd "$FIXTURE_DIR"
  bun run ./consumer.mjs
)

echo "[browser 1/1] Bundling the validation candidate for a browser target"
(
  cd "$FIXTURE_DIR"
  bun build \
    ./browser-consumer.mjs \
    --target browser \
    --format esm \
    --outdir ./browser-dist
)

node -e '
  const { readdirSync, readFileSync, statSync } = require("node:fs");
  const { join } = require("node:path");
  const pending = [process.argv[1]];
  const failures = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (statSync(current).isDirectory()) {
      for (const entry of readdirSync(current)) pending.push(join(current, entry));
      continue;
    }
    const source = readFileSync(current, "utf8");
    if (source.includes("\"node:") || source.includes("\x27node:") || source.includes("createRequire")) {
      failures.push(current);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Browser bundle contains Node-only imports: ${failures.join(", ")}`);
  }
' "$FIXTURE_DIR/browser-dist"

echo "Release-candidate verification passed for all $TOTAL packages"
