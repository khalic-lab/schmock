import { execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "test.sh");
const ROOT = join(__dirname, "../../../../..");

function run(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`bash ${SCRIPT} ${args}`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 120000,
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

describe("test.sh", () => {
  it("should fail without arguments", () => {
    const result = run("");
    expect(result.exitCode).not.toBe(0);
  });

  it("should reject unknown targets", () => {
    const result = run("foobar");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Unknown target");
  });

  it("should accept 'all' target", () => {
    const result = run("all");
    expect(result.stdout).toContain("Running full test suite");
  });

  it("should accept 'unit' target", () => {
    const result = run("unit");
    expect(result.stdout).toContain("Running unit tests");
  });

  it("should accept 'bdd' target", () => {
    const result = run("bdd");
    expect(result.stdout).toContain("Running BDD tests");
  });

  it("should accept package names", () => {
    for (const pkg of ["core", "schema", "express", "angular"]) {
      const result = run(pkg);
      expect(result.stdout).toContain(`Running tests for @schmock/${pkg}`);
    }
  });
});
