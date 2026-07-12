import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "scaffold.ts");

interface RunResult {
  output: string;
  exitCode: number;
}

function writeWorkspace(
  root: string,
  name: string,
  bdd: boolean,
  jsx = false,
): void {
  const directory = join(root, "packages", name);
  mkdirSync(join(directory, "src", "steps"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({
      name: `@schmock/${name}`,
      scripts: bdd ? { "test:bdd": "vitest run" } : { build: "bun build" },
    })}\n`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: jsx ? { jsx: "react-jsx" } : {} })}\n`,
  );
}

function run(root: string, args: string[]): RunResult {
  const result = spawnSync("bun", [SCRIPT, ...args, "--root", root], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    exitCode: result.status ?? 1,
  };
}

describe("development scaffold", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "schmock-scaffold-"));
    mkdirSync(join(root, "features"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "schmock", workspaces: ["packages/*"] })}\n`,
    );
    writeWorkspace(root, "core", true);
    writeWorkspace(root, "react", true, true);
    writeWorkspace(root, "schmock", false);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects missing, traversal, and non-BDD targets", () => {
    expect(run(root, []).exitCode).not.toBe(0);
    expect(run(root, ["../escape", "core"]).output).toContain(
      "strict kebab-case",
    );

    const invalidPackage = run(root, ["new-feature", "schmock"]);
    expect(invalidPackage.exitCode).not.toBe(0);
    expect(invalidPackage.output).toContain("Valid packages: core, react");
  });

  it("lists Scenario and Scenario Outline ownership across ts and tsx steps", () => {
    writeFileSync(
      join(root, "features", "existing.feature"),
      "Feature: Existing\n  Scenario: One\n  Scenario Outline: Many\n",
    );
    writeFileSync(
      join(root, "packages", "react", "src", "steps", "existing.steps.tsx"),
      "// existing\n",
    );

    const result = run(root, ["--check"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      "[existing.feature] Existing (steps: react)",
    );
    expect(result.output).toContain("  - One");
    expect(result.output).toContain("  - Many");
  });

  it("previews both paths without writing", () => {
    const result = run(root, ["new-feature", "core", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("DRY RUN: no files will be written");
    expect(existsSync(join(root, "features", "new-feature.feature"))).toBe(
      false,
    );
    expect(
      existsSync(
        join(root, "packages", "core", "src", "steps", "new-feature.steps.ts"),
      ),
    ).toBe(false);
  });

  it("rejects a features directory symlinked outside the repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "schmock-features-outside-"));
    try {
      rmSync(join(root, "features"), { recursive: true });
      symlinkSync(outside, join(root, "features"), "dir");

      const result = run(root, ["escaped-feature", "core", "--dry-run"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Features directory escapes repository");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a steps directory symlinked outside its workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "schmock-steps-outside-"));
    try {
      const stepsDir = join(root, "packages", "core", "src", "steps");
      rmSync(stepsDir, { recursive: true });
      symlinkSync(outside, stepsDir, "dir");

      const result = run(root, ["escaped-steps", "core", "--dry-run"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Steps directory escapes workspace");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("creates a TypeScript pair for a short package name", () => {
    const result = run(root, ["new-feature", "core"]);
    const featurePath = join(root, "features", "new-feature.feature");
    const stepsPath = join(
      root,
      "packages",
      "core",
      "src",
      "steps",
      "new-feature.steps.ts",
    );

    expect(result.exitCode).toBe(0);
    expect(readFileSync(featurePath, "utf8")).toContain("Feature: New Feature");
    expect(readFileSync(stepsPath, "utf8")).toContain(
      "../../features/new-feature.feature",
    );
  });

  it("creates TSX steps for a JSX workspace and accepts the full name", () => {
    const result = run(root, ["render-hook", "@schmock/react"]);
    expect(result.exitCode).toBe(0);
    expect(
      existsSync(
        join(
          root,
          "packages",
          "react",
          "src",
          "steps",
          "render-hook.steps.tsx",
        ),
      ),
    ).toBe(true);
  });

  it("refuses existing files before changing either side", () => {
    const featurePath = join(root, "features", "duplicate.feature");
    writeFileSync(featurePath, "Feature: Existing\n");
    const result = run(root, ["duplicate", "core"]);

    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(featurePath, "utf8")).toBe("Feature: Existing\n");
    expect(
      existsSync(
        join(root, "packages", "core", "src", "steps", "duplicate.steps.ts"),
      ),
    ).toBe(false);
  });

  it("rolls back the feature if the steps write fails", () => {
    const stepsPath = join(
      root,
      "packages",
      "core",
      "src",
      "steps",
      "rollback.steps.ts",
    );
    symlinkSync(join(root, "missing-target"), stepsPath);

    const result = run(root, ["rollback", "core"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("new files were rolled back");
    expect(existsSync(join(root, "features", "rollback.feature"))).toBe(false);
  });
});
