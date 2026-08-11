#!/usr/bin/env bun

/** Scaffold a version-aligned @schmock/* package. */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

type BuildTarget = "node" | "browser";
type JsonObject = Record<string, unknown>;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

const TOPOLOGY_FOLLOW_UPS = [
  "package.json: build, typecheck, and typecheck:quiet explicit filters",
  ".agents/skills/devops/scripts/bump.ts: EXPECTED_PACKAGES",
  ".agents/skills/devops/scripts/publish.sh: PACKAGES dependency order",
  ".agents/skills/dependency-management/scripts/check-deps.sh: PACKAGES",
  ".agents/skills/devops/SKILL.md: workspace count and release order",
  "scripts/smoke-tests/fixtures/<package>: add the smoke fixture required by workspace manifest discovery",
  "AGENTS.md and README.md: maintained package inventories",
  "packages/schmock: dependencies, externals, and exports only when the aggregate should include the new package",
] as const;

interface CliOptions {
  name: string;
  root: string;
  target: BuildTarget;
  dryRun: boolean;
}

interface WorkspaceManifest {
  directory: string;
  json: JsonObject;
  name: string;
  path: string;
  version: string;
}

export interface Snapshot {
  bytes: string;
  path: string;
}

function usage(): string {
  return [
    "Usage: bun generate.ts <package-name> --target <node|browser> [--root <repo>] [--dry-run]",
    "Example: bun generate.ts fastify --target node --dry-run",
  ].join("\n");
}

function parseTarget(value: string | undefined): BuildTarget {
  if (value !== "node" && value !== "browser") {
    throw new Error(
      `Invalid --target: ${value ?? "missing"}; use node or browser`,
    );
  }
  return value;
}

function parseArgs(args: string[]): CliOptions {
  let name: string | undefined;
  let root = resolve(import.meta.dir, "../../../..");
  let target: BuildTarget | undefined;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for --root\n${usage()}`);
      root = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--target") {
      target = parseTarget(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}\n${usage()}`);
    }
    if (name) throw new Error(`Unexpected argument: ${arg}\n${usage()}`);
    name = arg;
  }

  if (!name) throw new Error(usage());
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `Invalid package name: ${name} (use lowercase letters, digits, and hyphens; start with a letter)`,
    );
  }
  if (!target) throw new Error(`Missing required --target\n${usage()}`);

  return { name, root, target, dryRun };
}

function assertJsonObject(
  value: unknown,
  label: string,
): asserts value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string, label: string): JsonObject {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    assertJsonObject(value, label);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${label} at ${path}: ${message}`);
  }
}

function requiredObject(
  object: JsonObject,
  key: string,
  label: string,
): JsonObject {
  const value = object[key];
  assertJsonObject(value, `${label}.${key}`);
  return value;
}

function requiredString(
  object: JsonObject,
  key: string,
  label: string,
): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function readTemplate(templateDir: string, filename: string): string {
  return readFileSync(join(templateDir, filename), "utf-8");
}

function render(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  const unresolved = result.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (unresolved) {
    throw new Error(`Unresolved template variables: ${unresolved.join(", ")}`);
  }
  return result;
}

function parseJsonc(bytes: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = Bun.JSONC.parse(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSONC: ${message}`);
  }
  assertJsonObject(value, label);
  return value;
}

function optionalObject(
  object: JsonObject,
  key: string,
  label: string,
): JsonObject {
  const value = object[key];
  if (value === undefined) return {};
  assertJsonObject(value, `${label}.${key}`);
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function expectedWorkspaceRecord(manifest: WorkspaceManifest): JsonObject {
  const expected: JsonObject = {
    name: manifest.name,
    version: manifest.version,
  };
  if (manifest.json.bin !== undefined) expected.bin = manifest.json.bin;
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = optionalObject(manifest.json, field, manifest.path);
    if (Object.keys(dependencies).length > 0) expected[field] = dependencies;
  }

  const peerMetadata = optionalObject(
    manifest.json,
    "peerDependenciesMeta",
    manifest.path,
  );
  const optionalPeers = Object.entries(peerMetadata)
    .filter(
      ([, metadata]) => isJsonObject(metadata) && metadata.optional === true,
    )
    .map(([name]) => name)
    .sort();
  if (optionalPeers.length > 0) expected.optionalPeers = optionalPeers;
  return expected;
}

