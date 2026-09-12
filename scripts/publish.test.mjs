import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

/**
 * `scripts/publish.sh` is the `bun run publish` entry point. It must never
 * publish, push, or tag on its own, so these tests drive it against a fixture
 * workspace with every external command stubbed and assert on the command log.
 */

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "publish.sh");
const VERSION = "9.9.9";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

let fixtureRoot = "";
let binDir = "";
let commandLog = "";
let guardedScript = "";

function writeStub(name, body) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function run(args = [], extraEnv = {}) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SCHMOCK_ROOT: fixtureRoot,
      SCHMOCK_PUBLISH_SCRIPT: guardedScript,
      SCHMOCK_TEST_COMMAND_LOG: commandLog,
      SCHMOCK_TEST_DIRTY: "",
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

function commands() {
  return existsSync(commandLog) ? readFileSync(commandLog, "utf-8") : "";
}

describe("scripts/publish.sh", () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "schmock-publish-wrapper-"));
    binDir = join(fixtureRoot, "bin");
    commandLog = join(fixtureRoot, "commands.log");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(fixtureRoot, "packages", "core"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "packages", "core", "package.json"),
      `${JSON.stringify({ name: "@schmock/core", version: VERSION })}\n`,
    );

    // The guarded script is stubbed: the real one queries npm and GitHub, and
    // has its own test suite. What matters here is which mode it is asked for.
    guardedScript = join(fixtureRoot, "guarded.sh");
    writeFileSync(
      guardedScript,
      `#!/usr/bin/env bash\nprintf 'guarded %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"\n`,
    );
    chmodSync(guardedScript, 0o755);

    writeStub("bun", `printf 'bun %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"`);
    writeStub(
      "git",
      `printf 'git %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"
case "$*" in
  "status --porcelain") printf '%s' "\${SCHMOCK_TEST_DIRTY:-}" ;;
  "rev-parse HEAD") printf '${HEAD_SHA}\\n' ;;
esac`,
    );
  });

  after(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("is valid Bash", () => {
    const result = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf-8" });
    assert.equal(result.status, 0);
  });

  it("checks without publishing when given no arguments", () => {
    const result = run([]);

    assert.equal(result.exitCode, 0);
    const log = commands();
    assert.match(log, /guarded all --preflight/);
    assert.match(log, /guarded all --dry-run/);
    for (const gate of ["lint", "test:all", "build", "check:publish"]) {
      assert.match(log, new RegExp(`bun run ${gate}`));
    }
    // The wrapper itself must reach neither npm nor the remote.
    assert.doesNotMatch(log, /npm publish/);
    assert.doesNotMatch(log, /git push/);
    assert.doesNotMatch(log, /gh release/);
  });

  it("prints the exact execute command rather than running it", () => {
    const result = run([]);

    assert.match(
      result.stdout,
      new RegExp(
        `bun run publish -- all --execute --confirm all@v${VERSION}:${HEAD_SHA}`,
      ),
    );
    assert.match(result.stdout, /Nothing has been published/);
    assert.doesNotMatch(commands(), /guarded all --execute/);
  });

  it("hands any arguments straight to the guarded script", () => {
    const token = `all@v${VERSION}:${HEAD_SHA}`;
    const result = run(["all", "--execute", "--confirm", token]);

    assert.equal(result.exitCode, 0);
    assert.equal(commands(), `guarded all --execute --confirm ${token}\n`);
  });

  it("refuses to continue when the checks dirty the worktree", () => {
    const result = run([], { SCHMOCK_TEST_DIRTY: " M packages/core/src/x.ts" });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /changed the worktree/);
    assert.doesNotMatch(commands(), /guarded all --dry-run/);
  });

  it("fails loudly when the guarded script is missing", () => {
    const result = run([], {
      SCHMOCK_PUBLISH_SCRIPT: join(fixtureRoot, "absent.sh"),
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /guarded publish script not found/);
  });
});
