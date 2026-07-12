import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyManifestWrites } from "../bump";

const SCRIPT = join(__dirname, "..", "bump.ts");
const PACKAGES = [
  "core",
  "faker",
  "validation",
  "query",
  "express",
  "react",
  "vue",
  "openapi",
  "angular",
  "cli",
  "schmock",
];

interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface RunResult {
  output: string;
  exitCode: number;
}

let fixtureRoot = "";

function manifestPath(pkg: string): string {
  return join(fixtureRoot, "packages", pkg, "package.json");
}

function lockfilePath(): string {
  return join(fixtureRoot, "bun.lock");
}

function writeManifest(pkg: string, version = "2.2.3"): void {
  const dir = join(fixtureRoot, "packages", pkg);
  mkdirSync(dir, { recursive: true });
  const manifest: PackageManifest = {
    name: `@schmock/${pkg}`,
    version,
  };
  if (pkg !== "core") {
    manifest.peerDependencies = { "@schmock/core": `^${version}` };
  }
  if (pkg === "openapi") {
    manifest.dependencies = { "@schmock/faker": `^${version}` };
  }
  if (pkg === "schmock") {
    manifest.dependencies = {
      "@schmock/core": `^${version}`,
      "@schmock/faker": `^${version}`,
      "@schmock/openapi": `^${version}`,
    };
  }
  writeFileSync(manifestPath(pkg), `${JSON.stringify(manifest, null, 2)}\n`);
}

function readManifest(pkg: string): PackageManifest {
  return JSON.parse(readFileSync(manifestPath(pkg), "utf-8"));
}

function writeLockfile(version = "2.2.3"): void {
  const workspaces: Record<string, unknown> = {
    "": { name: "schmock" },
  };
  const packages: Record<string, unknown> = {};
  for (const pkg of PACKAGES) {
    const manifest = readManifest(pkg);
    workspaces[`packages/${pkg}`] = {
      name: manifest.name,
      version,
      ...(manifest.dependencies
        ? { dependencies: manifest.dependencies }
        : undefined),
      ...(manifest.peerDependencies
        ? { peerDependencies: manifest.peerDependencies }
        : undefined),
    };
    packages[manifest.name] = [`${manifest.name}@workspace:packages/${pkg}`];
  }
  writeFileSync(
    lockfilePath(),
    `${JSON.stringify({ lockfileVersion: 1, workspaces, packages }, null, 2)}\n`,
  );
}

function readLockedVersion(pkg: string): string | undefined {
  const lockfile: unknown = JSON.parse(
    readFileSync(lockfilePath(), "utf-8").replace(/,\s*([}\]])/g, "$1"),
  );
  if (typeof lockfile !== "object" || lockfile === null) return undefined;
  const workspaces = Reflect.get(lockfile, "workspaces");
  if (typeof workspaces !== "object" || workspaces === null) return undefined;
  const workspace = Reflect.get(workspaces, `packages/${pkg}`);
  if (typeof workspace !== "object" || workspace === null) return undefined;
  const version = Reflect.get(workspace, "version");
  return typeof version === "string" ? version : undefined;
}

function run(args: string[]): RunResult {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    cwd: fixtureRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      BUN_CONFIG_REGISTRY: "http://127.0.0.1:9",
      SCHMOCK_ROOT: fixtureRoot,
    },
  });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    exitCode: result.status ?? 1,
  };
}

