import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "check-deps.sh");
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

describe("check-deps.sh", () => {
  it("should be a valid bash script", () => {
    const content = readFileSync(SCRIPT, "utf-8");
    expect(content).toContain("#!/usr/bin/env bash");
  });

  it("should reject unknown targets", () => {
    const result = run("invalid");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Unknown target");
  });

  it("should accept 'all' target (default)", () => {
    const result = run("all");
    const output = result.stdout + result.stderr;
    expect(output).toContain("Outdated Packages");
    expect(output).toContain("Package Export Compatibility");
  });

  it("should accept 'outdated' target", () => {
    const result = run("outdated");
    const output = result.stdout + result.stderr;
    expect(output).toContain("Outdated Packages");
  });

  it("should accept 'publish' target", () => {
    const result = run("publish");
    const output = result.stdout + result.stderr;
    expect(output).toContain("Package Export Compatibility");
  });

  it("should accept 'audit' target", () => {
    const result = run("audit");
    const output = result.stdout + result.stderr;
    expect(output).toContain("Security Audit");
  });

  it("should default to 'all' when no argument given", () => {
    const result = run("");
    const output = result.stdout + result.stderr;
    expect(output).toContain("Outdated Packages");
  });
});
