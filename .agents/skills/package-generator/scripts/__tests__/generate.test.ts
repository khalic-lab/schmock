import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertUnchanged, generatedDirectoryMatches } from "../generate";

const SCRIPT = join(__dirname, "..", "generate.ts");
const TEST_PACKAGE = "test-adapter";

type JsonObject = Record<string, unknown>;

interface RunResult {
  output: string;
  exitCode: number;
}

function run(root: string, args: string[]): RunResult {
  const result = spawnSync("bun", [SCRIPT, ...args, "--root", root], {
    cwd: root,
    encoding: "utf-8",
    env: {
      ...process.env,
      BUN_CONFIG_REGISTRY: "http://127.0.0.1:9",
    },
  });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    exitCode: result.status ?? 1,
  };
}

function assertJsonObject(
  value: unknown,
  label: string,
): asserts value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function readJsonObject(path: string): JsonObject {
  const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
  assertJsonObject(value, path);
  return value;
}

function requiredObject(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  assertJsonObject(value, key);
  return value;
}

function requiredString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function parseJsonc(bytes: string): JsonObject {
  const value: unknown = JSON.parse(bytes.replace(/,\s*([}\]])/g, "$1"));
  assertJsonObject(value, "bun.lock");
  return value;
}

function writeFixtureLockfile(
  root: string,
  devDependencies: Record<string, string>,
): void {
  const workspaces = {
    "": {
      name: "schmock",
      devDependencies,
    },
    "packages/core": {
      name: "@schmock/core",
      version: "2.2.2",
    },
  };
  writeFileSync(
    join(root, "bun.lock"),
    `${JSON.stringify(
      {
        lockfileVersion: 1,
        configVersion: 1,
        workspaces,
        packages: {
          "@schmock/core": ["@schmock/core@workspace:packages/core"],
        },
      },
      null,
      2,
    )}\n`,
  );
}

function lockedWorkspace(root: string, name: string): JsonObject | undefined {
  const lockfile = parseJsonc(readFileSync(join(root, "bun.lock"), "utf-8"));
  const workspaces = requiredObject(lockfile, "workspaces");
  const workspace = workspaces[`packages/${name}`];
  if (workspace === undefined) return undefined;
  assertJsonObject(workspace, name);
  return workspace;
}

