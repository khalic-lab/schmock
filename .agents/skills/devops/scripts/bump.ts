#!/usr/bin/env bun

/**
 * Preview or apply a synchronized version bump for all Schmock workspaces.
 *
 * Usage:
 *   bun bump.ts patch                 # dry-run (default)
 *   bun bump.ts minor --dry-run       # explicit dry-run
 *   bun bump.ts major --apply         # write manifests
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const EXPECTED_PACKAGES = [
  "core",
  "faker",
  "validation",
  "query",
  "express",
  "react",
  "vue",
  "openapi",
  "angular",
  "cli",
  "schmock",
] as const;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

type JsonObject = Record<string, unknown>;
type BumpLevel = "patch" | "minor" | "major";

interface WorkspaceManifest {
  dir: string;
  path: string;
  originalBytes: string;
  json: JsonObject;
  name: string;
  version: string;
}

interface ManifestWrite {
  path: string;
  originalBytes: string;
  nextBytes: string;
}

type ManifestWriter = (path: string, bytes: string) => void;

interface SnapshotGuard {
  path: string;
  originalBytes: string;
}

interface ReleaseState {
  lockfileBytes: string;
  lockfilePath: string;
  manifests: WorkspaceManifest[];
  rootPackageBytes: string;
  rootPackagePath: string;
  version: string;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonc(bytes: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSONC: ${reason}`);
  }
  if (!isJsonObject(parsed)) throw new Error(`${label} must contain an object`);
  return parsed;
}

function dependencyMap(value: unknown, label: string): JsonObject {
  if (value === undefined) return {};
  if (!isJsonObject(value)) throw new Error(`${label} must contain an object`);
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
    const dependencies = dependencyMap(
      manifest.json[field],
      `${manifest.path}.${field}`,
    );
    if (Object.keys(dependencies).length > 0) expected[field] = dependencies;
  }

  const peerMetadata = dependencyMap(
    manifest.json.peerDependenciesMeta,
    `${manifest.path}.peerDependenciesMeta`,
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

function validateLockfile(
  bytes: string,
  manifests: WorkspaceManifest[],
  label: string,
): void {
  const lockfile = parseJsonc(bytes, label);
  const workspaces = dependencyMap(lockfile.workspaces, `${label}.workspaces`);
  const packages = dependencyMap(lockfile.packages, `${label}.packages`);

  const expectedWorkspaceKeys = manifests
    .map(({ dir }) => `packages/${dir}`)
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
    const workspaceKey = `packages/${manifest.dir}`;
    const entry = workspaces[workspaceKey];
    if (!isJsonObject(entry)) {
      throw new Error(`${label} does not register workspace ${workspaceKey}`);
    }
    const expectedEntry = expectedWorkspaceRecord(manifest);
    if (
      JSON.stringify(canonicalize(entry)) !==
      JSON.stringify(canonicalize(expectedEntry))
    ) {
      throw new Error(
        `${label} workspace ${workspaceKey} does not exactly match ${manifest.path}: locked ${JSON.stringify(canonicalize(entry))}, expected ${JSON.stringify(canonicalize(expectedEntry))}`,
      );
    }
    const resolution = packages[manifest.name];
    const expectedResolution = [
      `${manifest.name}@workspace:packages/${manifest.dir}`,
    ];
    if (JSON.stringify(resolution) !== JSON.stringify(expectedResolution)) {
      throw new Error(
        `${label} package resolution for ${manifest.name} is ${JSON.stringify(resolution)}, expected ${JSON.stringify(expectedResolution)}`,
      );
    }
  }
}

function readManifest(path: string, dir: string): WorkspaceManifest {
  const originalBytes = readFileSync(path, "utf-8");
  const parsed: unknown = JSON.parse(originalBytes);
  if (!isJsonObject(parsed)) throw new Error(`${path} must contain an object`);

  const { name, version } = parsed;
  if (name !== `@schmock/${dir}`) {
    throw new Error(`${path} has unexpected package name: ${String(name)}`);
  }
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${path} has unsupported version: ${String(version)}`);
  }

  return { dir, path, originalBytes, json: parsed, name, version };
}

function bumpVersion(version: string, bumpLevel: BumpLevel): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`unsupported version: ${version}`);

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  switch (bumpLevel) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

export function applyManifestWrites(
  writes: ManifestWrite[],
  write: ManifestWriter = atomicWrite,
  guards: SnapshotGuard[] = [],
): void {
  assertSnapshots(writes, guards);
  const touched: ManifestWrite[] = [];

  try {
    for (const manifestWrite of writes) {
      assertBytesUnchanged(manifestWrite.path, manifestWrite.originalBytes);
      write(manifestWrite.path, manifestWrite.nextBytes);
      touched.push(manifestWrite);
    }
    assertAppliedBytes(writes, guards);
  } catch (writeError) {
    const rollbackFailures: string[] = [];

    for (const manifestWrite of [...touched].reverse()) {
      try {
        if (
          readFileSync(manifestWrite.path, "utf-8") !== manifestWrite.nextBytes
        ) {
          rollbackFailures.push(
            `${manifestWrite.path} changed after this transaction wrote it`,
          );
          continue;
        }
        write(manifestWrite.path, manifestWrite.originalBytes);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        rollbackFailures.push(`${manifestWrite.path}: ${reason}`);
      }
    }

    const reason =
      writeError instanceof Error ? writeError.message : String(writeError);
    if (rollbackFailures.length > 0) {
      throw new Error(
        `release metadata write failed (${reason}); rollback was incomplete: ${rollbackFailures.join("; ")}`,
        { cause: writeError },
      );
    }

    throw new Error(
      `release metadata write failed (${reason}); restored ${touched.length} touched file(s)`,
      { cause: writeError },
    );
  }
}

function assertBytesUnchanged(path: string, expectedBytes: string): void {
  let actualBytes: string;
  try {
    actualBytes = readFileSync(path, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`stale snapshot for ${path}: ${reason}`);
  }
  if (actualBytes !== expectedBytes) {
    throw new Error(`stale snapshot for ${path}: file changed before write`);
  }
}

function assertSnapshots(
  writes: ManifestWrite[],
  guards: SnapshotGuard[],
): void {
  for (const write of writes) {
    assertBytesUnchanged(write.path, write.originalBytes);
  }
  for (const guard of guards) {
    assertBytesUnchanged(guard.path, guard.originalBytes);
  }
}

function assertAppliedBytes(
  writes: ManifestWrite[],
  guards: SnapshotGuard[],
): void {
  for (const write of writes) {
    if (readFileSync(write.path, "utf-8") !== write.nextBytes) {
      throw new Error(`${write.path} changed before transaction completion`);
    }
  }
  for (const guard of guards) {
    assertBytesUnchanged(guard.path, guard.originalBytes);
  }
}

function atomicWrite(path: string, bytes: string): void {
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

function refreshLockfile(
  lockfileBytes: string,
  currentManifests: WorkspaceManifest[],
  nextManifests: WorkspaceManifest[],
): string {
  let refreshedBytes = lockfileBytes;

  for (const current of currentManifests) {
    const next = nextManifests.find(({ dir }) => dir === current.dir);
    if (!next) throw new Error(`missing next manifest for ${current.name}`);
    const workspaceKey = `packages/${current.dir}`;
    refreshedBytes = replaceWorkspaceToken(
      refreshedBytes,
      workspaceKey,
      `"version": ${JSON.stringify(current.version)}`,
      `"version": ${JSON.stringify(next.version)}`,
    );

    const dependencyChanges = new Map<
      string,
      { after: string; count: number }
    >();
    for (const field of DEPENDENCY_FIELDS) {
      const currentDependencies = dependencyMap(
        current.json[field],
        `${current.path}.${field}`,
      );
      const nextDependencies = dependencyMap(
        next.json[field],
        `${next.path}.${field}`,
      );
      for (const [dependencyName, currentRange] of Object.entries(
        currentDependencies,
      )) {
        const nextRange = nextDependencies[dependencyName];
        if (currentRange === nextRange) continue;
        const before = `${JSON.stringify(dependencyName)}: ${JSON.stringify(currentRange)}`;
        const change = dependencyChanges.get(before);
        dependencyChanges.set(before, {
          after: `${JSON.stringify(dependencyName)}: ${JSON.stringify(nextRange)}`,
          count: (change?.count ?? 0) + 1,
        });
      }
    }
    for (const [before, { after, count }] of dependencyChanges) {
      refreshedBytes = replaceWorkspaceToken(
        refreshedBytes,
        workspaceKey,
        before,
        after,
        count,
      );
    }
  }

  validateLockfile(refreshedBytes, nextManifests, "refreshed bun.lock");
  return refreshedBytes;
}

function replaceWorkspaceToken(
  lockfileBytes: string,
  workspaceKey: string,
  before: string,
  after: string,
  expectedCount = 1,
): string {
  const marker = `${JSON.stringify(workspaceKey)}: {`;
  const markerIndex = lockfileBytes.indexOf(marker);
  if (markerIndex < 0 || lockfileBytes.indexOf(marker, markerIndex + 1) >= 0) {
    throw new Error(`bun.lock must contain exactly one ${workspaceKey} record`);
  }
  const objectStart = markerIndex + marker.length - 1;
  const objectEnd = findObjectEnd(lockfileBytes, objectStart);
  const record = lockfileBytes.slice(markerIndex, objectEnd + 1);
  const tokenCount = record.split(before).length - 1;
  if (tokenCount !== expectedCount) {
    throw new Error(
      `bun.lock workspace ${workspaceKey} must contain ${expectedCount} token(s) ${before}; found ${tokenCount}`,
    );
  }
  const nextRecord = record.replaceAll(before, after);
  return `${lockfileBytes.slice(0, markerIndex)}${nextRecord}${lockfileBytes.slice(objectEnd + 1)}`;
}

function findObjectEnd(bytes: string, objectStart: number): number {
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = objectStart; index < bytes.length; index += 1) {
    const character = bytes[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("bun.lock contains an unterminated workspace record");
}

function readReleaseState(root: string): ReleaseState {
  const packagesDir = join(root, "packages");
  const rootPackagePath = join(root, "package.json");
  const lockfilePath = join(root, "bun.lock");
  if (!existsSync(rootPackagePath) || !existsSync(packagesDir)) {
    throw new Error(`${root} is not a Schmock workspace root`);
  }
  if (!existsSync(lockfilePath)) {
    throw new Error(`${root} does not contain bun.lock`);
  }

  const actualPackages = readdirSync(packagesDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(packagesDir, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort();
  const expectedPackages = [...EXPECTED_PACKAGES].sort();
  if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages)) {
    throw new Error(
      `expected exactly ${EXPECTED_PACKAGES.length} workspaces (${expectedPackages.join(", ")}); found ${actualPackages.join(", ")}`,
    );
  }

  const manifests = EXPECTED_PACKAGES.map((dir) =>
    readManifest(join(packagesDir, dir, "package.json"), dir),
  );
  const version = manifests[0].version;
  for (const manifest of manifests) {
    if (manifest.version !== version) {
      throw new Error(
        `workspace versions are not synchronized (${manifest.name} is ${manifest.version}, expected ${version})`,
      );
    }
  }

  const lockfileBytes = readFileSync(lockfilePath, "utf-8");
  validateLockfile(lockfileBytes, manifests, "bun.lock");
  return {
    lockfileBytes,
    lockfilePath,
    manifests,
    rootPackageBytes: readFileSync(rootPackagePath, "utf-8"),
    rootPackagePath,
    version,
  };
}

export function verifyReleaseLockfile(root: string): string {
  return readReleaseState(resolve(root)).version;
}

function main(): void {
  const levelArg = process.argv[2];
  const defaultRoot = join(import.meta.dir, "../../../..");
  const root = resolve(process.env.SCHMOCK_ROOT ?? defaultRoot);

  if (levelArg === "check-lockfile") {
    if (process.argv.length > 3) {
      fail(`unexpected argument: ${process.argv[3]}`);
    }
    const version = verifyReleaseLockfile(root);
    console.log(
      `bun.lock matches all ${EXPECTED_PACKAGES.length} workspace manifests at ${version}.`,
    );
    return;
  }
  if (levelArg !== "patch" && levelArg !== "minor" && levelArg !== "major") {
    fail(
      "usage: bun bump.ts check-lockfile | patch|minor|major [--dry-run|--apply]",
    );
  }
  const level: BumpLevel = levelArg;

  const mode = process.argv[3] ?? "--dry-run";
  if (mode !== "--dry-run" && mode !== "--apply") {
    fail("mode must be --dry-run or --apply");
  }
  if (process.argv.length > 4) fail(`unexpected argument: ${process.argv[4]}`);

  const {
    lockfileBytes,
    lockfilePath,
    manifests,
    rootPackageBytes,
    rootPackagePath,
    version: currentVersion,
  } = readReleaseState(root);

  const nextVersion = bumpVersion(currentVersion, level);
  let dependenciesUpdated = 0;
  const nextManifests = manifests.map((manifest) => {
    const nextJson = structuredClone(manifest.json);
    nextJson.version = nextVersion;
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = nextJson[field];
      if (!isJsonObject(dependencies)) continue;

      for (const dependencyName of Object.keys(dependencies)) {
        if (!dependencyName.startsWith("@schmock/")) continue;
        if (!manifests.some(({ name }) => name === dependencyName)) continue;

        const nextRange = `^${nextVersion}`;
        if (dependencies[dependencyName] !== nextRange) {
          dependencies[dependencyName] = nextRange;
          dependenciesUpdated++;
        }
      }
    }
    return { ...manifest, json: nextJson, version: nextVersion };
  });

  const modeLabel = mode === "--apply" ? "APPLY" : "DRY RUN";
  console.log(
    `${modeLabel}: ${level} bump for ${manifests.length} workspaces (${currentVersion} -> ${nextVersion})\n`,
  );
  console.log("Package                  Before    After");
  console.log("───────────────────────  ────────  ────────");
  for (const manifest of manifests) {
    console.log(
      `${manifest.name.padEnd(23)}  ${manifest.version.padEnd(8)}  ${nextVersion}`,
    );
  }
  console.log(
    `\nCross-workspace dependency ranges to update: ${dependenciesUpdated}`,
  );

  const nextLockfileBytes = refreshLockfile(
    lockfileBytes,
    manifests,
    nextManifests,
  );
  console.log("bun.lock: exact workspace records refreshed and validated");

  if (mode === "--dry-run") {
    console.log(
      "No files written. Re-run with --apply only after explicit approval.",
    );
    return;
  }

  const writes = [
    ...nextManifests.map((manifest) => ({
      path: manifest.path,
      originalBytes: manifest.originalBytes,
      nextBytes: `${JSON.stringify(manifest.json, null, 2)}\n`,
    })),
    {
      path: lockfilePath,
      originalBytes: lockfileBytes,
      nextBytes: nextLockfileBytes,
    },
  ];

  try {
    applyManifestWrites(writes, atomicWrite, [
      { path: rootPackagePath, originalBytes: rootPackageBytes },
    ]);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(
    `Updated ${manifests.length} workspace manifests and bun.lock transactionally.`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
