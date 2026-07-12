#!/usr/bin/env bun

/** Create or inventory Schmock BDD feature and step-definition pairs. */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

interface Options {
  check: boolean;
  dryRun: boolean;
  name?: string;
  packageName?: string;
  root: string;
}

interface Workspace {
  directory: string;
  fullName: string;
  shortName: string;
  stepsExtension: ".ts" | ".tsx";
}

type JsonObject = Record<string, unknown>;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function usage(): string {
  return [
    "Usage: bun scaffold.ts --check [--root <repo>]",
    "       bun scaffold.ts <feature-name> <package> [--dry-run] [--root <repo>]",
  ].join("\n");
}

function parseArgs(args: string[]): Options {
  let check = false;
  let dryRun = false;
  let root: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--root") {
      const value = args[index + 1];
      if (!value) fail(`Missing value for --root\n${usage()}`);
      root = resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("-"))
      fail(`Unknown option: ${argument}\n${usage()}`);
    positionals.push(argument);
  }

  if (check) {
    if (dryRun || positionals.length > 0)
      fail(`--check accepts only --root\n${usage()}`);
  } else if (positionals.length !== 2) {
    fail(usage());
  }

  return {
    check,
    dryRun,
    name: positionals[0],
    packageName: positionals[1],
    root: root ?? findRepoRoot(),
  };
}