describe("package generator", () => {
  let root: string;
  let toolDependencies: Record<string, string>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "schmock-package-generator-"));
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    const tools = [
      ["cucumber", "@amiceli/vitest-cucumber", "7.0.0"],
      ["typescript", "typescript", "6.0.3"],
      ["vitest", "vitest", "4.1.9"],
    ] as const;
    toolDependencies = {};
    for (const [directory, packageName, version] of tools) {
      const path = join(root, "vendor", directory);
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, "package.json"),
        `${JSON.stringify({ name: packageName, version })}\n`,
      );
      toolDependencies[packageName] = `file:${path}`;
    }
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({
        name: "schmock",
        private: true,
        workspaces: ["packages/*"],
        devDependencies: toolDependencies,
      })}\n`,
    );
    writeFileSync(
      join(root, "packages", "core", "package.json"),
      `${JSON.stringify({ name: "@schmock/core", version: "2.2.2" })}\n`,
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          paths: { "@schmock/core": ["./packages/core/src"] },
        },
      })}\n`,
    );
    writeFixtureLockfile(root, toolDependencies);
  });

  afterEach(() => {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a missing package name", () => {
    const result = run(root, ["--target", "node"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Usage:");
  });

  it("requires a supported build target", () => {
    const missing = run(root, [TEST_PACKAGE]);
    const invalid = run(root, [TEST_PACKAGE, "--target", "desktop"]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.output).toContain("Missing required --target");
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.output).toContain("Invalid --target");
  });

  it.each([
    "InvalidName",
    "123invalid",
    "../escape",
    "nested/name",
    ".hidden",
  ])("rejects unsafe package name %s", (name) => {
    const result = run(root, [name, "--target", "node"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Invalid package name");
    expect(existsSync(join(root, "escape"))).toBe(false);
  });

  it("previews without changing any repository bytes", () => {
    const rootPackagePath = join(root, "package.json");
    const corePackagePath = join(root, "packages", "core", "package.json");
    const lockfilePath = join(root, "bun.lock");
    const originalTsconfig = readFileSync(join(root, "tsconfig.json"), "utf-8");
    const originalRootPackage = readFileSync(rootPackagePath, "utf-8");
    const originalCorePackage = readFileSync(corePackagePath, "utf-8");
    const originalLockfile = readFileSync(lockfilePath, "utf-8");
    const result = run(root, [
      TEST_PACKAGE,
      "--target",
      "browser",
      "--dry-run",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Dry run: no files will be written.");
    expect(result.output).toContain("(browser)");
    expect(existsSync(join(root, "packages", TEST_PACKAGE))).toBe(false);
    expect(readFileSync(join(root, "tsconfig.json"), "utf-8")).toBe(
      originalTsconfig,
    );
    expect(readFileSync(rootPackagePath, "utf-8")).toBe(originalRootPackage);
    expect(readFileSync(corePackagePath, "utf-8")).toBe(originalCorePackage);
    expect(readFileSync(lockfilePath, "utf-8")).toBe(originalLockfile);
    expect(result.output).toContain("bun.lock: register packages/test-adapter");
    expect(result.output).toContain("package.json: build, typecheck");
    expect(result.output).toContain("publish.sh: PACKAGES dependency order");
    expect(result.output).toContain("check-deps.sh: PACKAGES");
    expect(result.output).toContain(
      "scripts/smoke-tests/fixtures/<package>: add the smoke fixture required by workspace manifest discovery",
    );
    expect(result.output).not.toContain("run-all.sh: ALL_PACKAGES");
  });

  it.each([
    "node",
    "browser",
  ])("renders the explicit %s build target", (target) => {
    const result = run(root, [TEST_PACKAGE, "--target", target]);
    expect(result.exitCode).toBe(0);

    const pkg = readJsonObject(
      join(root, "packages", TEST_PACKAGE, "package.json"),
    );
    const scripts = requiredObject(pkg, "scripts");
    expect(requiredString(scripts, "build:lib")).toContain(
      `--target ${target}`,
    );
  });

  it("creates version-aligned package files in an isolated fixture", () => {
    const result = run(root, [TEST_PACKAGE, "--target", "node"]);
    const pkgDir = join(root, "packages", TEST_PACKAGE);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(pkgDir, "package.json"))).toBe(true);
    expect(existsSync(join(pkgDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(pkgDir, "vitest.config.ts"))).toBe(true);
    expect(existsSync(join(pkgDir, "vitest.config.bdd.ts"))).toBe(true);
    expect(existsSync(join(pkgDir, "src", "index.ts"))).toBe(true);

    const pkg = readJsonObject(join(pkgDir, "package.json"));
    expect(pkg).toMatchObject({
      name: "@schmock/test-adapter",
      version: "2.2.2",
      type: "module",
    });
    const peerDependencies = requiredObject(pkg, "peerDependencies");
    expect(requiredString(peerDependencies, "@schmock/core")).toBe("^2.2.2");
    expect(requiredObject(pkg, "devDependencies")).toEqual(toolDependencies);
    const scripts = requiredObject(pkg, "scripts");
    expect(requiredString(scripts, "clean")).toBe(
      "rm -rf dist && rm -f tsconfig.tsbuildinfo",
    );
    expect(requiredString(scripts, "build")).toBe(
      "bun run clean && bun run build:lib && bun run build:types",
    );

    const packageTsconfig = readJsonObject(join(pkgDir, "tsconfig.json"));
    expect(packageTsconfig.extends).toBe("../../tsconfig.json");
    expect(
      requiredObject(packageTsconfig, "compilerOptions"),
    ).not.toHaveProperty("module");
    expect(packageTsconfig.exclude).toContain("**/*.steps.ts");

    const rootTsconfig = readJsonObject(join(root, "tsconfig.json"));
    const compilerOptions = requiredObject(rootTsconfig, "compilerOptions");
    const paths = requiredObject(compilerOptions, "paths");
    expect(paths["@schmock/test-adapter"]).toEqual([
      "./packages/test-adapter/src",
    ]);

    expect(lockedWorkspace(root, TEST_PACKAGE)).toMatchObject({
      name: "@schmock/test-adapter",
      version: "2.2.2",
      peerDependencies: { "@schmock/core": "^2.2.2" },
    });
  });

  it("rolls back package files when a later write fails", () => {
    const tsconfigPath = join(root, "tsconfig.json");
    const lockfilePath = join(root, "bun.lock");
    const originalTsconfig = readFileSync(tsconfigPath, "utf-8");
    const originalLockfile = readFileSync(lockfilePath, "utf-8");
    chmodSync(root, 0o555);

    const result = run(root, [TEST_PACKAGE, "--target", "node"]);

    chmodSync(root, 0o755);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("changes rolled back");
    expect(existsSync(join(root, "packages", TEST_PACKAGE))).toBe(false);
    expect(readFileSync(tsconfigPath, "utf-8")).toBe(originalTsconfig);
    expect(readFileSync(lockfilePath, "utf-8")).toBe(originalLockfile);
    expect(readdirSync(join(root, "packages"))).toEqual(["core"]);
  });

  it("rejects a stale bun.lock before creating files", () => {
    const lockfilePath = join(root, "bun.lock");
    const lockfile = parseJsonc(readFileSync(lockfilePath, "utf-8"));
    const workspaces = requiredObject(lockfile, "workspaces");
    const core = requiredObject(workspaces, "packages/core");
    core.version = "2.2.1";
    writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    const result = run(root, [TEST_PACKAGE, "--target", "node"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      "bun.lock workspace packages/core does not exactly match",
    );
    expect(existsSync(join(root, "packages", TEST_PACKAGE))).toBe(false);
    expect(readJsonObject(join(root, "tsconfig.json"))).not.toHaveProperty(
      "compilerOptions.paths.@schmock/test-adapter",
    );
  });

  it("rejects malformed bun.lock text before creating files", () => {
    writeFileSync(join(root, "bun.lock"), "{ malformed");

    const result = run(root, [TEST_PACKAGE, "--target", "node"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("bun.lock is not valid JSONC");
    expect(existsSync(join(root, "packages", TEST_PACKAGE))).toBe(false);
  });

  it("rejects stale workspace registrations before creating files", () => {
    const lockfilePath = join(root, "bun.lock");
    const lockfile = parseJsonc(readFileSync(lockfilePath, "utf-8"));
    const workspaces = requiredObject(lockfile, "workspaces");
    const packages = requiredObject(lockfile, "packages");
    workspaces["packages/removed"] = {
      name: "@schmock/removed",
      version: "2.2.2",
    };
    packages["@schmock/removed"] = [
      "@schmock/removed@workspace:packages/removed",
    ];
    writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    const result = run(root, [TEST_PACKAGE, "--target", "node"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("bun.lock workspace topology");
    expect(existsSync(join(root, "packages", TEST_PACKAGE))).toBe(false);
  });

  it("rejects unsynchronized existing workspace versions", () => {
    const existingDirectory = join(root, "packages", "existing");
    mkdirSync(existingDirectory);
    writeFileSync(
      join(existingDirectory, "package.json"),
      `${JSON.stringify({ name: "@schmock/existing", version: "2.2.1" })}\n`,
    );
    const lockfilePath = join(root, "bun.lock");
    const lockfile = parseJsonc(readFileSync(lockfilePath, "utf-8"));
    const workspaces = requiredObject(lockfile, "workspaces");
    const packages = requiredObject(lockfile, "packages");
    workspaces["packages/existing"] = {
      name: "@schmock/existing",
      version: "2.2.1",
    };
    packages["@schmock/existing"] = [
      "@schmock/existing@workspace:packages/existing",
    ];
    writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    const result = run(root, [TEST_PACKAGE, "--target", "node"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Workspace versions are not synchronized");
    expect(result.output).toContain("@schmock/existing is 2.2.1");
    expect(existsSync(join(root, "packages", TEST_PACKAGE))).toBe(false);
  });

  it("treats a concurrent empty directory as foreign content", () => {
    const packageDirectory = join(root, "packages", "owned");
    mkdirSync(join(packageDirectory, "src"), { recursive: true });
    mkdirSync(join(packageDirectory, "concurrent-empty"));
    writeFileSync(join(packageDirectory, "src", "index.ts"), "export {};\n");

    expect(
      generatedDirectoryMatches(
        packageDirectory,
        [["src/index.ts", "export {};\n"]],
        true,
      ),
    ).toBe(false);
    expect(existsSync(join(packageDirectory, "concurrent-empty"))).toBe(true);
  });

  it("does not overwrite a snapshot changed by another owner", () => {
    const tsconfigPath = join(root, "tsconfig.json");
    const original = readFileSync(tsconfigPath, "utf-8");
    writeFileSync(tsconfigPath, `${original}\nconcurrent owner`);

    expect(() =>
      assertUnchanged({ path: tsconfigPath, bytes: original }),
    ).toThrow("Stale snapshot");
    expect(readFileSync(tsconfigPath, "utf-8")).toContain("concurrent owner");
  });

  it("refuses to overwrite an existing package", () => {
    expect(run(root, [TEST_PACKAGE, "--target", "node"]).exitCode).toBe(0);
    const result = run(root, [TEST_PACKAGE, "--target", "node"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("already exists");
  });
});
