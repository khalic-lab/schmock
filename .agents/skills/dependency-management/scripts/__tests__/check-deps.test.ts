import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "check-deps.sh");
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

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let fixtureRoot = "";
let binDir = "";
let commandLog = "";

function writeManifest(pkg: string, version = "2.2.3"): void {
  const dir = join(fixtureRoot, "packages", pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: `@schmock/${pkg}`, version }, null, 2)}\n`,
  );
}

function makeBunStub(): void {
  const stub = join(binDir, "bun");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"
if [ -n "\${SCHMOCK_TEST_FAIL_MATCH:-}" ] && [[ "$*" == *"$SCHMOCK_TEST_FAIL_MATCH"* ]]; then
  exit 17
fi
`,
  );
  chmodSync(stub, 0o755);
}

function run(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: fixtureRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SCHMOCK_ROOT: fixtureRoot,
      SCHMOCK_TEST_COMMAND_LOG: commandLog,
      ...extraEnv,
    },
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("check-deps.sh", () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "schmock-deps-test-"));
    binDir = join(fixtureRoot, "bin");
    commandLog = join(fixtureRoot, "commands.log");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(fixtureRoot, "package.json"),
      `${JSON.stringify({ private: true, workspaces: ["packages/*"] })}\n`,
    );
    for (const pkg of PACKAGES) writeManifest(pkg);
    makeBunStub();
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("is valid Bash", () => {
    const result = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf-8" });
    expect(result.status).toBe(0);
  });

  it("rejects unknown targets", () => {
    const result = run(["invalid"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown target");
  });

  it("preflights all 11 synchronized workspaces without invoking Bun", () => {
    const result = run(["preflight"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("11 Schmock workspaces");
    expect(result.stdout).toContain("2.2.3");
    expect(existsSync(commandLog)).toBe(false);
  });

  it("prints a registry-free dry run", () => {
    const result = run(["check", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRY RUN: bun outdated --recursive");
    expect(result.stdout).toContain("DRY RUN: bun run check:publish");
    expect(existsSync(commandLog)).toBe(false);
  });

  it("requires an explicit mode for registry-backed checks", () => {
    const result = run(["audit"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("requires --dry-run or --execute");
    expect(existsSync(commandLog)).toBe(false);
  });

  it("executes checks through a local stub when explicitly requested", () => {
    const result = run(["check", "--execute"]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(commandLog, "utf-8")).toBe(
      "outdated --recursive\nrun check:publish\n",
    );
  });

  it("propagates command failures instead of swallowing them", () => {
    const result = run(["audit", "--execute"], {
      SCHMOCK_TEST_FAIL_MATCH: "audit",
    });
    expect(result.exitCode).toBe(17);
    expect(readFileSync(commandLog, "utf-8")).toBe("audit\n");
  });

  it("fails when workspace versions diverge", () => {
    writeManifest("vue", "2.2.4");
    const result = run(["preflight"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("versions are not synchronized");
    expect(existsSync(commandLog)).toBe(false);
  });
});