function readWorkspaceManifests(root: string): WorkspaceManifest[] {
  const packagesDirectory = join(root, "packages");
  return readdirSync(packagesDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(packagesDirectory, entry.name, "package.json")),
    )
    .map((entry) => {
      const path = join(packagesDirectory, entry.name, "package.json");
      const json = readJsonObject(path, `${entry.name} package.json`);
      const name = requiredString(json, "name", `${entry.name} package.json`);
      const version = requiredString(
        json,
        "version",
        `${entry.name} package.json`,
      );
      if (name !== `@schmock/${entry.name}`) {
        throw new Error(
          `${path} has unexpected package name ${name}; expected @schmock/${entry.name}`,
        );
      }
      return { directory: entry.name, json, name, path, version };
    })
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

function validateLockfile(
  bytes: string,
  manifests: WorkspaceManifest[],
  label: string,
): void {
  const lockfile = parseJsonc(bytes, label);
  const workspaces = requiredObject(lockfile, "workspaces", label);
  const packages = requiredObject(lockfile, "packages", label);

  const expectedWorkspaceKeys = manifests
    .map(({ directory }) => `packages/${directory}`)
    .sort();
  const actualWorkspaceKeys = Object.keys(workspaces)
    .filter((key) => key.startsWith("packages/"))
    .sort();
  if (
    JSON.stringify(actualWorkspaceKeys) !==
    JSON.stringify(expectedWorkspaceKeys)
  ) {
    throw new Error(
      `${label} workspace topology is ${JSON.stringify(actualWorkspaceKeys)}, expected ${JSON.stringify(expectedWorkspaceKeys)}`,
    );
  }

  const expectedWorkspacePackages = manifests.map(({ name }) => name).sort();
  const actualWorkspacePackages = Object.entries(packages)
    .filter(
      ([, resolution]) =>
        Array.isArray(resolution) &&
        resolution.length === 1 &&
        typeof resolution[0] === "string" &&
        resolution[0].includes("@workspace:packages/"),
    )
    .map(([name]) => name)
    .sort();
  if (
    JSON.stringify(actualWorkspacePackages) !==
    JSON.stringify(expectedWorkspacePackages)
  ) {
    throw new Error(
      `${label} workspace package resolutions are ${JSON.stringify(actualWorkspacePackages)}, expected ${JSON.stringify(expectedWorkspacePackages)}`,
    );
  }

  for (const manifest of manifests) {
    const key = `packages/${manifest.directory}`;
    const entry = workspaces[key];
    assertJsonObject(entry, `${label}.workspaces.${key}`);
    const expectedEntry = expectedWorkspaceRecord(manifest);
    if (
      JSON.stringify(canonicalize(entry)) !==
      JSON.stringify(canonicalize(expectedEntry))
    ) {
      throw new Error(
        `${label} workspace ${key} does not exactly match ${manifest.path}: locked ${JSON.stringify(canonicalize(entry))}, expected ${JSON.stringify(canonicalize(expectedEntry))}`,
      );
    }
    const resolution = packages[manifest.name];
    const expectedResolution = [
      `${manifest.name}@workspace:packages/${manifest.directory}`,
    ];
    if (JSON.stringify(resolution) !== JSON.stringify(expectedResolution)) {
      throw new Error(
        `${label} package resolution for ${manifest.name} is ${JSON.stringify(resolution)}, expected ${JSON.stringify(expectedResolution)}`,
      );
    }
  }
}

