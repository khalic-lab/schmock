import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "bump.ts");
const ROOT = join(__dirname, "../../../../..");

/**
 * bump.ts modifies real files (package.json), so we
 * back them up before each test and restore after.
 */
const backupDir = join(__dirname, "__backup__");
const filesToBackup = [
  join(ROOT, "packages/core/package.json"),
  join(ROOT, "packages/faker/package.json"),
  join(ROOT, "packages/express/package.json"),
  join(ROOT, "packages/angular/package.json"),
];

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

describe("bump.ts", () => {
  beforeEach(() => {
    mkdirSync(backupDir, { recursive: true });
    for (const file of filesToBackup) {
      if (existsSync(file)) {
        copyFileSync(file, join(backupDir, file.replaceAll("/", "__")));
      }
    }
  });

  afterEach(() => {
    // Restore backed-up files
    for (const file of filesToBackup) {
      const backup = join(backupDir, file.replaceAll("/", "__"));
      if (existsSync(backup)) {
        copyFileSync(backup, file);
      }
    }
    rmSync(backupDir, { recursive: true, force: true });
  });

  describe("argument validation", () => {
    it("should fail without arguments", () => {
      const result = run("");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Usage:");
    });

    it("should fail with invalid bump level", () => {
      const result = run("invalid");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Usage:");
    });
  });

  describe("patch bump", () => {
    it("should increment patch version for all packages", () => {
      const coreBefore = readJson(
        join(ROOT, "packages/core/package.json"),
      ).version;
      const [major, minor, patch] = coreBefore.split(".").map(Number);

      const result = run("patch");
      expect(result.exitCode).toBe(0);

      const coreAfter = readJson(
        join(ROOT, "packages/core/package.json"),
      ).version;
      expect(coreAfter).toBe(`${major}.${minor}.${patch + 1}`);
    });

    it("should print a before/after table", () => {
      const result = run("patch");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Bumped patch versions");
      expect(result.output).toContain("@schmock/core");
      expect(result.output).toContain("Before");
      expect(result.output).toContain("After");
    });
  });

  describe("minor bump", () => {
    it("should increment minor version and reset patch", () => {
      const coreBefore = readJson(
        join(ROOT, "packages/core/package.json"),
      ).version;
      const [major, minor] = coreBefore.split(".").map(Number);

      run("minor");

      const coreAfter = readJson(
        join(ROOT, "packages/core/package.json"),
      ).version;
      expect(coreAfter).toBe(`${major}.${minor + 1}.0`);
    });
  });

  describe("major bump", () => {
    it("should increment major version and reset minor+patch", () => {
      const coreBefore = readJson(
        join(ROOT, "packages/core/package.json"),
      ).version;
      const [major] = coreBefore.split(".").map(Number);

      run("major");

      const coreAfter = readJson(
        join(ROOT, "packages/core/package.json"),
      ).version;
      expect(coreAfter).toBe(`${major + 1}.0.0`);
    });
  });
});
