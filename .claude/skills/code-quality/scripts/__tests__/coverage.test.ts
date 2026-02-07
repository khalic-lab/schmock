import { execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "coverage.sh");
const ROOT = join(__dirname, "../../../../..");

function run(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`bash ${SCRIPT} ${args}`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 60000,
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

describe("coverage.sh", () => {
  it("should fail without arguments", () => {
    const result = run("");
    expect(result.exitCode).not.toBe(0);
  });

  it("should reject invalid package names", () => {
    const result = run("nonexistent");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Invalid package");
  });

  it("should accept valid package names", () => {
    const result = run("core");
    expect(result.stdout).toContain("Generating coverage for @schmock/core");
  });
});
