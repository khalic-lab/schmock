import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceFixture, removeFixture } from "./test-fixtures";

const script = join(__dirname, "..", "coverage.sh");
let root: string;

function run(args: string[]) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, SCHMOCK_REPO_ROOT: root },
  });
}

describe("coverage.sh", () => {
  beforeEach(() => {
    root = createWorkspaceFixture();
  });

  afterEach(() => {
    removeFixture(root);
  });

  it("rejects a missing package", () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });

  it.each([
    "core",
    "faker",
    "openapi",
    "react",
    "vue",
  ])("discovers %s and plans coverage without running Vitest", (name) => {
    const result = run(["--dry-run", name]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Generating coverage for @schmock/${name}`);
    expect(result.stdout).toContain("vitest");
    expect(result.stdout).toContain("--coverage");
  });

  it("plans the optional pretest before repository-installed Vitest", () => {
    const result = run(["--dry-run", "core"]);
    const pretest = result.stdout.indexOf("bun run pretest");
    const vitest = result.stdout.indexOf(
      join(root, "node_modules", ".bin", "vitest"),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(pretest).toBeGreaterThanOrEqual(0);
    expect(vitest).toBeGreaterThan(pretest);
    expect(result.stdout).not.toContain("bunx");
  });

  it("does not invent a pretest lifecycle for packages without one", () => {
    const result = run(["--dry-run", "faker"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("bun run pretest");
  });

  it("runs pretest before invoking repository-installed Vitest", () => {
    const invocation = join(root, "vitest-invocation.txt");
    const vitest = join(root, "node_modules", ".bin", "vitest");
    writeFileSync(
      vitest,
      [
        "#!/usr/bin/env bash",
        'test -f "$SCHMOCK_REPO_ROOT/pretest.marker"',
        `printf '%s\\n' "$PWD" "$@" > ${JSON.stringify(invocation)}`,
        "",
      ].join("\n"),
    );

    const result = run(["core"]);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, "pretest.marker"))).toBe(true);
    const recorded = readFileSync(invocation, "utf8");
    expect(recorded).toContain(join(root, "packages", "core"));
    expect(recorded).toContain("run\n");
    expect(recorded).toContain("--coverage\n");
  });

  it("does not invoke Vitest when pretest fails", () => {
    const packageJson = join(root, "packages", "core", "package.json");
    writeFileSync(
      packageJson,
      `${JSON.stringify(
        {
          name: "@schmock/core",
          scripts: {
            pretest: "exit 17",
            test: "vitest",
            "test:bdd": "vitest",
          },
        },
        null,
        2,
      )}\n`,
    );
    const invocation = join(root, "vitest-ran.txt");
    writeFileSync(
      join(root, "node_modules", ".bin", "vitest"),
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(invocation)}\n`,
    );

    const result = run(["core"]);

    expect(result.status).not.toBe(0);
    expect(existsSync(invocation)).toBe(false);
  });

  it("fails instead of fetching Vitest when the local binary is absent", () => {
    rmSync(join(root, "node_modules", ".bin", "vitest"));

    const result = run(["--dry-run", "core"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("repository-installed Vitest is missing");
    expect(existsSync(join(root, "pretest.marker"))).toBe(false);
  });

  it("rejects the aggregate workspace because it has no tests", () => {
    const result = run(["--dry-run", "schmock"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no test script");
  });

  it("rejects an obsolete package name", () => {
    const result = run(["--dry-run", "schema"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown package");
  });
});
