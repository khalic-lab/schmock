import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "generate.ts");
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
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return { output, exitCode: e.status ?? 1 };
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("generate.ts", () => {
  // Use a valid package name (lowercase, alphanumeric + hyphens only)
  const testPkg = `test-gen-${Date.now()}`;
  const pkgDir = join(ROOT, "packages", testPkg);
  const tsconfigPath = join(ROOT, "tsconfig.json");
  const manifestPath = join(ROOT, ".release-please-manifest.json");

  let tsconfigBackup: string;
  let manifestBackup: string;

  beforeEach(() => {
    tsconfigBackup = readFileSync(tsconfigPath, "utf-8");
    manifestBackup = readFileSync(manifestPath, "utf-8");
  });

  afterEach(() => {
    if (existsSync(pkgDir)) {
      rmSync(pkgDir, { recursive: true, force: true });
    }
    writeFileSync(tsconfigPath, tsconfigBackup);
    writeFileSync(manifestPath, manifestBackup);
  });

  describe("argument validation", () => {
    it("should fail without arguments", () => {
      const result = run("");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Usage:");
    });

    it("should fail with invalid package name (uppercase)", () => {
      const result = run("InvalidName");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Invalid package name");
    });

    it("should fail with invalid package name (starts with number)", () => {
      const result = run("123invalid");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Invalid package name");
    });
  });

  describe("package generation", () => {
    it("should create all required files", () => {
      const result = run(testPkg);
      expect(result.exitCode).toBe(0);

      expect(existsSync(join(pkgDir, "package.json"))).toBe(true);
      expect(existsSync(join(pkgDir, "tsconfig.json"))).toBe(true);
      expect(existsSync(join(pkgDir, "vitest.config.ts"))).toBe(true);
      expect(existsSync(join(pkgDir, "vitest.config.bdd.ts"))).toBe(true);
      expect(existsSync(join(pkgDir, "src", "index.ts"))).toBe(true);
    });

    it("should generate correct package.json", () => {
      run(testPkg);
      const pkg = readJson(join(pkgDir, "package.json"));
      expect(pkg.name).toBe(`@schmock/${testPkg}`);
      expect(pkg.version).toBe("1.0.0");
      expect(pkg.type).toBe("module");
      expect(pkg.peerDependencies["@schmock/core"]).toBe("^1.0.0");
    });

    it("should generate tsconfig.json extending root", () => {
      run(testPkg);
      const tsconfig = readJson(join(pkgDir, "tsconfig.json"));
      expect(tsconfig.extends).toBe("../../tsconfig.json");
      expect(tsconfig.compilerOptions.module).toBe("NodeNext");
      expect(tsconfig.exclude).toContain("**/*.test.ts");
      expect(tsconfig.exclude).toContain("**/*.steps.ts");
    });

    it("should generate vitest configs", () => {
      run(testPkg);
      const unitConfig = readFileSync(
        join(pkgDir, "vitest.config.ts"),
        "utf-8",
      );
      expect(unitConfig).toContain("src/**/*.test.ts");
      expect(unitConfig).toContain("**/*.steps.ts");

      const bddConfig = readFileSync(
        join(pkgDir, "vitest.config.bdd.ts"),
        "utf-8",
      );
      expect(bddConfig).toContain("src/**/*.steps.ts");
    });

    it("should register path alias in root tsconfig.json", () => {
      run(testPkg);
      const tsconfig = readJson(tsconfigPath);
      expect(tsconfig.compilerOptions.paths[`@schmock/${testPkg}`]).toEqual([
        `packages/${testPkg}/src`,
      ]);
    });

    it("should register in .release-please-manifest.json", () => {
      run(testPkg);
      const manifest = readJson(manifestPath);
      expect(manifest[`packages/${testPkg}`]).toBe("1.0.0");
    });

    it("should fail if package directory already exists", () => {
      run(testPkg);
      const result = run(testPkg);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("already exists");
    });
  });
});
