import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

/**
 * Repository tooling that no package suite covers: the root ESLint config and
 * the Git hooks under .githooks/.
 */

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
