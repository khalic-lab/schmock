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
const manifestPath = join(root, ".release-please-manifest.json");

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

// Read manifest
const manifest: Record<string, string> = JSON.parse(
  readFileSync(manifestPath, "utf-8"),
);

// Process each package
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const results: Array<{ name: string; from: string; to: string }> = [];

for (const pkg of packages) {
  const pkgJsonPath = join(packagesDir, pkg, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  const oldVersion = pkgJson.version;
  const newVersion = bumpVersion(oldVersion, level);

  // Update package.json
  pkgJson.version = newVersion;
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);

  // Update manifest
  const manifestKey = `packages/${pkg}`;
  if (manifestKey in manifest) {
    manifest[manifestKey] = newVersion;
  }

  results.push({ name: pkgJson.name, from: oldVersion, to: newVersion });
}

// Write manifest
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// Print results
console.log(`Bumped ${level} versions:\n`);
console.log("Package                  Before    After");
console.log("───────────────────────  ────────  ────────");
for (const r of results) {
  const name = r.name.padEnd(23);
  const from = r.from.padEnd(8);
  console.log(`${name}  ${from}  ${r.to}`);
}
console.log("");
console.log("Updated .release-please-manifest.json");
