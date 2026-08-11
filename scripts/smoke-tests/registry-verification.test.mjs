#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SMOKE_RUNNER = join(ROOT_DIR, "scripts/smoke-tests/run-all.sh");
const CONSUMER_RUNNER = join(ROOT_DIR, "scripts/integration-tests/run-all.sh");
const REGISTRY_HELPER = join(
  ROOT_DIR,
  "scripts/smoke-tests/registry-fixture.mjs",
);
const WORKFLOW = join(ROOT_DIR, ".github/workflows/registry-verification.yml");
const FAKER_FIXTURE = join(
  ROOT_DIR,
  "scripts/smoke-tests/fixtures/faker/package.json",
);
const SMOKE_FIXTURES = join(ROOT_DIR, "scripts/smoke-tests/fixtures");
const CONSUMER_FIXTURES = join(ROOT_DIR, "scripts/integration-tests/fixtures");

function run(command, args, env = {}) {
  return spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function makeFakeBun(workdir) {
  const binDir = join(workdir, "bin");
  const marker = join(workdir, "bun-was-called");
  mkdirSync(binDir);
  const executable = join(binDir, "bun");
  writeFileSync(
    executable,
    '#!/usr/bin/env bash\nprintf "called\\n" >> "$BUN_MARKER"\nexit 97\n',
  );
  chmodSync(executable, 0o755);
  return {
    marker,
    env: {
      BUN_MARKER: marker,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  };
}

function fixtureNames(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function makeFixtureTree(names) {
  const directory = mkdtempSync(join(tmpdir(), "schmock-registry-fixtures-"));
  for (const name of names) mkdirSync(join(directory, name));
  return directory;
}

test("release tags and dispatch inputs resolve to an injection-safe exact version", () => {
  const release = run("node", [REGISTRY_HELPER, "resolve-version"], {
    GITHUB_EVENT_NAME: "release",
    RELEASE_TAG: "v2.3.0",
  });
  assert.equal(release.status, 0, output(release));
  assert.equal(release.stdout.trim(), "2.3.0");

  const dispatch = run("node", [REGISTRY_HELPER, "resolve-version"], {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    DISPATCH_VERSION: "2.4.0-beta.1",
  });
  assert.equal(dispatch.status, 0, output(dispatch));
  assert.equal(dispatch.stdout.trim(), "2.4.0-beta.1");

  const injection = run("node", [REGISTRY_HELPER, "resolve-version"], {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    DISPATCH_VERSION: "2.3.0\nEVIL=value",
  });
  assert.notEqual(injection.status, 0);
  assert.match(output(injection), /valid exact semantic version/i);
});

test("rewriting a copied fixture pins every @schmock dependency without touching its source", () => {
  const workdir = mkdtempSync(join(tmpdir(), "schmock-registry-rewrite-"));
  const copiedManifest = join(workdir, "package.json");
  const sourceBefore = readFileSync(FAKER_FIXTURE, "utf8");
  copyFileSync(FAKER_FIXTURE, copiedManifest);

  try {
    const result = run("node", [
      REGISTRY_HELPER,
      "pin-manifest",
      workdir,
      copiedManifest,
      "9.8.7",
    ]);
    assert.equal(result.status, 0, output(result));

    const rewritten = JSON.parse(readFileSync(copiedManifest, "utf8"));
    assert.equal(rewritten.dependencies["@schmock/core"], "9.8.7");
    assert.equal(rewritten.dependencies["@schmock/faker"], "9.8.7");
    assert.equal(rewritten.overrides["@schmock/openapi"], "9.8.7");
    assert.equal(readFileSync(FAKER_FIXTURE, "utf8"), sourceBefore);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("pin-manifest rejects paths outside its real temp root and all workspace paths", () => {
  const allowedRoot = mkdtempSync(join(tmpdir(), "schmock-registry-allowed-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "schmock-registry-outside-"));
  const outsideManifest = join(outsideRoot, "package.json");
  const linkedManifest = join(allowedRoot, "linked-package.json");
  const sourceBefore = readFileSync(FAKER_FIXTURE, "utf8");
  copyFileSync(FAKER_FIXTURE, outsideManifest);
  symlinkSync(FAKER_FIXTURE, linkedManifest);

  try {
    const outside = run("node", [
      REGISTRY_HELPER,
      "pin-manifest",
      allowedRoot,
      outsideManifest,
      "9.8.7",
    ]);
    assert.notEqual(outside.status, 0);
    assert.match(output(outside), /outside the explicit temp root/i);

    const linkedSource = run("node", [
      REGISTRY_HELPER,
      "pin-manifest",
      allowedRoot,
      linkedManifest,
      "9.8.7",
    ]);
    assert.notEqual(linkedSource.status, 0);
    assert.match(output(linkedSource), /workspace path/i);

    const workspace = run("node", [
      REGISTRY_HELPER,
      "pin-manifest",
      ROOT_DIR,
      FAKER_FIXTURE,
      "9.8.7",
    ]);
    assert.notEqual(workspace.status, 0);
    assert.match(output(workspace), /workspace path/i);
    assert.equal(readFileSync(FAKER_FIXTURE, "utf8"), sourceBefore);
  } finally {
    rmSync(allowedRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("containment treats dot-prefixed child names as children", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "schmock-registry-containment-"));
  const dotData = join(tempRoot, "..data");
  const acceptedManifest = join(dotData, "package.json");
  const workspaceScratch = mkdtempSync(join(ROOT_DIR, "..scratch-"));
  const rejectedManifest = join(workspaceScratch, "package.json");
  mkdirSync(dotData);
  copyFileSync(FAKER_FIXTURE, acceptedManifest);
  copyFileSync(FAKER_FIXTURE, rejectedManifest);

  try {
    const accepted = run("node", [
      REGISTRY_HELPER,
      "pin-manifest",
      tempRoot,
      acceptedManifest,
      "9.8.7",
    ]);
    assert.equal(accepted.status, 0, output(accepted));

    const workspace = run("node", [
      REGISTRY_HELPER,
      "pin-manifest",
      workspaceScratch,
      rejectedManifest,
      "9.8.7",
    ]);
    assert.notEqual(workspace.status, 0);
    assert.match(output(workspace), /workspace path/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(workspaceScratch, { recursive: true, force: true });
  }
});

test("fixture completeness validates discovered workspace and curated suite sets", () => {
  for (const [suite, directory] of [
    ["smoke", SMOKE_FIXTURES],
    ["consumer", CONSUMER_FIXTURES],
  ]) {
    const complete = run("node", [
      REGISTRY_HELPER,
      "validate-fixtures",
      suite,
      directory,
    ]);
    assert.equal(complete.status, 0, output(complete));
  }

  const missingSmoke = makeFixtureTree(
    fixtureNames(SMOKE_FIXTURES).filter((name) => name !== "faker"),
  );
  const missingConsumer = makeFixtureTree(
    fixtureNames(CONSUMER_FIXTURES).filter(
      (name) => name !== "testing-patterns",
    ),
  );
  const extraConsumer = makeFixtureTree([
    ...fixtureNames(CONSUMER_FIXTURES),
    "unreviewed-fixture",
  ]);
  try {
    const smoke = run("node", [
      REGISTRY_HELPER,
      "validate-fixtures",
      "smoke",
      missingSmoke,
    ]);
    assert.notEqual(smoke.status, 0);
    assert.match(output(smoke), /missing: faker/i);

    const consumer = run("node", [
      REGISTRY_HELPER,
      "validate-fixtures",
      "consumer",
      missingConsumer,
    ]);
    assert.notEqual(consumer.status, 0);
    assert.match(output(consumer), /missing: testing-patterns/i);

    const extra = run("node", [
      REGISTRY_HELPER,
      "validate-fixtures",
      "consumer",
      extraConsumer,
    ]);
    assert.notEqual(extra.status, 0);
    assert.match(output(extra), /unexpected: unreviewed-fixture/i);
  } finally {
    rmSync(missingSmoke, { recursive: true, force: true });
    rmSync(missingConsumer, { recursive: true, force: true });
    rmSync(extraConsumer, { recursive: true, force: true });
  }
});

test("smoke dry-run uses exact copied dependencies and never invokes bun", () => {
  const workdir = mkdtempSync(join(tmpdir(), "schmock-registry-smoke-"));
  const fakeBun = makeFakeBun(workdir);
  const sourceBefore = readFileSync(FAKER_FIXTURE, "utf8");

  try {
    const result = run("bash", [SMOKE_RUNNER, "--dry-run", "--", "faker"], {
      ...fakeBun.env,
      SCHMOCK_VERSION: "9.8.7",
    });
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /@schmock\/core: 9\.8\.7/);
    assert.match(output(result), /@schmock\/faker: 9\.8\.7/);
    assert.equal(existsSync(fakeBun.marker), false, output(result));
    assert.equal(readFileSync(FAKER_FIXTURE, "utf8"), sourceBefore);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("the option terminator keeps a package filter from enabling dry-run", () => {
  const workdir = mkdtempSync(join(tmpdir(), "schmock-registry-options-"));
  const fakeBun = makeFakeBun(workdir);

  try {
    const result = run("bash", [SMOKE_RUNNER, "--", "--dry-run"], {
      ...fakeBun.env,
      SCHMOCK_VERSION: "9.8.7",
    });
    assert.notEqual(result.status, 0);
    assert.match(output(result), /invalid package filter '--dry-run'/i);
    assert.doesNotMatch(output(result), /DRY RUN PASS/);
    assert.equal(existsSync(fakeBun.marker), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("suite-aware filters skip only a suite with no applicable fixture", () => {
  const workdir = mkdtempSync(join(tmpdir(), "schmock-registry-filter-"));
  const fakeBun = makeFakeBun(workdir);

  try {
    const skipped = run("bash", [CONSUMER_RUNNER, "--dry-run", "faker"], {
      ...fakeBun.env,
      SCHMOCK_VERSION: "9.8.7",
    });
    assert.equal(skipped.status, 0, output(skipped));
    assert.match(
      output(skipped),
      /SKIP: no consumer fixtures apply to the requested package filter: faker/,
    );

    const partlyApplicable = run(
      "bash",
      [CONSUMER_RUNNER, "--dry-run", "faker", "core"],
      {
        ...fakeBun.env,
        SCHMOCK_VERSION: "9.8.7",
      },
    );
    assert.equal(partlyApplicable.status, 0, output(partlyApplicable));
    assert.doesNotMatch(output(partlyApplicable), /SKIP:/);
    assert.match(output(partlyApplicable), /@schmock\/core: 9\.8\.7/);
    assert.equal(existsSync(fakeBun.marker), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("an unknown filter refuses an all-suites no-op before install", () => {
  const workdir = mkdtempSync(join(tmpdir(), "schmock-registry-noop-"));
  const fakeBun = makeFakeBun(workdir);

  try {
    const result = run("bash", [SMOKE_RUNNER, "--dry-run", "not-a-fixture"], {
      ...fakeBun.env,
      SCHMOCK_VERSION: "9.8.7",
    });
    assert.notEqual(result.status, 0);
    assert.match(output(result), /refusing an all-suites no-op/i);
    assert.equal(existsSync(fakeBun.marker), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("registry workflow requires a dispatch version and passes safe env values", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /version:\s*\n\s+description:.*\n\s+required: true/);
  assert.match(
    workflow,
    /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/,
  );
  assert.match(workflow, /SCHMOCK_VERSION/);
  assert.equal(
    workflow.match(/run-all\.sh -- "\$\{packages\[@\]\}"/g)?.length,
    2,
  );
  assert.doesNotMatch(workflow, /run-all\.sh \$PACKAGES/);
});
