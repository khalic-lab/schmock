#!/usr/bin/env node

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const PRERELEASE_IDENTIFIER = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const EXACT_SEMVER = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}` +
    `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?` +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
);
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const CONSUMER_FIXTURES = [
  "core",
  "react",
  "vue",
  "express",
  "express-dev-proxy",
  "testing-patterns",
];
const SMOKE_SUPPLEMENTAL_FIXTURES = ["express-single-install"];
const REAL_ROOT_DIR = realpathSync(ROOT_DIR);

function exactVersion(value) {
  if (typeof value !== "string" || !EXACT_SEMVER.test(value)) {
    throw new Error(`"${value ?? ""}" is not a valid exact semantic version`);
  }
  return value;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(parent, target) {
  const path = relative(parent, target);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function workspacePackageNames() {
  const packagesDirectory = resolve(ROOT_DIR, "packages");
  const names = [];
  for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDirectory, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      typeof manifest.name !== "string" ||
      !/^@schmock\/[a-z0-9][a-z0-9-]*$/.test(manifest.name)
    ) {
      throw new Error(
        `${manifestPath} must name an @schmock/<fixture> workspace`,
      );
    }
    names.push(manifest.name);
  }
  if (names.length === 0) {
    throw new Error("no @schmock/* workspace manifests were discovered");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("duplicate @schmock/* workspace names were discovered");
  }
  return names.sort();
}

function expectedFixtureNames(suite) {
  if (suite === "smoke") {
    return [
      ...workspacePackageNames().map((name) => name.slice("@schmock/".length)),
      ...SMOKE_SUPPLEMENTAL_FIXTURES,
    ];
  }
  if (suite === "consumer") return [...CONSUMER_FIXTURES];
  throw new Error(`unknown fixture suite "${suite ?? ""}"`);
}

function validateFixtures(suite, fixturesArgument) {
  if (!fixturesArgument) {
    throw new Error("validate-fixtures requires a fixtures directory");
  }
  const expected = expectedFixtureNames(suite);
  if (new Set(expected).size !== expected.length) {
    throw new Error(`${suite} expected fixture set contains duplicate names`);
  }
  const actual = readdirSync(resolve(fixturesArgument), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((name) => !actualSet.has(name));
  const unexpected = actual.filter((name) => !expectedSet.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
    if (unexpected.length > 0) {
      details.push(`unexpected: ${unexpected.join(", ")}`);
    }
    throw new Error(`${suite} fixture set mismatch (${details.join("; ")})`);
  }
  console.log(expected.join(" "));
}

function resolveVersion() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName === "release") {
    const tag = process.env.RELEASE_TAG ?? "";
    if (!tag.startsWith("v")) {
      throw new Error(
        `release tag "${tag}" must be v followed by a valid exact semantic version`,
      );
    }
    return exactVersion(tag.slice(1));
  }
  if (eventName === "workflow_dispatch") {
    return exactVersion(process.env.DISPATCH_VERSION ?? "");
  }
  throw new Error(`unsupported GitHub event "${eventName ?? ""}"`);
}

function pinManifest(tempRootArgument, manifestArgument, versionArgument) {
  if (!tempRootArgument)
    throw new Error("pin-manifest requires an explicit temp root");
  if (!manifestArgument)
    throw new Error("pin-manifest requires a manifest path");
  const version = exactVersion(versionArgument);
  const tempRoot = realpathSync(resolve(tempRootArgument));
  const manifestPath = realpathSync(resolve(manifestArgument));
  if (!statSync(tempRoot).isDirectory()) {
    throw new Error("the explicit temp root is not a directory");
  }
  if (isWithin(REAL_ROOT_DIR, tempRoot)) {
    throw new Error("refusing to use a workspace path as the temp root");
  }
  if (isWithin(REAL_ROOT_DIR, manifestPath)) {
    throw new Error("refusing to rewrite a workspace path");
  }
  if (!isWithin(tempRoot, manifestPath)) {
    throw new Error("manifest is outside the explicit temp root");
  }
  if (!statSync(manifestPath).isFile()) {
    throw new Error("manifest path is not a file");
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!isObject(manifest))
    throw new Error(`${manifestPath} is not a JSON object`);

  const pinned = [];
  for (const sectionName of DEPENDENCY_SECTIONS) {
    const section = manifest[sectionName];
    if (section === undefined) continue;
    if (!isObject(section)) {
      throw new Error(`${manifestPath} has a non-object ${sectionName}`);
    }
    for (const packageName of Object.keys(section)) {
      if (!packageName.startsWith("@schmock/")) continue;
      section[packageName] = version;
      pinned.push(packageName);
    }
  }
  if (pinned.length === 0) {
    throw new Error(`${manifestPath} has no @schmock/* dependency to verify`);
  }

  const overrides = manifest.overrides ?? {};
  if (!isObject(overrides)) {
    throw new Error(`${manifestPath} has a non-object overrides field`);
  }
  for (const packageName of workspacePackageNames()) {
    overrides[packageName] = version;
  }
  manifest.overrides = overrides;

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const packageName of [...new Set(pinned)].sort()) {
    console.log(`  ${packageName}: ${version}`);
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "resolve-version":
      console.log(resolveVersion());
      return;
    case "validate-version":
      exactVersion(args[0]);
      return;
    case "validate-fixtures":
      validateFixtures(args[0], args[1]);
      return;
    case "pin-manifest":
      pinManifest(args[0], args[1], args[2]);
      return;
    default:
      throw new Error(`unknown command "${command ?? ""}"`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`registry-fixture: ${message}`);
  process.exitCode = 1;
}
