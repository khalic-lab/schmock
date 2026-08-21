#!/usr/bin/env node

/**
 * Publish-shape guard for the workspace manifests.
 *
 * Packaging defects are invisible to the unit and BDD suites because nothing
 * in `packages/<name>/src` reads `package.json`. This script pins the
 * invariants that only show up in a published tarball:
 *
 *   - every package ships `files: ["dist"]` (no `src`, no tests, no fixtures)
 *   - every package carries a LICENSE copy identical to the root one, so the
 *     `license: "MIT"` declaration ships with the terms it names
 *   - every package carries the metadata npm surfaces on the package page
 *   - the aggregate test scripts stay in sync, differing only in verbosity
 *   - no script references another script that does not exist
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_URL = "git+https://github.com/khalic-lab/schmock.git";
const HOMEPAGE_ROOT = "https://github.com/khalic-lab/schmock";
const BUGS_URL = "https://github.com/khalic-lab/schmock/issues";
const EXPECTED_FILES = ["dist"];

/**
 * Packages allowed to ship something besides `dist`, and what.
 *
 * `@schmock/openapi/browser` is an explicit way to reach the browser build for
 * a bundler that ignores export conditions. TypeScript's legacy
 * `moduleResolution: "node"` predates `exports` and resolves a subpath by
 * looking for a directory, so the subpath needs a real `browser/` directory to
 * point at or `attw` reports it unresolvable. Nothing imports it at runtime.
 */
const EXTRA_FILES = new Map([["@schmock/openapi", ["browser"]]]);

/** Node-only packages and their effective transitive runtime floors. */
const NODE_ENGINES = new Map([
  ["@schmock/cli", "^20.19.0 || ^22.13.0 || ^23.5.0 || >=24.0.0"],
  ["@schmock/schmock", "^20.19.0 || ^22.13.0 || ^23.5.0 || >=24.0.0"],
]);

const failures = [];

function fail(scope, message) {
  failures.push(`${scope}: ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function checkRootLicense() {
  if (!existsSync(join(ROOT_DIR, "LICENSE"))) {
    fail("repository", "no LICENSE file at the repository root");
  }
}

/** Root license text, or `undefined` when absent (already reported above). */
function readRootLicense() {
  const path = join(ROOT_DIR, "LICENSE");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function checkPackage(directory) {
  const manifestPath = join(ROOT_DIR, "packages", directory, "package.json");
  if (!existsSync(manifestPath)) return false;

  const manifest = readJson(manifestPath);
  const scope = manifest.name ?? `packages/${directory}`;

  // A package without a README publishes a blank page on the registry. The
  // README needs no `files` entry: `bun pm pack` includes it regardless (see
  // the packed contents asserted in scripts/check-release-candidate.sh).
  if (!existsSync(join(ROOT_DIR, "packages", directory, "README.md"))) {
    fail(scope, "missing README.md");
  }

  // Every manifest declares `license: "MIT"`, but an SPDX identifier is not the
  // license text: MIT requires the terms to travel with the redistribution.
  // npm and bun always include a package-root LICENSE — like README.md, it
  // needs no `files` entry — so the only way a tarball ships the terms is a
  // per-package copy. The root LICENSE never reaches a tarball: packing only
  // looks inside the package directory. Byte-identity is asserted so the 11
  // copies cannot drift away from the root one.
  const licensePath = join(ROOT_DIR, "packages", directory, "LICENSE");
  const rootLicense = readRootLicense();
  if (!existsSync(licensePath)) {
    fail(scope, "missing LICENSE (the tarball would ship no license text)");
  } else if (
    rootLicense !== undefined &&
    readFileSync(licensePath, "utf8") !== rootLicense
  ) {
    fail(scope, "LICENSE is not byte-identical to the repository root LICENSE");
  }

  const files = manifest.files;
  const expectedFiles = [
    ...EXPECTED_FILES,
    ...(EXTRA_FILES.get(manifest.name) ?? []),
  ];
  if (
    !Array.isArray(files) ||
    files.length !== expectedFiles.length ||
    files.some((entry, index) => entry !== expectedFiles[index])
  ) {
    fail(
      scope,
      `files must be ${JSON.stringify(expectedFiles)}, found ${JSON.stringify(files)}`,
    );
  }

  if (typeof manifest.license !== "string" || manifest.license.length === 0) {
    fail(scope, "missing license");
  }

  const repository = manifest.repository;
  if (!repository || typeof repository !== "object") {
    fail(scope, "missing repository");
  } else {
    if (repository.url !== REPOSITORY_URL) {
      fail(scope, `repository.url must be ${REPOSITORY_URL}`);
    }
    if (repository.directory !== `packages/${directory}`) {
      fail(scope, `repository.directory must be packages/${directory}`);
    }
  }

  if (
    typeof manifest.homepage !== "string" ||
    !manifest.homepage.startsWith(HOMEPAGE_ROOT)
  ) {
    fail(scope, `homepage must start with ${HOMEPAGE_ROOT}`);
  }

  if (!manifest.bugs || manifest.bugs.url !== BUGS_URL) {
    fail(scope, `bugs.url must be ${BUGS_URL}`);
  }

  const expectedNodeEngine = NODE_ENGINES.get(scope);
  if (expectedNodeEngine !== undefined) {
    if (manifest.engines?.node !== expectedNodeEngine) {
      fail(scope, `engines.node must be ${expectedNodeEngine}`);
    }
  } else if (manifest.engines?.node !== undefined) {
    fail(scope, "engines.node is only declared on Node-only packages");
  }

  return true;
}

/**
 * Extract the `bun run <script>` targets a script chains together.
 *
 * Only bare script names count: the lookahead skips `bun run --filter ...`
 * fan-outs and `bun run benchmarks/foo.ts` file invocations, neither of which
 * names a sibling script.
 */
function aggregateTargets(command) {
  return [
    ...command.matchAll(/bun run ([a-zA-Z][\w:-]*)(?=\s*(?:&&|\||;|>|$))/g),
  ].map((match) => match[1]);
}

function baseName(script) {
  return script.replace(/:(quiet|silent)$/, "");
}

function checkRootScripts() {
  const manifest = readJson(join(ROOT_DIR, "package.json"));
  const scripts = manifest.scripts ?? {};

  for (const [name, command] of Object.entries(scripts)) {
    for (const target of aggregateTargets(command)) {
      if (!(target in scripts)) {
        fail("scripts", `${name} references missing script ${target}`);
      }
    }
  }

  const aggregates = Object.keys(scripts).filter(
    (name) => name === "test:all" || name.startsWith("test:all:"),
  );
  const reference = aggregateTargets(scripts["test:all"] ?? "").map(baseName);
  for (const aggregate of aggregates) {
    const actual = aggregateTargets(scripts[aggregate]).map(baseName);
    if (actual.join(",") !== reference.join(",")) {
      fail(
        "scripts",
        `${aggregate} runs [${actual.join(", ")}] but test:all runs [${reference.join(", ")}] — ` +
          "aggregate variants must differ only in output verbosity",
      );
    }
  }
}

checkRootLicense();
checkRootScripts();

const packageDirectories = readdirSync(join(ROOT_DIR, "packages"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let checked = 0;
for (const directory of packageDirectories) {
  if (checkPackage(directory)) checked += 1;
}

if (checked === 0) {
  fail(
    "repository",
    "no workspace manifests found under packages/*/package.json",
  );
}

if (failures.length > 0) {
  console.error("Manifest check failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Manifest check passed for ${checked} packages`);
