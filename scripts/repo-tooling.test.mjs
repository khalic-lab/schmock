import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

/**
 * Repository tooling that no package suite covers: the root ESLint config and
 * the Git hooks under .githooks/.
 */

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT_MSG_HOOK = join(ROOT_DIR, ".githooks/commit-msg");

/**
 * Runs the commit-msg hook on a message file and returns its exit status.
 * `config` adds git config entries for the run, as `git -c` would.
 */
function commitMsgStatus(message, config = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "schmock-commit-msg-"));
  const messageFile = join(workdir, "COMMIT_EDITMSG");
  try {
    writeFileSync(messageFile, message);
    const entries = Object.entries(config);
    const env = { ...process.env, GIT_CONFIG_COUNT: String(entries.length) };
    entries.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    const result = spawnSync("sh", [COMMIT_MSG_HOOK, messageFile], {
      encoding: "utf8",
      env,
    });
    return result.status;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("commit-msg accepts conventional and merge subjects", () => {
  for (const message of [
    "fix(core): keep the route table intact\n",
    "feat: add a subject without a scope\n\nWith a body.\n",
    `docs: ${"a long description ".repeat(6)}\n`,
    "Merge branch 'feature/x' into develop\n",
    // Git hands the hook the message before it strips comments and leading
    // blank lines.
    "\n# Please enter the commit message.\nchore(tooling): subject after a comment\n",
  ]) {
    assert.equal(commitMsgStatus(message), 0, JSON.stringify(message));
  }
});

test("commit-msg judges the subject, not a later line", () => {
  for (const message of [
    "updated stuff\n",
    "WIP do not merge\n\nfix: a conventional-looking body line\n",
    "WIP\nMerge branch 'x'\n",
    "fix:missing space after the colon\n",
    "# only a comment\n",
  ]) {
    assert.equal(commitMsgStatus(message), 1, JSON.stringify(message));
  }
});

test("commit-msg skips comments in the configured comment character", () => {
  const semicolon = { "core.commentChar": ";" };
  assert.equal(commitMsgStatus("; a comment\nfix: subject\n", semicolon), 0);
  assert.equal(
    commitMsgStatus("# not a comment here\nfix: subject\n", semicolon),
    1,
  );
  assert.equal(
    commitMsgStatus("; a comment\nfix: subject\n", {
      "core.commentChar": "auto",
    }),
    0,
  );
  assert.equal(
    commitMsgStatus("// a comment\nfix: subject\n", {
      "core.commentString": "//",
    }),
    0,
  );
});

test("eslint skips agent worktrees and skill copies", async () => {
  const eslint = new ESLint({ cwd: ROOT_DIR });

  // ESLint looks up the config per file, so a worktree under .claude/ would
  // be linted with its own typed config. These paths need not exist, so
  // isPathIgnored resolves them against the root config: this shows that the
  // root config names them, not that a real nested worktree is skipped.
  // JavaScript paths are used because ESLint lints them by default: a .ts
  // path outside packages/*/src matches no config and reads as ignored
  // whether or not the ignore is there.
  for (const path of [
    ".claude/worktrees/agent-x/eslint.config.mjs",
    ".claude/worktrees/agent-x/packages/core/scripts/build.js",
    ".agents/skills/devops/scripts/helper.mjs",
  ]) {
    assert.equal(await eslint.isPathIgnored(join(ROOT_DIR, path)), true, path);
  }

  for (const path of ["packages/core/src/index.ts", "eslint.config.mjs"]) {
    assert.equal(await eslint.isPathIgnored(join(ROOT_DIR, path)), false, path);
  }
});
