#!/usr/bin/env bun

/**
 * Generate a new @schmock/* package with full monorepo structure.
 *
 * Usage:
 *   bun generate.ts <package-name>
 *
 * Example:
 *   bun generate.ts fastify
 *
 * Creates:
 *   packages/<name>/package.json
 *   packages/<name>/tsconfig.json
 *   packages/<name>/vitest.config.ts
 *   packages/<name>/vitest.config.bdd.ts
 *   packages/<name>/src/index.ts
 *
 * Registers in:
 *   tsconfig.json (path alias)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const name = process.argv[2];

if (!name) {
  console.error("Usage: bun generate.ts <package-name>");
  console.error("Example: bun generate.ts fastify");
  process.exit(1);
}

if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(
    `Invalid package name: ${name} (must be lowercase, alphanumeric + hyphens)`,
  );
  process.exit(1);
}

const root = join(import.meta.dir, "../../../..");
const pkgDir = join(root, "packages", name);

if (existsSync(pkgDir)) {
  console.error(`Package directory already exists: packages/${name}`);
  process.exit(1);
}

const templateDir = join(import.meta.dir, "..", "templates");

function readTemplate(filename: string): string {
  return readFileSync(join(templateDir, filename), "utf-8");
}

function render(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

const vars = {
  PACKAGE_NAME: name,
  DESCRIPTION: `${name.charAt(0).toUpperCase() + name.slice(1)} adapter for Schmock mock API generator`,
};

// Create directory structure
mkdirSync(join(pkgDir, "src"), { recursive: true });

// Render and write templates
const files: Array<[string, string]> = [
  ["package.json", render(readTemplate("package.json.tmpl"), vars)],
  ["tsconfig.json", readTemplate("tsconfig.json.tmpl")],
  ["vitest.config.ts", readTemplate("vitest.config.ts.tmpl")],
  ["vitest.config.bdd.ts", readTemplate("vitest.config.bdd.ts.tmpl")],
  ["src/index.ts", render(readTemplate("index.ts.tmpl"), vars)],
];

for (const [path, content] of files) {
  writeFileSync(join(pkgDir, path), content);
}

// Register in root tsconfig.json
const tsconfigPath = join(root, "tsconfig.json");
const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
const alias = `@schmock/${name}`;
if (!tsconfig.compilerOptions.paths[alias]) {
  tsconfig.compilerOptions.paths[alias] = [`packages/${name}/src`];
  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
  console.log(`Registered path alias: ${alias} → packages/${name}/src`);
}

console.log("");
console.log(`Generated @schmock/${name}:`);
for (const [path] of files) {
  console.log(`  packages/${name}/${path}`);
}
console.log("");
console.log("Next steps:");
console.log(`  1. cd packages/${name} && bun install`);
console.log(`  2. Add to root package.json build/typecheck scripts`);
console.log(`  3. Create a feature file: /development scaffold ${name}-adapter ${name}`);
console.log("  4. Start implementing!");
