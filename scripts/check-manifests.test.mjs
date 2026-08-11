#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages that include the CLI declare Faker's Node engine range", () => {
  const requireFromFaker = createRequire(
    resolve(ROOT_DIR, "packages/faker/package.json"),
  );
  const fakerManifestPath = requireFromFaker.resolve(
    "@faker-js/faker/package.json",
  );
  const fakerManifest = JSON.parse(readFileSync(fakerManifestPath, "utf8"));

  for (const packageName of ["cli", "schmock"]) {
    const manifest = JSON.parse(
      readFileSync(
        resolve(ROOT_DIR, `packages/${packageName}/package.json`),
        "utf8",
      ),
    );
    assert.equal(manifest.engines?.node, fakerManifest.engines?.node);
  }

  const gettingStarted = readFileSync(
    resolve(ROOT_DIR, "docs/getting-started.md"),
    "utf8",
  );
  assert.ok(gettingStarted.includes(`\`${fakerManifest.engines.node}\``));
});
