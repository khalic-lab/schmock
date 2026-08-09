import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(rootDir, "packages");
const tscBin = join(rootDir, "node_modules", ".bin", "tsc");
const sentinelName = ".stale-build-artifact";

function discoverPackages() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(packagesDir, entry.name);
      const manifestPath = join(directory, "package.json");
      if (!existsSync(manifestPath)) return undefined;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return { directory, manifest, shortName: entry.name };
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.manifest.name.localeCompare(right.manifest.name),
    );
}

function validatePackageBuilds(packages) {
  for (const [index, pkg] of packages.entries()) {
    process.stdout.write(
      `[config ${index + 1}/${packages.length}] ${pkg.manifest.name}\n`,
    );

    if (!pkg.manifest.scripts?.build?.startsWith("bun run clean &&")) {
      throw new Error(
        `${pkg.manifest.name} build does not start with its clean script`,
      );
    }

    const result = spawnSync(tscBin, ["--showConfig", "-p", pkg.directory], {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      throw new Error(
        `Could not resolve TypeScript config for ${pkg.manifest.name}`,
      );
    }

    const config = JSON.parse(result.stdout);
    if (config.compilerOptions?.declaration !== true) {
      throw new Error(`${pkg.manifest.name} does not emit declarations`);
    }
    if (config.compilerOptions?.emitDeclarationOnly !== true) {
      throw new Error(
        `${pkg.manifest.name} type build can emit runtime JavaScript`,
      );
    }
  }
}

function seedStaleArtifacts(packages) {
  for (const pkg of packages) {
    const distDir = join(pkg.directory, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, sentinelName),
      "must be removed by package build\n",
    );
  }
}

function assertStaleArtifactsRemoved(packages) {
  for (const pkg of packages) {
    if (existsSync(join(pkg.directory, "dist", sentinelName))) {
      throw new Error(`${pkg.manifest.name} retained a stale dist artifact`);
    }
  }
}

function runBuild(label) {
  process.stdout.write(`[build ${label}] Building every workspace\n`);
  const result = spawnSync("bun", ["run", "build"], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `The ${label} workspace build failed with status ${result.status}`,
    );
  }
}

function collectDeclaredTargets(value, targets) {
  if (typeof value === "string") {
    if (value.startsWith("./dist/")) targets.add(value.slice(2));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectDeclaredTargets(entry, targets);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectDeclaredTargets(entry, targets);
    }
  }
}

function assertDeclaredTargets(packages) {
  for (const pkg of packages) {
    const targets = new Set();
    collectDeclaredTargets(pkg.manifest.main, targets);
    collectDeclaredTargets(pkg.manifest.types, targets);
    collectDeclaredTargets(pkg.manifest.bin, targets);
    collectDeclaredTargets(pkg.manifest.exports, targets);

    for (const target of targets) {
      if (!existsSync(join(pkg.directory, target))) {
        throw new Error(
          `${pkg.manifest.name} is missing declared target ${target}`,
        );
      }
    }
  }
}

function snapshotDirectory(directory, packageName, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      snapshotDirectory(absolutePath, packageName, output);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported build artifact: ${absolutePath}`);
    }

    const stat = lstatSync(absolutePath);
    const key = `${packageName}/${relative(join(packagesDir, packageName, "dist"), absolutePath)}`;
    output.set(key, {
      hash: createHash("sha256")
        .update(readFileSync(absolutePath))
        .digest("hex"),
      mode: stat.mode & 0o777,
    });
  }
}

function snapshotBuild(packages) {
  const output = new Map();
  for (const pkg of packages) {
    const distDir = join(pkg.directory, "dist");
    if (!existsSync(distDir)) {
      throw new Error(`${pkg.manifest.name} did not create dist`);
    }
    snapshotDirectory(distDir, pkg.shortName, output);
  }
  return output;
}

function compareSnapshots(first, second) {
  const keys = [...new Set([...first.keys(), ...second.keys()])].sort();
  const differences = [];
  for (const key of keys) {
    const left = first.get(key);
    const right = second.get(key);
    if (!left) differences.push(`added on second build: ${key}`);
    else if (!right) differences.push(`missing on second build: ${key}`);
    else if (left.hash !== right.hash || left.mode !== right.mode) {
      differences.push(`changed on second build: ${key}`);
    }
  }

  if (differences.length > 0) {
    throw new Error(
      `Fresh and repeated builds differ:\n${differences.map((item) => `- ${item}`).join("\n")}`,
    );
  }
}

try {
  const packages = discoverPackages();
  if (packages.length === 0)
    throw new Error("No workspace packages discovered");

  validatePackageBuilds(packages);

  seedStaleArtifacts(packages);
  runBuild("1/2");
  assertStaleArtifactsRemoved(packages);
  assertDeclaredTargets(packages);
  const first = snapshotBuild(packages);
  process.stdout.write(`[snapshot 1/2] Recorded ${first.size} artifacts\n`);

  seedStaleArtifacts(packages);
  runBuild("2/2");
  assertStaleArtifactsRemoved(packages);
  assertDeclaredTargets(packages);
  const second = snapshotBuild(packages);
  process.stdout.write(`[snapshot 2/2] Recorded ${second.size} artifacts\n`);

  compareSnapshots(first, second);
  process.stdout.write(
    `Build reproducibility verified for ${packages.length} packages\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
