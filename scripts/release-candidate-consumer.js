import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const angularCompilerSpecifier = "@angular/compiler";
const reactSpecifier = "react";
await import(angularCompilerSpecifier);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
for (const [name, value] of Object.entries({
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  window: dom.window,
})) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

process.stdout.write(
  "[react-context 1/1] Checking root/testing context identity\n",
);
const { createElement } = await import(reactSpecifier);
const { useSchmock } = await import("@schmock/react");
const { renderWithSchmock } = await import("@schmock/react/testing");
const contextMock = schmock();
const savedFetch = globalThis.fetch;
let observedMock;
let rendered;

function ContextConsumer() {
  observedMock = useSchmock();
  return null;
}

try {
  rendered = renderWithSchmock(createElement(ContextConsumer), {
    mock: contextMock,
  });
  assert.strictEqual(
    observedMock,
    contextMock,
    "@schmock/react/testing did not provide the @schmock/react context",
  );
} finally {
  rendered?.unmount();
  globalThis.fetch = savedFetch;
}

const cli = spawnSync(resolve("node_modules/.bin/schmock"), ["--help"], {
  encoding: "utf8",
});
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.match(`${cli.stdout}${cli.stderr}`, /Usage: schmock/);

dom.window.close();

process.stdout.write(
  `Imported and exercised all ${candidates.length} release candidates\n`,
);
