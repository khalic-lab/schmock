import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspaceFixture,
  removeFixture,
  testPackages,
} from "./test-fixtures";

const script = join(__dirname, "..", "test.sh");
let root: string;

function run(args: string[]) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, SCHMOCK_REPO_ROOT: root },
  });
}

describe("test.sh", () => {
  beforeEach(() => {
    root = createWorkspaceFixture();
  });

  afterEach(() => {
    removeFixture(root);
  });

  it("rejects a missing target", () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });

  it.each([
    ["all", "typecheck + unit + BDD + integration", "test:all"],
    ["unit", "all unit tests", "test:unit"],
    ["bdd", "all BDD tests", "test:bdd"],
  ])("selects the %s command without executing it", (target, label, command) => {
    const result = run(["--dry-run", target]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(label);
    expect(result.stdout).toContain(command);
    expect(result.stdout).not.toMatch(/quiet|silent/);
  });

  it("discovers every workspace that exposes a test script", () => {
    for (const name of testPackages) {
      const result = run([name, "--dry-run"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Running tests for @schmock/${name}`);
    }
  });

  it("accepts a full workspace name", () => {
    const result = run(["@schmock/core", "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("@schmock/core");
  });

  it("rejects a workspace without a test script", () => {
    const result = run(["schmock", "--dry-run"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no test script");
  });

  it("rejects unknown and traversal-like package names", () => {
    for (const target of ["schema", "../core", "nonexistent"]) {
      const result = run([target, "--dry-run"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unknown package");
    }
  });
});
