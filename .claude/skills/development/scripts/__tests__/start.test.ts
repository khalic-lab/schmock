import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "start.sh");
const ROOT = join(__dirname, "../../../../..");

function run(
  args: string,
  cwd?: string,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`bash ${SCRIPT} ${args}`, {
      cwd: cwd ?? ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout || "",
      stderr: e.stderr || "",
      exitCode: e.status ?? 1,
    };
  }
}

function getCurrentBranch(): string {
  return execSync("git branch --show-current", {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
}

function branchExists(name: string): boolean {
  try {
    execSync(`git rev-parse --verify ${name}`, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

describe("start.sh", () => {
  const originalBranch = getCurrentBranch();
  const testBranch = `__test-start-${Date.now()}`;

  afterEach(() => {
    // Return to original branch and clean up
    try {
      execSync(`git checkout ${originalBranch}`, {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {}
    try {
      execSync(`git branch -D feature/${testBranch}`, {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {}
  });

  it("should fail without a branch name argument", () => {
    const result = run("");
    expect(result.exitCode).not.toBe(0);
  });

  it("should create a feature branch from develop", () => {
    // This test requires that a develop branch exists on the remote
    // Skip if develop doesn't exist
    const hasDevelop = branchExists("origin/develop");
    if (!hasDevelop) {
      console.log("Skipping: origin/develop not found");
      return;
    }

    const result = run(testBranch);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`feature/${testBranch}`);
    expect(getCurrentBranch()).toBe(`feature/${testBranch}`);
  });
});
