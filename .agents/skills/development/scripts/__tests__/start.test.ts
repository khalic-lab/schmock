import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "start.sh");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function command(cwd: string, executable: string, args: string[]): RunResult {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

function must(cwd: string, executable: string, args: string[]): string {
  const result = command(cwd, executable, args);
  if (result.exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function run(root: string, args: string[]): RunResult {
  return command(root, "bash", [SCRIPT, ...args, "--root", root]);
}

describe("development branch start", () => {
  let fixture = "";
  let root = "";
  let origin = "";

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "schmock-start-"));
    origin = join(fixture, "origin.git");
    const seed = join(fixture, "seed");
    root = join(fixture, "work");

    must(fixture, "git", ["init", "--bare", origin]);
    mkdirSync(seed);
    must(seed, "git", ["init", "-b", "develop"]);
    must(seed, "git", ["config", "user.email", "test@example.com"]);
    must(seed, "git", ["config", "user.name", "Test User"]);
    must(seed, "git", ["config", "commit.gpgSign", "false"]);
    writeFileSync(join(seed, "README.md"), "fixture\n");
    must(seed, "git", ["add", "README.md"]);
    must(seed, "git", ["commit", "-m", "fixture"]);
    must(seed, "git", ["remote", "add", "origin", origin]);
    must(seed, "git", ["push", "-u", "origin", "develop"]);
    must(fixture, "git", [
      "--git-dir",
      origin,
      "symbolic-ref",
      "HEAD",
      "refs/heads/develop",
    ]);
    must(fixture, "git", ["clone", origin, root]);
    must(root, "git", ["config", "user.email", "test@example.com"]);
    must(root, "git", ["config", "user.name", "Test User"]);
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it("rejects a missing or invalid name", () => {
    expect(run(root, []).exitCode).not.toBe(0);
    const invalid = run(root, ["../escape", "--dry-run"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("invalid branch name");
  });

  it("previews without fetching or switching", () => {
    const before = must(root, "git", ["branch", "--show-current"]);
    const result = run(root, ["preview", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fetch origin develop");
    expect(result.stdout).toContain("switch -c feature/preview origin/develop");
    expect(must(root, "git", ["branch", "--show-current"])).toBe(before);
  });

  it("refuses a dirty worktree", () => {
    writeFileSync(join(root, "dirty.txt"), "dirty\n");
    const result = run(root, ["dirty", "--dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("dirty worktree");
  });

  it("refuses an existing local branch", () => {
    must(root, "git", ["branch", "feature/existing"]);
    const result = run(root, ["existing", "--dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already exists");
  });

  it("refuses an existing branch on origin even when it is not local", () => {
    const commit = must(root, "git", ["rev-parse", "HEAD"]);
    must(fixture, "git", [
      "--git-dir",
      origin,
      "update-ref",
      "refs/heads/feature/remote-existing",
      commit,
    ]);

    const result = run(root, ["remote-existing", "--dry-run"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "remote branch already exists: origin/feature/remote-existing",
    );
    expect(result.stdout).not.toContain("switch -c");
  });

  it("creates the branch directly from origin/develop", () => {
    const result = run(root, ["safe-change"]);
    expect(result.exitCode).toBe(0);
    expect(must(root, "git", ["branch", "--show-current"])).toBe(
      "feature/safe-change",
    );
    expect(must(root, "git", ["rev-parse", "HEAD"])).toBe(
      must(root, "git", ["rev-parse", "origin/develop"]),
    );
  });

  it("distinguishes a remote query failure from a missing branch", () => {
    must(root, "git", [
      "remote",
      "set-url",
      "origin",
      join(fixture, "missing.git"),
    ]);
    const before = must(root, "git", ["branch", "--show-current"]);
    const result = run(root, ["query-failure", "--dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "could not query origin for remote branch feature/query-failure",
    );
    expect(result.stderr).not.toContain("remote branch already exists");
    expect(must(root, "git", ["branch", "--show-current"])).toBe(before);
  });
});
