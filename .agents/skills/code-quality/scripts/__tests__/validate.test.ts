import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeBun,
  createWorkspaceFixture,
  removeFixture,
} from "./test-fixtures";

const script = join(__dirname, "..", "validate.sh");
const stages = [
  "Lint",
  "Typecheck",
  "Knip",
  "ESLint",
  "Unit",
  "BDD",
  "Integration",
  "Build",
  "Bench",
];
let root: string;

function run(args: string[], path = process.env.PATH ?? "") {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: path,
      SCHMOCK_REPO_ROOT: root,
    },
  });
}

describe("validate.sh", () => {
  beforeEach(() => {
    root = createWorkspaceFixture();
  });

  afterEach(() => {
    removeFixture(root);
  });

  it("prints all nine stages in dry-run mode", () => {
    const result = run(["--dry-run"]);
    expect(result.status).toBe(0);
    for (const stage of stages)
      expect(result.stdout).toContain(`━━━ ${stage} ━━━`);
    expect(result.stdout).toContain(
      "Planned: 9. No quality gate was executed.",
    );
    expect(result.stdout).not.toContain("ready to commit");
  });

  it("aggregates a command failure without invoking repository tools", () => {
    const fakeBin = createFakeBun(root, "run test:bdd");
    const result = run([], `${fakeBin}:${process.env.PATH ?? ""}`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("✗ BDD");
    expect(result.stdout).toContain("Passed: 8  Failed: 1");
    expect(result.stdout).toContain("How to fix");
  });

  it("rejects unexpected arguments", () => {
    const result = run(["extra"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });
});