describe("bump.ts", () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "schmock-bump-test-"));
    mkdirSync(join(fixtureRoot, "packages"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "package.json"),
      `${JSON.stringify({ private: true, workspaces: ["packages/*"] })}\n`,
    );
    for (const pkg of PACKAGES) writeManifest(pkg);
    writeLockfile();
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("rejects a missing or invalid bump level", () => {
    expect(run([]).exitCode).not.toBe(0);
    const invalid = run(["invalid"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.output).toContain("usage:");
  });

  it("exposes a read-only lockfile check for release preflight", () => {
    const before = readFileSync(lockfilePath(), "utf-8");
    const result = run(["check-lockfile"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      "bun.lock matches all 11 workspace manifests at 2.2.3",
    );
    expect(readFileSync(lockfilePath(), "utf-8")).toBe(before);
  });

  it("rejects malformed lockfile text without writing manifests", () => {
    const before = readFileSync(manifestPath("core"), "utf-8");
    writeFileSync(lockfilePath(), "{ malformed");

    const result = run(["check-lockfile"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("bun.lock is not valid JSONC");
    expect(readFileSync(manifestPath("core"), "utf-8")).toBe(before);
  });

  it("rejects stale workspace registrations not backed by a manifest", () => {
    const lockfile: {
      workspaces: Record<string, unknown>;
      packages: Record<string, unknown>;
    } = JSON.parse(readFileSync(lockfilePath(), "utf-8"));
    lockfile.workspaces["packages/removed"] = {
      name: "@schmock/removed",
      version: "2.2.3",
    };
    lockfile.packages["@schmock/removed"] = [
      "@schmock/removed@workspace:packages/removed",
    ];
    writeFileSync(lockfilePath(), `${JSON.stringify(lockfile, null, 2)}\n`);

    const result = run(["check-lockfile"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("bun.lock workspace topology");
    expect(result.output).toContain("packages/removed");
  });

  it("rejects stale workspace package resolutions", () => {
    const lockfile: {
      workspaces: Record<string, unknown>;
      packages: Record<string, unknown>;
    } = JSON.parse(readFileSync(lockfilePath(), "utf-8"));
    lockfile.packages["@schmock/removed"] = [
      "@schmock/removed@workspace:packages/removed",
    ];
    writeFileSync(lockfilePath(), `${JSON.stringify(lockfile, null, 2)}\n`);

    const result = run(["check-lockfile"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("workspace package resolutions");
    expect(result.output).toContain("@schmock/removed");
  });

  it("defaults to a byte-identical dry run for manifests and bun.lock", () => {
    const paths = [...PACKAGES.map((pkg) => manifestPath(pkg)), lockfilePath()];
    const before = new Map(
      paths.map((path) => [path, readFileSync(path, "utf-8")]),
    );
    const result = run(["patch"]);
    expect(result, result.output).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("DRY RUN: patch bump for 11 workspaces");
    expect(result.output).toContain("2.2.3 -> 2.2.4");
    expect(result.output).toContain("exact workspace records refreshed");
    expect(result.output).toContain("No files written");
    for (const path of paths) {
      expect(readFileSync(path, "utf-8")).toBe(before.get(path));
    }
  });

  it("applies a synchronized bump only with --apply", () => {
    const result = run(["minor", "--apply"]);
    expect(result, result.output).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("APPLY: minor bump");

    for (const pkg of PACKAGES) {
      expect(readManifest(pkg).version).toBe("2.3.0");
    }
    expect(readManifest("faker").peerDependencies?.["@schmock/core"]).toBe(
      "^2.3.0",
    );
    expect(readManifest("openapi").dependencies?.["@schmock/faker"]).toBe(
      "^2.3.0",
    );
    for (const pkg of PACKAGES) {
      expect(readLockedVersion(pkg)).toBe("2.3.0");
    }
  });

  it("restores every touched release metadata file after a write failure", () => {
    const paths = [...PACKAGES.map((pkg) => manifestPath(pkg)), lockfilePath()];
    const originals = new Map(
      paths.map((path) => [path, readFileSync(path, "utf-8")]),
    );
    const writes = paths.map((path) => ({
      path,
      originalBytes: originals.get(path) ?? "",
      nextBytes: `${originals.get(path) ?? ""}\nchanged`,
    }));
    let writeAttempt = 0;

    expect(() =>
      applyManifestWrites(writes, (path, bytes) => {
        writeAttempt++;
        if (writeAttempt === 3) {
          throw new Error("injected third-write failure");
        }
        writeFileSync(path, bytes);
      }),
    ).toThrow("restored 2 touched file(s)");

    for (const path of paths) {
      expect(readFileSync(path, "utf-8")).toBe(originals.get(path));
    }
  });

  it("refuses a stale snapshot before the first write", () => {
    const corePath = manifestPath("core");
    const originalBytes = readFileSync(corePath, "utf-8");
    const writes = [
      {
        path: corePath,
        originalBytes,
        nextBytes: `${originalBytes}\nchanged`,
      },
    ];
    writeFileSync(corePath, `${originalBytes}\nconcurrent change`);

    expect(() => applyManifestWrites(writes)).toThrow("stale snapshot");
    expect(readFileSync(corePath, "utf-8")).toContain("concurrent change");
  });

  it("does not overwrite a concurrent change while rolling back", () => {
    const corePath = manifestPath("core");
    const fakerPath = manifestPath("faker");
    const coreOriginal = readFileSync(corePath, "utf-8");
    const fakerOriginal = readFileSync(fakerPath, "utf-8");
    const writes = [
      {
        path: corePath,
        originalBytes: coreOriginal,
        nextBytes: `${coreOriginal}\ntransaction`,
      },
      {
        path: fakerPath,
        originalBytes: fakerOriginal,
        nextBytes: `${fakerOriginal}\ntransaction`,
      },
    ];
    let writeCount = 0;

    expect(() =>
      applyManifestWrites(writes, (path, bytes) => {
        writeFileSync(path, bytes);
        writeCount++;
        if (writeCount === 2) writeFileSync(corePath, "concurrent owner");
      }),
    ).toThrow("rollback was incomplete");
    expect(readFileSync(corePath, "utf-8")).toBe("concurrent owner");
    expect(readFileSync(fakerPath, "utf-8")).toBe(fakerOriginal);
  });

  it("rejects unknown modes without writing", () => {
    const before = readFileSync(manifestPath("core"), "utf-8");
    const result = run(["patch", "--yes"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("--dry-run or --apply");
    expect(readFileSync(manifestPath("core"), "utf-8")).toBe(before);
  });

  it("stops before writing when versions are not synchronized", () => {
    writeManifest("vue", "2.2.4");
    const result = run(["patch", "--apply"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("versions are not synchronized");
    expect(readManifest("core").version).toBe("2.2.3");
  });

  it("stops before writing when bun.lock is stale", () => {
    const before = readFileSync(manifestPath("core"), "utf-8");
    writeLockfile("2.2.2");

    const result = run(["patch", "--apply"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      "bun.lock workspace packages/core does not exactly match",
    );
    expect(result.output).toContain('"version":"2.2.2"');
    expect(result.output).toContain('"version":"2.2.3"');
    expect(readFileSync(manifestPath("core"), "utf-8")).toBe(before);
    expect(readLockedVersion("core")).toBe("2.2.2");
  });

  it("requires the exact 11-workspace topology", () => {
    rmSync(manifestPath("react"));
    const result = run(["patch", "--apply"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("expected exactly 11 workspaces");
    expect(readManifest("core").version).toBe("2.2.3");
  });
});
