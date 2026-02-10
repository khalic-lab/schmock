#!/usr/bin/env bun

/**
 * Bump versions for all Schmock packages.
 *
 * Usage:
 *   bun bump.ts patch   # 1.0.1 → 1.0.2
 *   bun bump.ts minor   # 1.0.1 → 1.1.0
 *   bun bump.ts major   # 1.0.1 → 2.0.0
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const level = process.argv[2];

if (!level || !["patch", "minor", "major"].includes(level)) {
  console.error("Usage: bun bump.ts patch|minor|major");
  process.exit(1);
}

const root = join(import.meta.dir, "../../../..");
const packagesDir = join(root, "packages");

function bumpVersion(version: string, level: string): string {
  const [major, minor, patch] = version.split(".").map(Number);
  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unknown level: ${level}`);
  }
}

// Process each package
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const results: Array<{ name: string; from: string; to: string }> = [];

// First pass: bump versions and collect new versions by package name
const versionMap = new Map<string, string>();

for (const pkg of packages) {
  const pkgJsonPath = join(packagesDir, pkg, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  const oldVersion = pkgJson.version;
  const newVersion = bumpVersion(oldVersion, level);

  pkgJson.version = newVersion;
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);

  versionMap.set(pkgJson.name, newVersion);
  results.push({ name: pkgJson.name, from: oldVersion, to: newVersion });
}

// Second pass: sync cross-package @schmock/* dependency ranges
let depsUpdated = 0;

for (const pkg of packages) {
  const pkgJsonPath = join(packagesDir, pkg, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  let changed = false;

  for (const depField of [
    "dependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const deps = pkgJson[depField];
    if (!deps) continue;

    for (const [depName, depRange] of Object.entries(deps)) {
      if (!depName.startsWith("@schmock/")) continue;
      const newVersion = versionMap.get(depName);
      if (!newVersion) continue;

      const newRange = `^${newVersion}`;
      if (depRange !== newRange) {
        deps[depName] = newRange;
        changed = true;
        depsUpdated++;
      }
    }
  }

  if (changed) {
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
  }
}

// Print results
console.log(`Bumped ${level} versions:\n`);
console.log("Package                  Before    After");
console.log("───────────────────────  ────────  ────────");
for (const r of results) {
  const name = r.name.padEnd(23);
  const from = r.from.padEnd(8);
  console.log(`${name}  ${from}  ${r.to}`);
}
if (depsUpdated > 0) {
  console.log(
    `\nSynced ${depsUpdated} cross-package @schmock/* dependency range(s)`,
  );
}
