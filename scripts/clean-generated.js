#!/usr/bin/env node

/**
 * Clean generated files from source directories
 * This prevents stale transpiled files from interfering with development
 */

const { existsSync, readdirSync, statSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");

const PACKAGES_DIR = join(process.cwd(), "packages");
const GENERATED_SUFFIXES = [".d.ts.map", ".d.ts", ".js.map", ".js"];
const PRESERVED_SUFFIXES = [".test.js", ".spec.js", ".steps.js"];

function shouldRemove(file) {
  if (PRESERVED_SUFFIXES.some((suffix) => file.endsWith(suffix))) return false;
  return GENERATED_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

function cleanDirectory(dir) {
  if (!existsSync(dir)) return 0;

  const entries = readdirSync(dir);
  let cleaned = 0;

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (entry !== "node_modules" && entry !== "dist") {
        cleaned += cleanDirectory(fullPath);
      }
    } else if (shouldRemove(entry)) {
      console.log(`Removing: ${fullPath}`);
      unlinkSync(fullPath);
      cleaned++;
    }
  }

  return cleaned;
}

if (existsSync(PACKAGES_DIR)) {
  const packages = readdirSync(PACKAGES_DIR);
  let totalCleaned = 0;

  for (const pkg of packages) {
    const srcDir = join(PACKAGES_DIR, pkg, "src");
    if (existsSync(srcDir)) {
      console.log(`\nCleaning ${pkg}/src...`);
      const cleaned = cleanDirectory(srcDir);
      totalCleaned += cleaned;
    }
  }

  console.log(`\nCleaned ${totalCleaned} generated files`);
} else {
  console.error("No packages directory found");
  process.exit(1);
}
