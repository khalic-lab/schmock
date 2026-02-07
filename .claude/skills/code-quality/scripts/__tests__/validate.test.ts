import { execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "validate.sh");
const ROOT = join(__dirname, "../../../../..");

function run(): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`bash ${SCRIPT}`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 180000,
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

describe("validate.sh", () => {
  it("should run all validation stages and print results", () => {
    const result = run();
    const output = result.stdout + result.stderr;
    // Should have the stage headers
    expect(output).toContain("Lint");
    expect(output).toContain("Typecheck");
    expect(output).toContain("Unit");
    expect(output).toContain("BDD");
    // Should have the results summary
    expect(output).toContain("Results");
    expect(output).toContain("Passed:");
  });
});