function refreshLockfile(
  originalLockfileBytes: string,
  currentManifests: WorkspaceManifest[],
  generatedManifest: WorkspaceManifest,
): string {
  const lockfile = parseJsonc(originalLockfileBytes, "bun.lock");
  const workspaces = requiredObject(lockfile, "workspaces", "bun.lock");
  const packages = requiredObject(lockfile, "packages", "bun.lock");
  const workspaceKey = `packages/${generatedManifest.directory}`;
  if (workspaceKey in workspaces || generatedManifest.name in packages) {
    throw new Error(
      `bun.lock already contains ${workspaceKey} or ${generatedManifest.name}`,
    );
  }

  const workspaceBoundary = '\n  },\n  "packages": {';
  const boundaryIndex = originalLockfileBytes.indexOf(workspaceBoundary);
  if (
    boundaryIndex < 0 ||
    originalLockfileBytes.indexOf(workspaceBoundary, boundaryIndex + 1) >= 0
  ) {
    throw new Error("bun.lock does not use the supported text lockfile layout");
  }
  const workspaceProperty = formatProperty(
    workspaceKey,
    expectedWorkspaceRecord(generatedManifest),
  );
  const workspacePrefix = originalLockfileBytes.slice(0, boundaryIndex);
  const workspaceSeparator = workspacePrefix.trimEnd().endsWith(",")
    ? "\n"
    : ",\n";
  let nextBytes = `${workspacePrefix}${workspaceSeparator}${workspaceProperty}${originalLockfileBytes.slice(boundaryIndex)}`;

  const packagesBoundary = nextBytes.lastIndexOf("\n  }\n}");
  if (packagesBoundary < nextBytes.indexOf('\n  "packages": {')) {
    throw new Error(
      "bun.lock packages record is not the final top-level object",
    );
  }
  const resolution = `${generatedManifest.name}@workspace:${workspaceKey}`;
  const packageProperty = `    ${JSON.stringify(generatedManifest.name)}: [${JSON.stringify(resolution)}],`;
  const packagesPrefix = nextBytes.slice(0, packagesBoundary);
  const packagesSeparator = packagesPrefix.trimEnd().endsWith(",")
    ? "\n\n"
    : ",\n\n";
  nextBytes = `${packagesPrefix}${packagesSeparator}${packageProperty}${nextBytes.slice(packagesBoundary)}`;

  validateLockfile(
    nextBytes,
    [...currentManifests, generatedManifest],
    "refreshed bun.lock",
  );
  return nextBytes;
}

function formatProperty(key: string, value: JsonObject): string {
  const formattedValue = JSON.stringify(value, null, 2).replaceAll(
    "\n",
    "\n    ",
  );
  return `    ${JSON.stringify(key)}: ${formattedValue},`;
}

