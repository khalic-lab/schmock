/**
 * The meta-only release-candidate consumer.
 *
 * check-release-candidate.sh installs the packed @schmock/schmock tarball on
 * its own into a second fixture, with every @schmock/* package it depends on
 * overridden to that package's packed tarball, and runs this file there. The
 * main consumer lists every package as a direct dependency, so a re-export the
 * meta-package claims but cannot resolve by itself still resolves there
 * through the consumer's own node_modules.
 *
 * Installing it alone does not make resolution strict: `bun install --linker
 * isolated` also writes a hoisted fallback at node_modules/.bun/node_modules,
 * and Node's and TypeScript's resolution reach it from inside the
 * meta-package. A @schmock/* package the meta-package imports without
 * declaring would still load there whenever another package pulls it in. So
 * this file reads the meta-package's own files and fails on any @schmock/*
 * specifier its manifest does not declare, then checks that each declared one
 * resolves to the candidate, and that the names it re-exports load and
 * type-check (a name core no longer exports, a declaration that points
 * nowhere).
 *
 * The names are the ones packages/schmock/src/index.ts documents re-exporting;
 * scripts/repo-tooling.test.mjs fails when the two lists drift apart.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const META_PACKAGE = "@schmock/schmock";
const DOCUMENTED_EXPORTS = [
  "badRequest",
  "created",
  "forbidden",
  "noContent",
  "notFound",
  "paginate",
  "schmock",
  "serverError",
  "unauthorized",
];

const require = createRequire(import.meta.url);
const tscBin = process.env.TSC_BIN;
assert(tscBin, "TSC_BIN was not provided");

const candidateVersions = new Map(
  readFileSync("candidates.tsv", "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, version] = line.split("\t");
      assert(name && version, `Candidate line is incomplete: ${line}`);
      return [name, version];
    }),
);

process.stdout.write(`[meta 1/4] ${META_PACKAGE} is installed on its own\n`);
const fixtureManifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.deepEqual(
  Object.keys(fixtureManifest.dependencies ?? {}),
  [META_PACKAGE],
  `The meta-only fixture must depend on ${META_PACKAGE} alone`,
);
// Without the overrides, the meta-package's own @schmock/* dependencies come
// from the registry, and a registry release with the candidate's version
// passes every version check below.
for (const name of candidateVersions.keys()) {
  const override = fixtureManifest.overrides?.[name];
  assert(
    typeof override === "string" && override.startsWith("file:"),
    `The meta-only fixture does not override ${name} to its packed tarball`,
  );
}

const metaManifestPath = require.resolve(`${META_PACKAGE}/package.json`);
const metaManifest = JSON.parse(readFileSync(metaManifestPath, "utf8"));
assert.equal(
  metaManifest.version,
  candidateVersions.get(META_PACKAGE),
  `${META_PACKAGE} version mismatch`,
);

// The meta-package may import only the @schmock/* packages it declares. The
// install cannot enforce that (see the docblock), so read every module and
// declaration file it ships. Comments are stripped first: the docblock
// quotes imports from other packages as usage examples.
const metaDir = dirname(metaManifestPath);
const SHIPPED_MODULE = /\.(?:[cm]?js|d\.[cm]?ts)$/;
const SCHMOCK_SPECIFIER =
  /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*["'](@schmock\/[^"'/]+)/g;
function shippedModules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : shippedModules(path);
    }
    return SHIPPED_MODULE.test(entry.name) ? [path] : [];
  });
}
const declaredDependencies = new Set(
  Object.keys(metaManifest.dependencies ?? {}),
);
for (const file of shippedModules(metaDir)) {
  const code = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const [, specifier] of code.matchAll(SCHMOCK_SPECIFIER)) {
    if (specifier === META_PACKAGE) continue;
    assert(
      declaredDependencies.has(specifier),
      `${META_PACKAGE} imports ${specifier} in ${file.slice(metaDir.length + 1)} ` +
        "but does not declare it as a dependency",
    );
  }
}

// Every declared @schmock/* dependency must resolve from the meta-package
// itself, to the packed candidate (not a registry release the override
// missed), and must not be reachable from the fixture root, which would mean
// the fixture is not meta-only.
const metaRequire = createRequire(metaManifestPath);
for (const dependency of Object.keys(metaManifest.dependencies ?? {})) {
  const expectedVersion = candidateVersions.get(dependency);
  if (expectedVersion === undefined) continue;

  let installedPath;
  try {
    installedPath = metaRequire.resolve(`${dependency}/package.json`);
  } catch (error) {
    throw new Error(
      `${META_PACKAGE} cannot resolve its dependency ${dependency}`,
      { cause: error },
    );
  }
  assert.equal(
    JSON.parse(readFileSync(installedPath, "utf8")).version,
    expectedVersion,
    `${META_PACKAGE} resolved ${dependency} to a version other than the candidate`,
  );
  assert.throws(
    () => require.resolve(`${dependency}/package.json`),
    { code: "MODULE_NOT_FOUND" },
    `${dependency} is resolvable from the meta-only fixture root, so this ` +
      "check cannot tell whether the meta-package resolves it on its own",
  );
}

process.stdout.write(
  `[meta 2/4] Importing every documented ${META_PACKAGE} re-export\n`,
);
let namespace;
try {
  namespace = await import(META_PACKAGE);
} catch (error) {
  throw new Error(`${META_PACKAGE} does not load on its own`, {
    cause: error,
  });
}
for (const name of DOCUMENTED_EXPORTS) {
  assert.equal(
    typeof namespace[name],
    "function",
    `${META_PACKAGE} does not re-export ${name}`,
  );
}
assert.deepEqual(
  Object.keys(namespace).sort(),
  [...DOCUMENTED_EXPORTS].sort(),
  `${META_PACKAGE} exports names its documentation does not list`,
);

process.stdout.write("[meta 3/4] Handling a request through the re-exports\n");
const mock = namespace.schmock();
mock("GET /release-candidate", { ok: true });
mock("GET /missing", () => namespace.notFound());
const found = await mock.handle("GET", "/release-candidate");
assert.equal(found.status, 200);
assert.deepEqual(found.body, { ok: true });
const missing = await mock.handle("GET", "/missing");
assert.equal(missing.status, 404);

process.stdout.write(
  `[meta 4/4] Type-checking every documented ${META_PACKAGE} re-export\n`,
);
const fixtureDir = resolve("meta-types-fixture");
mkdirSync(fixtureDir, { recursive: true });
// Its own manifest, so NodeNext reads entry.ts as an ES module whatever the
// fixture's manifest says.
writeFileSync(
  resolve(fixtureDir, "package.json"),
  `${JSON.stringify({ private: true, type: "module" })}\n`,
);
writeFileSync(
  resolve(fixtureDir, "entry.ts"),
  `import { ${DOCUMENTED_EXPORTS.join(", ")} } from ${JSON.stringify(META_PACKAGE)};\n` +
    `const reexports: readonly ((...args: never[]) => unknown)[] = [${DOCUMENTED_EXPORTS.join(", ")}];\n` +
    "void reexports;\n",
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
        types: [],
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
    `The documented ${META_PACKAGE} re-exports do not type-check on their own`,
  );
}

process.stdout.write(
  `${META_PACKAGE} resolves and type-checks all ${DOCUMENTED_EXPORTS.length} documented re-exports on its own\n`,
);
