import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const angularCompilerSpecifier = "@angular/compiler";
await import(angularCompilerSpecifier);

const candidates = readFileSync("candidates.tsv", "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [name, version] = line.split("\t");
    assert(name, `Candidate line has no package name: ${line}`);
    assert(version, `Candidate line has no package version: ${line}`);
    return { name, version };
  });

assert(candidates.length > 0, "No release candidates were supplied");

const fixtureManifest = JSON.parse(readFileSync("package.json", "utf8"));
const expectedExports = new Map([
  ["@schmock/angular", ["createSchmockInterceptor"]],
  ["@schmock/cli", ["createCliServer", "parseCliArgs"]],
  ["@schmock/core", ["schmock"]],
  ["@schmock/express", ["toExpress"]],
  ["@schmock/faker", ["fakerPlugin"]],
  ["@schmock/openapi", ["openapi"]],
  ["@schmock/query", ["queryPlugin"]],
  ["@schmock/react", ["SchmockProvider", "useSchmock"]],
  ["@schmock/schmock", ["schmock"]],
  ["@schmock/validation", ["validationPlugin"]],
  ["@schmock/vue", ["schmockPlugin", "useSchmock"]],
]);

for (const [index, candidate] of candidates.entries()) {
  const step = index + 1;
  process.stdout.write(
    `[import ${step}/${candidates.length}] ${candidate.name}\n`,
  );

  const dependency = fixtureManifest.dependencies?.[candidate.name];
  assert(
    dependency,
    `${candidate.name} was not installed as a direct candidate dependency`,
  );

  const manifestPath = require.resolve(`${candidate.name}/package.json`);
  const installedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(
    installedManifest.version,
    candidate.version,
    `${candidate.name} version mismatch`,
  );

  const exportMap = installedManifest.exports;
  const subpaths =
    exportMap && typeof exportMap === "object" && !Array.isArray(exportMap)
      ? Object.keys(exportMap).filter((subpath) => subpath !== "./package.json")
      : ["."];

  for (const subpath of subpaths) {
    const specifier =
      subpath === "." ? candidate.name : `${candidate.name}${subpath.slice(1)}`;
    const namespace = await import(specifier);
    assert(
      Object.keys(namespace).length > 0,
      `${specifier} imported without any runtime exports`,
    );

    if (subpath === ".") {
      for (const expectedExport of expectedExports.get(candidate.name) ?? []) {
        assert(
          expectedExport in namespace,
          `${candidate.name} does not export ${expectedExport}`,
        );
      }
    }
  }
}

const { schmock } = await import("@schmock/core");
const mock = schmock();
mock("GET /release-candidate", { ok: true });
const response = await mock.handle("GET", "/release-candidate");
assert.equal(response.status, 200);
assert.deepEqual(response.body, { ok: true });

const cli = spawnSync(resolve("node_modules/.bin/schmock"), ["--help"], {
  encoding: "utf8",
});
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.match(`${cli.stdout}${cli.stderr}`, /Usage: schmock/);

process.stdout.write(
  `Imported and exercised all ${candidates.length} release candidates\n`,
);