export function assertUnchanged(snapshot: Snapshot): void {
  let bytes: string;
  try {
    bytes = readFileSync(snapshot.path, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Stale snapshot for ${snapshot.path}: ${message}`);
  }
  if (bytes !== snapshot.bytes) {
    throw new Error(`Stale snapshot for ${snapshot.path}: file changed`);
  }
}

function atomicReplace(path: string, bytes: string): void {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function atomicCreate(path: string, bytes: string): void {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx" });
    linkSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

export function generatedDirectoryMatches(
  packageDirectory: string,
  files: Array<[string, string]>,
  allowMissing = false,
): boolean {
  if (!existsSync(packageDirectory)) return allowMissing;
  const expected = new Map(files);
  const expectedDirectories = new Set<string>();
  for (const [path] of files) {
    let parent = dirname(path);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = dirname(parent);
    }
  }
  const actualFiles: string[] = [];
  const actualDirectories: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        actualDirectories.push(relative(packageDirectory, path));
        visit(path);
      } else {
        actualFiles.push(relative(packageDirectory, path));
      }
    }
  };
  visit(packageDirectory);
  if (!actualDirectories.every((path) => expectedDirectories.has(path))) {
    return false;
  }
  if (
    !allowMissing &&
    (actualFiles.length !== expected.size ||
      actualDirectories.length !== expectedDirectories.size)
  ) {
    return false;
  }
  return actualFiles.every(
    (path) =>
      expected.get(path) ===
      readFileSync(join(packageDirectory, path), "utf-8"),
  );
}

function bytesEqual(path: string, expected: string): boolean {
  try {
    return readFileSync(path, "utf-8") === expected;
  } catch {
    return false;
  }
}

function removePath(path: string, rollbackFailures: string[]): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rollbackFailures.push(`${path}: ${message}`);
  }
}

function main(): void {
  const { name, root, target, dryRun } = parseArgs(process.argv.slice(2));
  const rootPackagePath = join(root, "package.json");
  const corePackagePath = join(root, "packages", "core", "package.json");
  const tsconfigPath = join(root, "tsconfig.json");
  const lockfilePath = join(root, "bun.lock");

  const rootPackageBytes = readFileSync(rootPackagePath, "utf-8");
  const tsconfigBytes = readFileSync(tsconfigPath, "utf-8");
  const lockfileBytes = readFileSync(lockfilePath, "utf-8");

  const rootPackage = readJsonObject(rootPackagePath, "root package.json");
  if (rootPackage.name !== "schmock") {
    throw new Error(
      `Refusing to generate outside a Schmock repository: ${root}`,
    );
  }
  if (
    !Array.isArray(rootPackage.workspaces) ||
    !rootPackage.workspaces.includes("packages/*")
  ) {
    throw new Error(
      'Root package.json must include the "packages/*" workspace',
    );
  }

  const corePackage = readJsonObject(
    corePackagePath,
    "@schmock/core package.json",
  );
  const coreVersion = requiredString(corePackage, "version", "@schmock/core");
  const devDependencies = requiredObject(
    rootPackage,
    "devDependencies",
    "root package.json",
  );
  const cucumberVersion = requiredString(
    devDependencies,
    "@amiceli/vitest-cucumber",
    "root devDependencies",
  );
  const typescriptVersion = requiredString(
    devDependencies,
    "typescript",
    "root devDependencies",
  );
  const vitestVersion = requiredString(
    devDependencies,
    "vitest",
    "root devDependencies",
  );

  const pkgDir = join(root, "packages", name);
  if (existsSync(pkgDir)) {
    throw new Error(`Package directory already exists: packages/${name}`);
  }

  const tsconfig = readJsonObject(tsconfigPath, "root tsconfig.json");
  const compilerOptions = requiredObject(
    tsconfig,
    "compilerOptions",
    "tsconfig.json",
  );
  const paths = requiredObject(
    compilerOptions,
    "paths",
    "tsconfig.json compilerOptions",
  );
  const alias = `@schmock/${name}`;
  if (alias in paths) {
    throw new Error(`Path alias already exists in tsconfig.json: ${alias}`);
  }

  const title = name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const vars = {
    PACKAGE_NAME: name,
    PACKAGE_VERSION: coreVersion,
    CORE_VERSION: coreVersion,
    CUCUMBER_VERSION: cucumberVersion,
    DESCRIPTION: `${title} extension for Schmock`,
    TARGET: target,
    TYPESCRIPT_VERSION: typescriptVersion,
    VITEST_VERSION: vitestVersion,
  };
  const templateDir = join(import.meta.dir, "..", "templates");
  const files: Array<[string, string]> = [
    [
      "package.json",
      render(readTemplate(templateDir, "package.json.tmpl"), vars),
    ],
    ["tsconfig.json", readTemplate(templateDir, "tsconfig.json.tmpl")],
    ["vitest.config.ts", readTemplate(templateDir, "vitest.config.ts.tmpl")],
    [
      "vitest.config.bdd.ts",
      readTemplate(templateDir, "vitest.config.bdd.ts.tmpl"),
    ],
    ["src/index.ts", render(readTemplate(templateDir, "index.ts.tmpl"), vars)],
  ];

  paths[alias] = [`./packages/${name}/src`];
  const nextTsconfig = `${JSON.stringify(tsconfig, null, 2)}\n`;

  const currentManifests = readWorkspaceManifests(root);
  for (const manifest of currentManifests) {
    if (manifest.version !== coreVersion) {
      throw new Error(
        `Workspace versions are not synchronized: ${manifest.name} is ${manifest.version}, expected ${coreVersion}`,
      );
    }
  }
  validateLockfile(lockfileBytes, currentManifests, "bun.lock");
  const generatedPackage: unknown = JSON.parse(files[0][1]);
  assertJsonObject(generatedPackage, `${alias} generated package.json`);
  const generatedManifest = {
    directory: name,
    json: generatedPackage,
    name: alias,
    path: join(pkgDir, "package.json"),
    version: coreVersion,
  };
  const nextLockfile = refreshLockfile(
    lockfileBytes,
    currentManifests,
    generatedManifest,
  );

  console.log(
    dryRun ? "Dry run: no files will be written." : "Generating package.",
  );
  console.log(`Package: ${alias}@${coreVersion} (${target})`);
  for (const [path] of files) console.log(`  packages/${name}/${path}`);
  console.log(`  tsconfig.json: ${alias} -> packages/${name}/src`);
  console.log(`  bun.lock: register packages/${name}`);
  console.log("Explicit topology follow-ups:");
  for (const followUp of TOPOLOGY_FOLLOW_UPS) {
    console.log(`  - ${followUp}`);
  }

  if (dryRun) return;

  const immutableSnapshots: Snapshot[] = [
    { path: rootPackagePath, bytes: rootPackageBytes },
    ...currentManifests.map((manifest) => ({
      path: manifest.path,
      bytes: readFileSync(manifest.path, "utf-8"),
    })),
  ];
  const tsconfigSnapshot = { path: tsconfigPath, bytes: tsconfigBytes };
  const lockfileSnapshot = { path: lockfilePath, bytes: lockfileBytes };
  let packageInstalled = false;
  let tsconfigWritten = false;
  let lockfileWritten = false;

  try {
    for (const snapshot of immutableSnapshots) assertUnchanged(snapshot);
    assertUnchanged(tsconfigSnapshot);
    assertUnchanged(lockfileSnapshot);
    if (existsSync(pkgDir)) {
      throw new Error(
        `Package directory appeared during generation: ${pkgDir}`,
      );
    }

    mkdirSync(pkgDir);
    packageInstalled = true;
    mkdirSync(join(pkgDir, "src"));
    for (const [path, content] of files) {
      atomicCreate(join(pkgDir, path), content);
    }
    assertUnchanged(tsconfigSnapshot);
    atomicReplace(tsconfigPath, nextTsconfig);
    tsconfigWritten = true;
    assertUnchanged(lockfileSnapshot);
    atomicReplace(lockfilePath, nextLockfile);
    lockfileWritten = true;

    if (!generatedDirectoryMatches(pkgDir, files)) {
      throw new Error(
        "Generated package changed before transaction completion",
      );
    }
    if (readFileSync(tsconfigPath, "utf-8") !== nextTsconfig) {
      throw new Error("tsconfig.json changed before transaction completion");
    }
    if (readFileSync(lockfilePath, "utf-8") !== nextLockfile) {
      throw new Error("bun.lock changed before transaction completion");
    }
    for (const snapshot of immutableSnapshots) assertUnchanged(snapshot);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    const rollbackFailures: string[] = [];

    if (lockfileWritten) {
      if (bytesEqual(lockfilePath, nextLockfile)) {
        try {
          atomicReplace(lockfilePath, lockfileBytes);
        } catch (rollbackError) {
          const message =
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
          rollbackFailures.push(`${lockfilePath}: ${message}`);
        }
      } else {
        rollbackFailures.push(`${lockfilePath} changed after generator write`);
      }
    }
    if (tsconfigWritten) {
      if (bytesEqual(tsconfigPath, nextTsconfig)) {
        try {
          atomicReplace(tsconfigPath, tsconfigBytes);
        } catch (rollbackError) {
          const message =
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
          rollbackFailures.push(`${tsconfigPath}: ${message}`);
        }
      } else {
        rollbackFailures.push(`${tsconfigPath} changed after generator write`);
      }
    }
    if (packageInstalled) {
      if (generatedDirectoryMatches(pkgDir, files, true)) {
        removePath(pkgDir, rollbackFailures);
      } else {
        rollbackFailures.push(
          `${pkgDir} contains files not created by this generator`,
        );
      }
    }

    if (rollbackFailures.length > 0) {
      throw new Error(
        `Generation failed: ${failure}. Rollback was incomplete: ${rollbackFailures.join("; ")}`,
      );
    }
    throw new Error(`Generation failed; changes rolled back: ${failure}`);
  }

  console.log("Generation complete.");
  console.log(
    `Next: resolve every listed topology follow-up, then implement and test ${alias}.`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
