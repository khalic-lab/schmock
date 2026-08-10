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

  if [[ "$package_name" == "@schmock/core" ]]; then
    node_types_version="$(read_manifest_dependency "$manifest" devDependencies @types/node)"
    EXTRA_CONSUMER_DEPENDENCIES+=("@types/node@$node_types_version")
  fi

  if [[ "$package_name" == "@schmock/express" ]]; then
    for dependency in express @types/express; do
      dependency_version="$(
        read_manifest_dependency "$manifest" devDependencies "$dependency"
      )"
      EXTRA_CONSUMER_DEPENDENCIES+=("$dependency@$dependency_version")
    done
  fi

  if [[ "$package_name" == "@schmock/react" ]]; then
    for dependency in @testing-library/react @types/react jsdom react react-dom; do
      dependency_version="$(
        read_manifest_dependency "$manifest" devDependencies "$dependency"
      )"
      EXTRA_CONSUMER_DEPENDENCIES+=("$dependency@$dependency_version")
    done
    EXTRA_CONSUMER_DEPENDENCIES+=("@types/react-dom@^19.0.0")
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
  echo "[ranges 1/1] Validate internal dependency ranges"
  echo "[install 1/1] Install all $TOTAL local tarballs and their opt-in test peers in one isolated consumer"
  echo "[exports-node 1/1] Import every candidate entry point with Node and exercise the CLI"
  echo "[exports-bun 1/1] Import every candidate entry point with Bun and exercise the CLI"
  echo "[types 1/1] Compile every declaration-bearing entry in isolation"
  echo "[types-ts56 1/1] Compile the Core declaration entry with TypeScript 5.6"
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
  packed_manifest="$PACK_DIR/$safe_name-$package_version.package.json"

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

  tar -xOf "$tarball" package/package.json > "$packed_manifest"
  if [[ ! -s "$packed_manifest" ]]; then
    echo "Packing $package_name did not include package/package.json" >&2
    exit 1
  fi

  # A tarball ships build output and package metadata, nothing else. This is
  # an allowlist rather than a denylist on purpose: sources, tests, BDD steps,
  # spec fixtures and test-only helpers must stay out whatever they are named,
  # so a newly emitted or renamed test artefact cannot slip past.
  declare -a FORBIDDEN_ENTRIES=()
  while IFS= read -r entry; do
    [[ -n "$entry" ]] && FORBIDDEN_ENTRIES+=("$entry")
  done < <(
    tar -tf "$tarball" \
      | grep -vE '^package/(package\.json|README\.md|LICENSE|dist/)' \
      || true
  )

  if [[ "${#FORBIDDEN_ENTRIES[@]}" -gt 0 ]]; then
    echo "Packing $package_name included non-distributable files:" >&2
    for entry in "${FORBIDDEN_ENTRIES[@]}"; do
      echo "  - $entry" >&2
    done
    exit 1
  fi

  TARBALLS+=("$tarball")
  printf '%s\t%s\t%s\n' \
    "$package_name" \
    "$package_version" \
    "$packed_manifest" >> "$CANDIDATES_FILE"
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

echo "[ranges 1/1] Validating internal dependency ranges"
bun -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const [manifestPath, candidatesPath, packDir, ...extraSpecs] = process.argv.slice(1);
  const candidates = new Map();
  const dependencies = {};
  const overrides = {};

  for (const line of readFileSync(candidatesPath, "utf8").trim().split("\n")) {
    if (!line) continue;
    const [name, version, packedManifestPath] = line.split("\t");
    const safeName = name.replace("@", "").replace("/", "-");
    const tarball = `file:${join(packDir, `${safeName}-${version}.tgz`)}`;
    candidates.set(name, { version, packedManifestPath });
    dependencies[name] = tarball;
    overrides[name] = tarball;
  }

  const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];
  for (const [packageName, candidate] of candidates) {
    const manifest = JSON.parse(readFileSync(candidate.packedManifestPath, "utf8"));
    for (const field of dependencyFields) {
      for (const [dependencyName, range] of Object.entries(manifest[field] ?? {})) {
        const dependency = candidates.get(dependencyName);
        if (!dependency) continue;
        if (typeof range !== "string" || !Bun.semver.satisfies(dependency.version, range)) {
          throw new Error(
            `${packageName} declares ${field}.${dependencyName} as ${JSON.stringify(range)}, ` +
              `which does not accept release candidate ${dependency.version}`,
          );
        }
      }
    }
  }

  for (const spec of extraSpecs) {
    const separator = spec.lastIndexOf("@");
    if (separator <= 0) throw new Error(`Invalid consumer dependency: ${spec}`);
    dependencies[spec.slice(0, separator)] = spec.slice(separator + 1);
  }

  const manifest = {
    name: "schmock-release-candidate-consumer",
    private: true,
    type: "module",
    dependencies,
    overrides,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
' \
  "$FIXTURE_DIR/package.json" \
  "$CANDIDATES_FILE" \
  "$PACK_DIR" \
  "${EXTRA_CONSUMER_DEPENDENCIES[@]}"

cp "$ROOT_DIR/scripts/release-candidate-consumer.js" "$FIXTURE_DIR/consumer.mjs"
cp "$ROOT_DIR/scripts/release-candidate-types.js" "$FIXTURE_DIR/types-consumer.mjs"
cp "$ROOT_DIR/scripts/release-candidate-browser.js" "$FIXTURE_DIR/browser-consumer.mjs"

echo "[install 1/1] Installing all $TOTAL local tarballs in an isolated consumer"
(
  cd "$FIXTURE_DIR"
  bun install --linker isolated
)

echo "[exports-node 1/1] Importing every candidate entry point with Node and exercising the CLI"
(
  cd "$FIXTURE_DIR"
  node ./consumer.mjs
)

echo "[exports-bun 1/1] Importing every candidate entry point with Bun and exercising the CLI"
(
  cd "$FIXTURE_DIR"
  bun run ./consumer.mjs
)

echo "[types 1/1] Compiling every declaration-bearing entry in isolation"
(
  cd "$FIXTURE_DIR"
  TSC_BIN="$ROOT_DIR/node_modules/.bin/tsc" node ./types-consumer.mjs
)

echo "[types-ts56 1/1] Compiling the Core declaration entry with TypeScript 5.6"
(
  cd "$FIXTURE_DIR"
  node "$ROOT_DIR/scripts/check-typescript-5-6.mjs"
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
