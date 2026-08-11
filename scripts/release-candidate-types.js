import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const tscBin = process.env.TSC_BIN;
assert(tscBin, "TSC_BIN was not provided");

const candidates = readFileSync("candidates.tsv", "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [name] = line.split("\t");
    assert(name, `Candidate line has no package name: ${line}`);
    return name;
  });

function hasTypesTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.types === "string") return true;
  return Object.values(value).some(hasTypesTarget);
}

const entries = [];
const packageDirectories = new Map();
const candidatesWithTypes = new Set();
for (const candidate of candidates) {
  const manifestPath = require.resolve(`${candidate}/package.json`);
  packageDirectories.set(candidate, dirname(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const exportMap = manifest.exports;

  if (exportMap && typeof exportMap === "object" && !Array.isArray(exportMap)) {
    for (const [subpath, target] of Object.entries(exportMap)) {
      const hasTypes =
        hasTypesTarget(target) ||
        (subpath === "." && typeof manifest.types === "string");
      if (subpath === "./package.json" || !hasTypes) continue;
      entries.push({
        packageName: candidate,
        specifier:
          subpath === "." ? candidate : `${candidate}${subpath.slice(1)}`,
      });
      candidatesWithTypes.add(candidate);
    }
    continue;
  }

  if (typeof manifest.types === "string") {
    entries.push({ packageName: candidate, specifier: candidate });
    candidatesWithTypes.add(candidate);
  }
}

assert(
  entries.length > 0,
  "No declaration-bearing candidate entries discovered",
);
for (const candidate of candidates) {
  assert(
    candidatesWithTypes.has(candidate),
    `No declaration-bearing public entry discovered for ${candidate}`,
  );
}

const nodeTypePackages = new Set(["@schmock/cli", "@schmock/express"]);
const fixturesRoot = resolve("types-fixtures");
mkdirSync(fixturesRoot, { recursive: true });

function declarationFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...declarationFiles(path));
    else if (path.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

const browserPackages = candidates.filter(
  (candidate) => !nodeTypePackages.has(candidate),
);
const nodeModules = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) => `node:${specifier}`),
]);
for (const [index, packageName] of browserPackages.entries()) {
  process.stdout.write(
    `[browser-types ${index + 1}/${browserPackages.length}] ${packageName}\n`,
  );
  const packageDirectory = packageDirectories.get(packageName);
  assert(packageDirectory, `No installed directory found for ${packageName}`);

  for (const declarationPath of declarationFiles(
    resolve(packageDirectory, "dist"),
  )) {
    const source = readFileSync(declarationPath, "utf8");
    const referencesNodeTypes =
      /^\s*\/\/\/\s*<reference\s+types=["']node["']/m.test(source);
    const declaration = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const importsNodeModule = [
      ...declaration.matchAll(
        /(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g,
      ),
    ].some((match) => nodeModules.has(match[1]));
    if (
      referencesNodeTypes ||
      importsNodeModule ||
      /\b(?:Buffer|NodeJS\.)\b/.test(declaration)
    ) {
      throw new Error(
        `${packageName} exposes a Node-only type through ${declarationPath}`,
      );
    }
  }
}

for (const [index, entry] of entries.entries()) {
  process.stdout.write(
    `[types ${index + 1}/${entries.length}] ${entry.specifier}\n`,
  );

  const fixtureDir = resolve(fixturesRoot, String(index + 1));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    resolve(fixtureDir, "entry.ts"),
    `import * as candidate from ${JSON.stringify(entry.specifier)};\nvoid candidate;\n`,
  );
  writeFileSync(
    resolve(fixtureDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: nodeTypePackages.has(entry.packageName) ? ["node"] : [],
          verbatimModuleSyntax: true,
        },
        files: ["entry.ts"],
      },
      null,
      2,
    )}\n`,
  );

  const result = spawnSync(tscBin, ["--project", "tsconfig.json"], {
    cwd: fixtureDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Standalone declaration compilation failed for ${entry.specifier}`,
    );
  }
}

process.stdout.write(
  `Standalone declarations compiled for all ${entries.length} public entries\n`,
);
