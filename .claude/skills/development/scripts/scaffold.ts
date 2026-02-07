#!/usr/bin/env bun

/**
 * Scaffold a new feature + step definition pair.
 *
 * Usage:
 *   bun scaffold.ts --check                    # List existing features + scenarios
 *   bun scaffold.ts <feature-name> <package>   # Create feature + step files
 *
 * The --check flag outputs all existing features and their scenario names so
 * Claude can review for semantic overlap before creating a new feature.
 *
 * Example:
 *   bun scaffold.ts --check
 *   bun scaffold.ts route-matching core
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../../..");
const validPackages = ["core", "schema", "express", "angular"];
const featuresDir = join(root, "features");

// ─── Check mode: list existing features + scenarios ───

if (process.argv.includes("--check")) {
  const featureFiles = readdirSync(featuresDir).filter((f) =>
    f.endsWith(".feature"),
  );

  if (featureFiles.length === 0) {
    console.log("No existing features found.");
    process.exit(0);
  }

  console.log("Existing features and scenarios:");
  console.log("");

  for (const file of featureFiles.sort()) {
    const content = readFileSync(join(featuresDir, file), "utf-8");
    const featureName =
      content.match(/^Feature:\s*(.+)$/m)?.[1]?.trim() ?? "(unnamed)";
    const scenarios = [
      ...content.matchAll(/^\s*Scenario:\s*(.+)$/gm),
    ].map((m) => m[1].trim());

    // Find which package has steps for this feature
    const baseName = file.replace(".feature", "");
    const stepsIn: string[] = [];
    for (const pkg of validPackages) {
      const stepsPath = join(
        root,
        "packages",
        pkg,
        "src",
        "steps",
        `${baseName}.steps.ts`,
      );
      if (existsSync(stepsPath)) {
        stepsIn.push(pkg);
      }
    }

    console.log(`[${file}] ${featureName} (steps: ${stepsIn.join(", ") || "none"})`);
    for (const s of scenarios) {
      console.log(`  - ${s}`);
    }
    console.log("");
  }

  process.exit(0);
}

// ─── Create mode: scaffold feature + steps ───

const [name, pkg] = process.argv.slice(2);

if (!name || !pkg) {
  console.error("Usage: bun scaffold.ts <feature-name> <package>");
  console.error("       bun scaffold.ts --check");
  console.error("Example: bun scaffold.ts route-matching core");
  process.exit(1);
}

if (!validPackages.includes(pkg)) {
  console.error(`Invalid package: ${pkg}`);
  console.error(`Valid packages: ${validPackages.join(", ")}`);
  process.exit(1);
}

const featurePath = join(featuresDir, `${name}.feature`);
const stepsDir = join(root, "packages", pkg, "src", "steps");
const stepsPath = join(stepsDir, `${name}.steps.ts`);

if (existsSync(featurePath)) {
  console.error(`Feature file already exists: features/${name}.feature`);
  process.exit(1);
}

if (existsSync(stepsPath)) {
  console.error(
    `Steps file already exists: packages/${pkg}/src/steps/${name}.steps.ts`,
  );
  process.exit(1);
}

// Read templates
const templateDir = join(import.meta.dir, "..", "templates");
let featureTemplate = readFileSync(
  join(templateDir, "feature.feature"),
  "utf-8",
);
let stepsTemplate = readFileSync(join(templateDir, "steps.ts"), "utf-8");

// Convert kebab-case to Title Case for feature name
const titleCase = name
  .split("-")
  .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
  .join(" ");

// Substitute placeholders
featureTemplate = featureTemplate
  .replace("{{FEATURE_NAME}}", titleCase)
  .replace("{{WANT}}", "[describe what you want]")
  .replace("{{SO_THAT}}", "[describe the benefit]")
  .replace("{{SCENARIO_NAME}}", "[describe the scenario]")
  .replace("{{GIVEN}}", "[precondition]")
  .replace("{{WHEN}}", "[action]")
  .replace("{{THEN}}", "[expected result]");

stepsTemplate = stepsTemplate
  .replace("{{FEATURE_FILE}}", `${name}.feature`)
  .replace("{{SCENARIO_NAME}}", "[describe the scenario]")
  .replace("{{GIVEN}}", "[precondition]")
  .replace("{{WHEN}}", "[action]")
  .replace("{{THEN}}", "[expected result]");

// Ensure steps directory exists
if (!existsSync(stepsDir)) {
  mkdirSync(stepsDir, { recursive: true });
}

// Write files
writeFileSync(featurePath, featureTemplate);
writeFileSync(stepsPath, stepsTemplate);

console.log(`Created feature:  features/${name}.feature`);
console.log(`Created steps:    packages/${pkg}/src/steps/${name}.steps.ts`);
console.log("");
console.log("Next steps:");
console.log("  1. Edit the .feature file with your scenarios");
console.log("  2. Implement step definitions in the .steps.ts file");
console.log("  3. Run: bun test:bdd");
