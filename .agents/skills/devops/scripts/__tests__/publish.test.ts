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

const SCRIPT = join(__dirname, "..", "publish.sh");
const BUMP_SCRIPT = join(__dirname, "..", "bump.ts");
const REAL_BUN = (
  spawnSync("which", ["bun"], { encoding: "utf-8" }).stdout ?? ""
).trim();
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
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

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

function writeLockfile(version = "2.2.3"): void {
  const workspaces: Record<string, unknown> = { "": { name: "schmock" } };
  const packages: Record<string, unknown> = {};
  for (const pkg of PACKAGES) {
    const name = `@schmock/${pkg}`;
    workspaces[`packages/${pkg}`] = { name, version };
    packages[name] = [`${name}@workspace:packages/${pkg}`];
  }
  writeFileSync(
    join(fixtureRoot, "bun.lock"),
    `${JSON.stringify({ lockfileVersion: 1, workspaces, packages }, null, 2)}\n`,
  );
}

function writeStub(name: string, body: string): void {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function installCommandStubs(): void {
  writeStub(
    "git",
    `printf 'git %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"
case "$*" in
  "branch --show-current") printf '%s\\n' "\${SCHMOCK_TEST_BRANCH:-main}" ;;
  "status --porcelain")
    if [ "\${SCHMOCK_TEST_DIRTY:-0}" = "1" ]; then printf '%s\\n' ' M package.json'; fi
    ;;
  "remote get-url origin"|"remote get-url --push origin")
    printf '%s\\n' "\${SCHMOCK_TEST_ORIGIN:-git@github.com:khalic-lab/schmock.git}"
    ;;
  "rev-parse HEAD") printf '%s\\n' '${HEAD_SHA}' ;;
  "push --dry-run origin main")
    if [ "\${SCHMOCK_TEST_PUSH_DRY_RUN_FAIL:-0}" = "1" ]; then exit 91; fi
    ;;
  "push origin main")
    if [ "\${SCHMOCK_TEST_PUSH_FAIL:-0}" = "1" ]; then exit 92; fi
    ;;
  "ls-remote origin refs/tags/v2.2.3 refs/tags/v2.2.3^{}")
    if [ "\${SCHMOCK_TEST_TAG_QUERY_FAIL:-0}" = "1" ]; then exit 93; fi
    if [ -n "\${SCHMOCK_TEST_TAG_SHA:-}" ]; then
      printf '%s\\trefs/tags/v2.2.3\\n' "$SCHMOCK_TEST_TAG_SHA"
    fi
    ;;
esac`,
  );

  writeStub(
    "bun",
    `printf 'bun %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"
if [ "\${1:-}" = "${BUMP_SCRIPT}" ] && [ "\${2:-}" = "check-lockfile" ]; then
  exec "$SCHMOCK_TEST_REAL_BUN" "$@"
fi
if [ -n "\${SCHMOCK_TEST_BUN_FAIL:-}" ] && [ "$*" = "$SCHMOCK_TEST_BUN_FAIL" ]; then exit 91; fi`,
  );

  writeStub(
    "npm",
    `printf 'npm %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"
case "$1" in
  whoami)
    printf '%s\\n' 'schmock-test-publisher'
    ;;
  view)
    spec="$2"
    pkg="\${spec#@schmock/}"
    pkg="\${pkg%@*}"
    if [ "\${SCHMOCK_TEST_QUERY_FAILURE:-}" = "$pkg" ]; then
      printf '%s\\n' 'ECONNRESET registry unavailable' >&2
      exit 94
    fi
    case ",\${SCHMOCK_TEST_PUBLISHED:-}," in
      *",$pkg,"*)
        if [ "\${SCHMOCK_TEST_INTEGRITY_MISMATCH:-}" = "$pkg" ]; then
          printf '%s\\n' '"sha512-remote"'
        else
          printf '%s\\n' '"sha512-match"'
        fi
        ;;
      *)
        printf '%s\\n' 'npm ERR! code E404' >&2
        exit 1
        ;;
    esac
    ;;
  pack)
    pkg_path="$2"
    pkg="\${pkg_path#./packages/}"
    if [ "\${SCHMOCK_TEST_PACK_FAILURE:-}" = "$pkg" ]; then exit 95; fi
    printf '%s\\n' '[{"integrity":"sha512-match"}]'
    ;;
  publish)
    pkg_path="$2"
    pkg="\${pkg_path#./packages/}"
    if [ "\${SCHMOCK_TEST_PUBLISH_FAILURE:-}" = "$pkg" ]; then exit 96; fi
    ;;
esac`,
  );

  writeStub(
    "gh",
    `printf 'gh %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"
case "$1 $2" in
  "auth status")
    if [ "\${SCHMOCK_TEST_GH_AUTH_FAIL:-0}" = "1" ]; then exit 97; fi
    ;;
  "release view")
    if [ "\${SCHMOCK_TEST_RELEASE_QUERY_FAIL:-0}" = "1" ]; then
      printf '%s\\n' 'authentication failed' >&2
      exit 98
    fi
    if [ "\${SCHMOCK_TEST_RELEASE_EXISTS:-0}" = "1" ]; then
      printf '%s\\n' '{"tagName":"v2.2.3"}'
    else
      printf '%s\\n' 'release not found' >&2
      exit 1
    fi
    ;;
  "release create")
    if [ "\${SCHMOCK_TEST_RELEASE_CREATE_FAIL:-0}" = "1" ]; then exit 99; fi
    ;;
esac`,
  );
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
      SCHMOCK_TEST_REAL_BUN: REAL_BUN,
      ...extraEnv,
    },
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

function commands(): string {
  return existsSync(commandLog) ? readFileSync(commandLog, "utf-8") : "";
}

describe("publish.sh", () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "schmock-publish-test-"));
    binDir = join(fixtureRoot, "bin");
    commandLog = join(fixtureRoot, "commands.log");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(fixtureRoot, "package.json"),
      `${JSON.stringify({ private: true, workspaces: ["packages/*"] })}\n`,
    );
    for (const pkg of PACKAGES) writeManifest(pkg);
    writeLockfile();
    installCommandStubs();
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("is valid Bash", () => {
    const result = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf-8" });
    expect(result.status).toBe(0);
  });

  it("defaults to a local-only preflight", () => {
    const result = run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("11 workspaces synchronized at 2.2.3");
    expect(result.stdout).toContain("No external actions executed");
    expect(commands()).toBe(
      `bun ${BUMP_SCRIPT} check-lockfile\ngit branch --show-current\ngit status --porcelain\ngit remote get-url origin\ngit remote get-url --push origin\ngit rev-parse HEAD\n`,
    );
  });

  it("rejects stale lock metadata during preflight", () => {
    writeLockfile("2.2.2");

    const result = run(["--preflight"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "release lockfile does not match the workspace manifests",
    );
    expect(commands()).toBe(`bun ${BUMP_SCRIPT} check-lockfile\n`);
  });

  it("dry-runs all 11 packages without executing external commands", () => {
    const result = run(["all", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no registry queries");
    expect(result.stdout.match(/npm publish \.\/packages\//g)).toHaveLength(11);
    expect(result.stdout).toContain("git push origin main");
    expect(result.stdout).toContain("gh release create v2.2.3");
    expect(result.stdout).toContain("bun run lint");
    expect(result.stdout).toContain("bun run test:all");
    expect(result.stdout).toContain("bun run build");
    expect(result.stdout).toContain("bun run check:publish");
    expect(result.stdout).toContain("https://registry.npmjs.org/");
    expect(result.stdout).toContain("--repo khalic-lab/schmock");
    expect(result.stdout).toContain(`--confirm all@v2.2.3:${HEAD_SHA}`);
    expect(result.stdout).not.toContain(":quiet");
    expect(commands()).not.toContain("bun run ");
    expect(commands()).not.toContain("npm ");
    expect(commands()).not.toContain("gh ");
    expect(commands()).not.toContain("git push");
  });

  it("dry-runs a single package without planning a push or release", () => {
    const result = run(["core", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("npm publish ./packages/core");
    expect(result.stdout).toContain(
      "would not push or create a GitHub release",
    );
    expect(result.stdout).not.toContain("git push origin main");
    expect(result.stdout).not.toContain("gh release create");
    expect(result.stdout).toContain(`--confirm core@v2.2.3:${HEAD_SHA}`);
  });

  it("binds execute confirmation to scope, version, and commit", () => {
    const missing = run(["all", "--execute"]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain(
      `requires --confirm all@v2.2.3:${HEAD_SHA}`,
    );

    rmSync(commandLog, { force: true });
    const wrong = run([
      "core",
      "--execute",
      "--confirm",
      `all@v2.2.3:${HEAD_SHA}`,
    ]);
    expect(wrong.exitCode).not.toBe(0);
    expect(wrong.stderr).toContain(
      `requires --confirm core@v2.2.3:${HEAD_SHA}`,
    );
    expect(commands()).not.toContain("bun run ");
    expect(commands()).not.toContain("npm ");
    expect(commands()).not.toContain("gh ");
    expect(commands()).not.toContain("git push");
  });

  it("rejects dirty or non-main release worktrees", () => {
    const dirty = run(["--preflight"], { SCHMOCK_TEST_DIRTY: "1" });
    expect(dirty.exitCode).not.toBe(0);
    expect(dirty.stderr).toContain("clean worktree");

    rmSync(commandLog, { force: true });
    const branch = run(["--preflight"], { SCHMOCK_TEST_BRANCH: "develop" });
    expect(branch.exitCode).not.toBe(0);
    expect(branch.stderr).toContain("require the main branch");
  });

  it("rejects a non-canonical push destination", () => {
    const result = run(["all", "--preflight"], {
      SCHMOCK_TEST_ORIGIN: "git@github.com:someone/schmock.git",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("canonical khalic-lab/schmock");
  });

  it("rejects unknown package targets before any command runs", () => {
    const result = run(["unknown", "--dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown package");
    expect(commands()).toBe("");
  });

  it("front-loads validation and every registry query before publishing", () => {
    const result = run([
      "all",
      "--execute",
      "--confirm",
      `all@v2.2.3:${HEAD_SHA}`,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);

    const lines = commands().trim().split("\n");
    const views = lines
      .map((line, index) => (line.startsWith("npm view ") ? index : -1))
      .filter((index) => index >= 0);
    const publishes = lines
      .map((line, index) => (line.startsWith("npm publish ") ? index : -1))
      .filter((index) => index >= 0);

    expect(lines).toContain("bun run check:publish");
    expect(lines).toContain(
      "npm whoami --registry https://registry.npmjs.org/",
    );
    expect(views).toHaveLength(11);
    expect(publishes).toHaveLength(11);
    expect(Math.max(...views)).toBeLessThan(Math.min(...publishes));
    expect(lines).toContain("git push --dry-run origin main");
    expect(lines).toContain("git push origin main");
    expect(lines).toContain(
      `gh release create v2.2.3 --repo khalic-lab/schmock --target ${HEAD_SHA} --title v2.2.3 --notes Release v2.2.3 — all 11 @schmock/* packages.`,
    );
  });

  it("aborts before every publish when a later registry query fails", () => {
    const result = run(
      ["all", "--execute", "--confirm", `all@v2.2.3:${HEAD_SHA}`],
      { SCHMOCK_TEST_QUERY_FAILURE: "validation" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not determine npm status");
    expect(commands()).not.toContain("npm publish ");
    expect(commands()).not.toContain("git push origin main\n");
    expect(commands()).not.toContain("gh release create");
  });

  it("verifies identical contents before skipping an existing npm version", () => {
    const result = run(
      ["core", "--execute", "--confirm", `core@v2.2.3:${HEAD_SHA}`],
      { SCHMOCK_TEST_PUBLISHED: "core" },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("already on npm");
    expect(commands()).toContain("npm pack ./packages/core --dry-run --json");
    expect(commands()).not.toContain("npm publish ");
    expect(commands()).not.toContain("git push");
    expect(commands()).not.toContain("gh ");
  });

  it("rejects an existing npm version with different contents", () => {
    const result = run(
      ["core", "--execute", "--confirm", `core@v2.2.3:${HEAD_SHA}`],
      {
        SCHMOCK_TEST_PUBLISHED: "core",
        SCHMOCK_TEST_INTEGRITY_MISMATCH: "core",
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("different package contents");
    expect(commands()).not.toContain("npm publish ");
  });

  it("rejects an existing release tag that targets another commit", () => {
    const result = run(
      ["all", "--execute", "--confirm", `all@v2.2.3:${HEAD_SHA}`],
      {
        SCHMOCK_TEST_RELEASE_EXISTS: "1",
        SCHMOCK_TEST_TAG_SHA: "ffffffffffffffffffffffffffffffffffffffff",
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not point to the confirmed");
    expect(commands()).not.toContain("npm view ");
    expect(commands()).not.toContain("npm publish ");
  });

  it("stops finalization after an npm publish failure", () => {
    const result = run(
      ["all", "--execute", "--confirm", `all@v2.2.3:${HEAD_SHA}`],
      { SCHMOCK_TEST_PUBLISH_FAILURE: "validation" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(commands().match(/^npm publish /gm)).toHaveLength(3);
    expect(commands()).not.toContain("git push origin main\n");
    expect(commands()).not.toContain("gh release create");
  });

  it("contains guarded publish, push, and unified release commands", () => {
    const content = readFileSync(SCRIPT, "utf-8");
    expect(content).toMatch(
      /npm publish "\.\/\$\{pkg_dir\}" --access public --registry/,
    );
    expect(content).toContain("git push origin main");
    expect(content).toContain('gh release create "$tag"');
    expect(content).toMatch(
      /EXPECTED_CONFIRM="\$\{TARGET\}@v\$\{VERSION\}:\$\{HEAD_SHA\}"/,
    );
  });
});
