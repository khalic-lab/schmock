import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "scaffold.ts");
const ROOT = join(__dirname, "../../../../..");

function run(args: string): { output: string; exitCode: number } {
  try {
    const stdout = execSync(`bun ${SCRIPT} ${args}`, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { output: stdout, exitCode: 0 };
  } catch (e: any) {
    // Bun sends console.error to stderr
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return { output, exitCode: e.status ?? 1 };
  }
}

describe("scaffold.ts", () => {
  const uniqueName = `test-scaffold-${Date.now()}`;
  const featurePath = join(ROOT, "features", `${uniqueName}.feature`);
  const stepsPath = join(
    ROOT,
    "packages",
    "core",
    "src",
    "steps",
    `${uniqueName}.steps.ts`,
  );

  afterEach(() => {
    if (existsSync(featurePath)) rmSync(featurePath);
    if (existsSync(stepsPath)) rmSync(stepsPath);
  });

  describe("argument validation", () => {
    it("should fail without arguments", () => {
      const result = run("");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Usage:");
    });

    it("should fail with only name argument", () => {
      const result = run("some-feature");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Usage:");
    });

    it("should fail with invalid package name", () => {
      const result = run("some-feature invalid-pkg");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Invalid package");
      expect(result.output).toContain("core, schema, express, angular");
    });
  });

  describe("--check mode", () => {
    it("should list existing features and scenarios", () => {
      const result = run("--check");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Existing features and scenarios:");
      expect(result.output).toContain("fluent-api.feature");
    });

    it("should show scenario names", () => {
      const result = run("--check");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Simple route with generator function");
    });

    it("should show which package has steps", () => {
      const result = run("--check");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("steps: core");
    });
  });

  describe("create mode", () => {
    it("should create feature and steps files", () => {
      const result = run(`${uniqueName} core`);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`features/${uniqueName}.feature`);
      expect(result.output).toContain(
        `packages/core/src/steps/${uniqueName}.steps.ts`,
      );
      expect(existsSync(featurePath)).toBe(true);
      expect(existsSync(stepsPath)).toBe(true);
    });

    it("should populate feature template with title-cased name", () => {
      run(`${uniqueName} core`);
      const content = readFileSync(featurePath, "utf-8");
      expect(content).toContain("Feature:");
      expect(content).toContain("As a developer");
    });

    it("should populate steps template with correct feature file reference", () => {
      run(`${uniqueName} core`);
      const content = readFileSync(stepsPath, "utf-8");
      expect(content).toContain(`../../features/${uniqueName}.feature`);
      expect(content).toContain("describeFeature");
      expect(content).toContain("loadFeature");
    });

    it("should fail if feature file already exists", () => {
      writeFileSync(featurePath, "Feature: Existing");
      const result = run(`${uniqueName} core`);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("already exists");
    });

    it("should fail if steps file already exists", () => {
      const dir = join(ROOT, "packages", "core", "src", "steps");
      mkdirSync(dir, { recursive: true });
      writeFileSync(stepsPath, "// existing");
      const result = run(`${uniqueName} core`);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("already exists");
      rmSync(stepsPath);
    });

    it("should work with all valid packages", () => {
      for (const pkg of ["core", "schema", "express", "angular"]) {
        const name = `${uniqueName}-${pkg}`;
        const fp = join(ROOT, "features", `${name}.feature`);
        const sp = join(
          ROOT,
          "packages",
          pkg,
          "src",
          "steps",
          `${name}.steps.ts`,
        );
        try {
          const result = run(`${name} ${pkg}`);
          expect(result.exitCode).toBe(0);
          expect(existsSync(fp)).toBe(true);
          expect(existsSync(sp)).toBe(true);
        } finally {
          if (existsSync(fp)) rmSync(fp);
          if (existsSync(sp)) rmSync(sp);
        }
      }
    });
  });
});
