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

/** Packages that run on Node and therefore declare a Node floor. */
const NODE_ENGINE_PACKAGES = new Set(["@schmock/cli"]);

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
  if (
    !Array.isArray(files) ||
    files.length !== EXPECTED_FILES.length ||
    files.some((entry, index) => entry !== EXPECTED_FILES[index])
  ) {
    fail(
      scope,
      `files must be ${JSON.stringify(EXPECTED_FILES)}, found ${JSON.stringify(files)}`,
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

  if (NODE_ENGINE_PACKAGES.has(scope)) {
    if (typeof manifest.engines?.node !== "string") {
      fail(scope, "missing engines.node");
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