function findRepoRoot(): string {
  const result = spawnSync(
    "git",
    ["-C", import.meta.dir, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail("Cannot locate the Schmock repository; pass --root <repo>");
  }
  return resolve(result.stdout.trim());
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Cannot read ${label} at ${path}: ${detail}`);
  }
  if (!isJsonObject(value)) fail(`${label} must be a JSON object`);
  return value;
}

function containedBy(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function discoverWorkspaces(root: string): Workspace[] {
  const canonicalRoot = realpathSync(root);
  const rootManifest = readJsonObject(
    join(canonicalRoot, "package.json"),
    "root package.json",
  );
  const configured = rootManifest.workspaces;
  if (!Array.isArray(configured) || !configured.includes("packages/*")) {
    fail('Root package.json must include the "packages/*" workspace');
  }

  const packagesDir = realpathSync(join(canonicalRoot, "packages"));
  if (!containedBy(canonicalRoot, packagesDir))
    fail("packages directory escapes the repository");

  const workspaces: Workspace[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = realpathSync(join(packagesDir, entry.name));
    if (!containedBy(packagesDir, directory))
      fail(`Workspace escapes packages/: ${entry.name}`);

    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJsonObject(manifestPath, `${entry.name} package.json`);
    const shortName = basename(directory);
    const fullName = manifest.name;
    if (fullName !== `@schmock/${shortName}`) {
      fail(`${manifestPath} must be named @schmock/${shortName}`);
    }
    const scripts = manifest.scripts;
    if (!isJsonObject(scripts) || typeof scripts["test:bdd"] !== "string")
      continue;

    const tsconfig = readJsonObject(
      join(directory, "tsconfig.json"),
      `${shortName} tsconfig.json`,
    );
    const compilerOptions = tsconfig.compilerOptions;
    const usesJsx =
      isJsonObject(compilerOptions) && typeof compilerOptions.jsx === "string";
    workspaces.push({
      directory,
      fullName,
      shortName,
      stepsExtension: usesJsx ? ".tsx" : ".ts",
    });
  }

  if (workspaces.length === 0) fail("No BDD-capable Schmock workspaces found");
  return workspaces.sort((left, right) =>
    left.shortName.localeCompare(right.shortName),
  );
}

function substitute(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

function listFeatures(root: string, workspaces: Workspace[]): void {
  const featuresDir = join(root, "features");
  const files = readdirSync(featuresDir)
    .filter((file) => file.endsWith(".feature"))
    .sort();

  if (files.length === 0) {
    console.log("No existing features found.");
    return;
  }

  console.log("Existing features and scenarios:\n");
  for (const file of files) {
    const content = readFileSync(join(featuresDir, file), "utf8");
    const featureName =
      content.match(/^Feature:\s*(.+)$/m)?.[1]?.trim() ?? "(unnamed)";
    const scenarios = [
      ...content.matchAll(/^\s*Scenario(?: Outline)?:\s*(.+)$/gm),
    ].map((match) => match[1].trim());
    const baseName = file.slice(0, -".feature".length);
    const owners = workspaces
      .filter((workspace) =>
        [".ts", ".tsx"].some((extension) =>
          existsSync(
            join(
              workspace.directory,
              "src",
              "steps",
              `${baseName}.steps${extension}`,
            ),
          ),
        ),
      )
      .map((workspace) => workspace.shortName);

    console.log(
      `[${file}] ${featureName} (steps: ${owners.join(", ") || "none"})`,
    );
    for (const scenario of scenarios) console.log(`  - ${scenario}`);
    console.log("");
  }
}

function createPair(options: Options, workspaces: Workspace[]): void {
  const name = options.name;
  const requestedPackage = options.packageName;
  if (!name || !requestedPackage) fail(usage());
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    fail(`Invalid feature name: ${name}. Use strict kebab-case.`);
  }

  const workspace = workspaces.find(
    (candidate) =>
      candidate.shortName === requestedPackage ||
      candidate.fullName === requestedPackage,
  );
  if (!workspace) {
    fail(
      `Unknown or non-BDD package: ${requestedPackage}. Valid packages: ${workspaces.map((item) => item.shortName).join(", ")}`,
    );
  }

  const canonicalRoot = realpathSync(options.root);
  const featuresDir = realpathSync(join(canonicalRoot, "features"));
  if (!containedBy(canonicalRoot, featuresDir)) {
    fail("Features directory escapes repository");
  }
  const featurePath = join(featuresDir, `${name}.feature`);
  const sourceDir = realpathSync(join(workspace.directory, "src"));
  if (!containedBy(workspace.directory, sourceDir)) {
    fail("Source directory escapes workspace");
  }
  let stepsDir = join(sourceDir, "steps");
  if (existsSync(stepsDir)) stepsDir = realpathSync(stepsDir);
  if (!containedBy(sourceDir, stepsDir)) {
    fail("Steps directory escapes workspace");
  }
  const stepsPath = join(stepsDir, `${name}.steps${workspace.stepsExtension}`);
  if (!containedBy(canonicalRoot, resolve(featurePath)))
    fail("Feature path escapes repository");
  if (!containedBy(workspace.directory, resolve(stepsPath)))
    fail("Steps path escapes workspace");
  if (existsSync(featurePath))
    fail(`Feature already exists: features/${name}.feature`);
  if (existsSync(stepsPath)) {
    fail(
      `Steps already exist: packages/${workspace.shortName}/src/steps/${name}.steps${workspace.stepsExtension}`,
    );
  }

  const title = name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  const templateDir = join(import.meta.dir, "..", "templates");
  const feature = substitute(
    readFileSync(join(templateDir, "feature.feature"), "utf8"),
    {
      FEATURE_NAME: title,
      GIVEN: "[precondition]",
      SCENARIO_NAME: "[describe the scenario]",
      SO_THAT: "[describe the benefit]",
      THEN: "[expected result]",
      WANT: "[describe what you want]",
      WHEN: "[action]",
    },
  );
  const steps = substitute(
    readFileSync(join(templateDir, "steps.ts"), "utf8"),
    {
      FEATURE_FILE: `${name}.feature`,
      GIVEN: "[precondition]",
      SCENARIO_NAME: "[describe the scenario]",
      THEN: "[expected result]",
      WHEN: "[action]",
    },
  );

  const featureRelative = `features/${name}.feature`;
  const stepsRelative = `packages/${workspace.shortName}/src/steps/${name}.steps${workspace.stepsExtension}`;
  console.log(
    options.dryRun
      ? "DRY RUN: no files will be written."
      : "Creating BDD pair.",
  );
  console.log(`  ${featureRelative}`);
  console.log(`  ${stepsRelative}`);
  if (options.dryRun) return;

  const createdStepsDir = !existsSync(stepsDir);
  let featureWritten = false;
  let stepsWritten = false;
  try {
    if (createdStepsDir) mkdirSync(stepsDir, { recursive: true });
    writeFileSync(featurePath, feature, { flag: "wx" });
    featureWritten = true;
    writeFileSync(stepsPath, steps, { flag: "wx" });
    stepsWritten = true;
  } catch (error) {
    if (stepsWritten) rmSync(stepsPath, { force: true });
    if (featureWritten) rmSync(featurePath, { force: true });
    if (createdStepsDir) {
      try {
        rmdirSync(stepsDir);
      } catch {
        // Preserve a non-empty directory that was populated concurrently.
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Scaffolding failed; new files were rolled back: ${detail}`);
  }

  console.log(
    "Created both files. Replace placeholders, then run the package BDD test.",
  );
}

const cliOptions = parseArgs(process.argv.slice(2));
const repoRoot = realpathSync(cliOptions.root);
if (!existsSync(join(repoRoot, "features"))) {
  fail(`Missing features directory under ${repoRoot}`);
}
if (!containedBy(repoRoot, realpathSync(join(repoRoot, "features")))) {
  fail("Features directory escapes repository");
}
const bddWorkspaces = discoverWorkspaces(repoRoot);
if (cliOptions.check) listFeatures(repoRoot, bddWorkspaces);
else createPair({ ...cliOptions, root: repoRoot }, bddWorkspaces);
