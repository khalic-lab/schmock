import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESLint } from "eslint";

/**
 * Repository tooling that no package suite covers: the root ESLint config,
 * the Git hooks under .githooks/, and the meta-only release-candidate stage of
 * scripts/check-release-candidate.sh.
 */

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT_MSG_HOOK = join(ROOT_DIR, ".githooks/commit-msg");
const RELEASE_CANDIDATE_SCRIPT = join(
  ROOT_DIR,
  "scripts/check-release-candidate.sh",
);
const META_CONSUMER = join(ROOT_DIR, "scripts/release-candidate-meta.js");
const META_SOURCE = join(ROOT_DIR, "packages/schmock/src/index.ts");
const TSC_BIN = join(ROOT_DIR, "node_modules/.bin/tsc");

/**
 * Runs the commit-msg hook on a message file and returns its exit status.
 * `config` adds git config entries for the run, as `git -c` would.
 */
function commitMsgStatus(message, config = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "schmock-commit-msg-"));
  const messageFile = join(workdir, "COMMIT_EDITMSG");
  try {
    writeFileSync(messageFile, message);
    const entries = Object.entries(config);
    const env = { ...process.env, GIT_CONFIG_COUNT: String(entries.length) };
    entries.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    const result = spawnSync("sh", [COMMIT_MSG_HOOK, messageFile], {
      encoding: "utf8",
      env,
    });
    return result.status;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

test("commit-msg accepts conventional and merge subjects", () => {
  for (const message of [
    "fix(core): keep the route table intact\n",
    "feat: add a subject without a scope\n\nWith a body.\n",
    `docs: ${"a long description ".repeat(6)}\n`,
    "Merge branch 'feature/x' into develop\n",
    // Git hands the hook the message before it strips comments and leading
    // blank lines.
    "\n# Please enter the commit message.\nchore(tooling): subject after a comment\n",
  ]) {
    assert.equal(commitMsgStatus(message), 0, JSON.stringify(message));
  }
});

test("commit-msg judges the subject, not a later line", () => {
  for (const message of [
    "updated stuff\n",
    "WIP do not merge\n\nfix: a conventional-looking body line\n",
    "WIP\nMerge branch 'x'\n",
    "fix:missing space after the colon\n",
    "# only a comment\n",
  ]) {
    assert.equal(commitMsgStatus(message), 1, JSON.stringify(message));
  }
});

test("commit-msg accepts autosquash subjects over a conventional subject", () => {
  // `git commit --fixup=amend:<sha>` and `--fixup=reword:<sha>` write
  // "amend! <original subject>" followed by the original message;
  // `--fixup` and `--squash` write "fixup! " and "squash! " subjects.
  for (const message of [
    "amend! fix(core): keep the route table intact\n\nfix(core): keep the route table intact\n",
    "fixup! fix(core): keep the route table intact\n",
    "squash! feat: add a subject without a scope\n\nMore detail.\n",
    "fixup! amend! fix(core): keep the route table intact\n",
    // Only the leading marker goes: a "! " later in the subject stays.
    "fixup! fix: wow! nice\n",
  ]) {
    assert.equal(commitMsgStatus(message), 0, JSON.stringify(message));
  }
  for (const message of [
    "fixup! updated stuff\n",
    "amend! WIP\n\nfix(core): keep the route table intact\n",
    "fixup!fix: no space after the marker\n",
    "fixup! WIP! fix: a conventional tail after a later bang\n",
  ]) {
    assert.equal(commitMsgStatus(message), 1, JSON.stringify(message));
  }
});

test("commit-msg skips comments in the configured comment character", () => {
  const semicolon = { "core.commentChar": ";" };
  assert.equal(commitMsgStatus("; a comment\nfix: subject\n", semicolon), 0);
  assert.equal(
    commitMsgStatus("# not a comment here\nfix: subject\n", semicolon),
    1,
  );
  assert.equal(
    commitMsgStatus("; a comment\nfix: subject\n", {
      "core.commentChar": "auto",
    }),
    0,
  );
  assert.equal(
    commitMsgStatus("// a comment\nfix: subject\n", {
      "core.commentString": "//",
    }),
    0,
  );
});

test("eslint skips agent worktrees and skill copies", async () => {
  const eslint = new ESLint({ cwd: ROOT_DIR });

  // ESLint looks up the config per file, so a worktree under .claude/ would
  // be linted with its own typed config. These paths need not exist, so
  // isPathIgnored resolves them against the root config: this shows that the
  // root config names them, not that a real nested worktree is skipped.
  // JavaScript paths are used because ESLint lints them by default: a .ts
  // path outside packages/*/src matches no config and reads as ignored
  // whether or not the ignore is there.
  for (const path of [
    ".claude/worktrees/agent-x/eslint.config.mjs",
    ".claude/worktrees/agent-x/packages/core/scripts/build.js",
    ".agents/skills/devops/scripts/helper.mjs",
  ]) {
    assert.equal(await eslint.isPathIgnored(join(ROOT_DIR, path)), true, path);
  }

  for (const path of ["packages/core/src/index.ts", "eslint.config.mjs"]) {
    assert.equal(await eslint.isPathIgnored(join(ROOT_DIR, path)), false, path);
  }
});

test("eslint does not lint a nested worktree with its own config", async () => {
  // ESLint looks up the config per file, so without the ignore a worktree
  // under .claude/ is linted with its own config (and, in a real worktree,
  // its own typed project service). Build a scratch tree that uses the root
  // config, holding a nested worktree and an unignored control directory,
  // each with a config that turns on no-debugger and a file that breaks it.
  const scratch = mkdtempSync(join(tmpdir(), "schmock-eslint-worktree-"));
  try {
    writeFileSync(
      join(scratch, "eslint.config.mjs"),
      `export { default } from ${JSON.stringify(
        pathToFileURL(join(ROOT_DIR, "eslint.config.mjs")).href,
      )};\n`,
    );
    const nestedConfig =
      'export default [{ rules: { "no-debugger": "error" } }];\n';
    for (const dir of [".claude/worktrees/agent-x", "control/agent-x"]) {
      mkdirSync(join(scratch, dir), { recursive: true });
      writeFileSync(join(scratch, dir, "eslint.config.mjs"), nestedConfig);
      writeFileSync(join(scratch, dir, "bad.js"), "debugger;\n");
    }

    const eslint = new ESLint({ cwd: scratch });
    const linted = (await eslint.lintFiles(["."])).map((result) =>
      relative(scratch, result.filePath).split(sep).join("/"),
    );

    assert.ok(linted.includes("control/agent-x/bad.js"), linted.join(", "));
    assert.deepEqual(
      linted.filter((path) => path.startsWith(".claude/")),
      [],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ── Meta-only release-candidate consumer ────────────────────────────────────

/** The names packages/schmock/src/index.ts re-exports from @schmock/core. */
function metaSourceExports() {
  const source = readFileSync(META_SOURCE, "utf8");
  const match = /export\s*\{([^}]*)\}\s*from\s*"@schmock\/core"/.exec(source);
  assert.ok(match, `${META_SOURCE} has no re-export from @schmock/core`);
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

const DOCUMENTED = metaSourceExports();

function writePackage(directory, manifest, files) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
}

function packageManifest(name, extra = {}) {
  return {
    name,
    version: "9.9.9",
    type: "module",
    exports: {
      ".": { types: "./index.d.ts", default: "./index.js" },
      "./package.json": "./package.json",
    },
    ...extra,
  };
}

/**
 * Builds the layout `bun install --linker isolated` gives the meta-only
 * fixture: @schmock/schmock alone at the root, a link into its store
 * directory under node_modules/.bun, and @schmock/core beside it there,
 * reachable only from inside it. Each option breaks that layout one way.
 */
function metaFixture({
  coreNames = DOCUMENTED,
  runtimeReexports = DOCUMENTED,
  typeReexports = runtimeReexports,
  coreLocation = "sibling",
  metaDependencies = { "@schmock/core": "9.9.9" },
  fixtureDependencies = { "@schmock/schmock": "file:schmock.tgz" },
  overrides = {
    "@schmock/core": "file:core.tgz",
    "@schmock/schmock": "file:schmock.tgz",
  },
} = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "schmock-meta-consumer-"));
  writeFileSync(
    join(fixture, "package.json"),
    `${JSON.stringify({
      private: true,
      dependencies: fixtureDependencies,
      overrides,
    })}\n`,
  );
  writeFileSync(
    join(fixture, "candidates.tsv"),
    "@schmock/core\t9.9.9\tcore.package.json\n" +
      "@schmock/schmock\t9.9.9\tschmock.package.json\n",
  );
  copyFileSync(META_CONSUMER, join(fixture, "meta-consumer.mjs"));

  const metaDir = join(
    fixture,
    "node_modules/.bun/@schmock+schmock@9.9.9/node_modules/@schmock/schmock",
  );
  mkdirSync(join(fixture, "node_modules/@schmock"), { recursive: true });
  const reexport = (names) =>
    `export { ${names.join(", ")} } from "@schmock/core";\n`;
  writePackage(
    metaDir,
    packageManifest("@schmock/schmock", { dependencies: metaDependencies }),
    {
      "index.js": reexport(runtimeReexports),
      // The real declaration file opens with the source's docblock, whose
      // usage examples import from packages the meta-package does not
      // declare (itself included).
      "index.d.ts": `/**
 * import { schmock } from "@schmock/schmock";
 * import { openapi } from "@schmock/unlisted";
 */
${reexport(typeReexports)}`,
    },
  );
  symlinkSync(metaDir, join(fixture, "node_modules/@schmock/schmock"), "dir");

  // Just enough of core for the consumer's requests: a route table and a 404
  // helper. Every other name is a function that does nothing.
  const coreRuntime = coreNames
    .map((name) => {
      if (name === "schmock") {
        return `export function schmock() {
  const routes = new Map();
  const mock = (key, generator) => routes.set(key, generator);
  mock.handle = async (method, path) => {
    const generator = routes.get(\`\${method} \${path}\`);
    const output = typeof generator === "function" ? generator() : generator;
    return Array.isArray(output)
      ? { status: output[0], body: output[1] }
      : { status: 200, body: output };
  };
  return mock;
}`;
      }
      if (name === "notFound") {
        return 'export function notFound() { return [404, { message: "Not Found" }]; }';
      }
      return `export function ${name}() {}`;
    })
    .join("\n");
  const coreTypes = coreNames
    .map((name) => `export declare function ${name}(...args: unknown[]): any;`)
    .join("\n");
  // "sibling" puts core beside the meta-package in its store directory, where
  // bun links a declared dependency; "fallback" puts it in the hoisted copy
  // under node_modules/.bun/node_modules, which every package in the store
  // resolves whether or not it declares core.
  const coreDirs = {
    sibling: join(dirname(metaDir), "core"),
    root: join(fixture, "node_modules/@schmock/core"),
    fallback: join(fixture, "node_modules/.bun/node_modules/@schmock/core"),
  };
  if (coreLocation !== "absent") {
    writePackage(coreDirs[coreLocation], packageManifest("@schmock/core"), {
      "index.js": `${coreRuntime}\n`,
      "index.d.ts": `${coreTypes}\n`,
    });
  }
  return fixture;
}

function runMetaConsumer(options) {
  const fixture = metaFixture(options);
  try {
    const result = spawnSync(process.execPath, ["meta-consumer.mjs"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, TSC_BIN },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const without = (names, removed) => names.filter((name) => name !== removed);

test("the meta consumer checks the names the meta-package documents", () => {
  // The consumer pins its own list and fails on any export outside it, so a
  // meta-package re-exporting exactly the source's names passes only while
  // the two lists agree.
  const passed = runMetaConsumer();
  assert.equal(passed.status, 0, passed.output);
  assert.match(
    passed.output,
    new RegExp(`type-checks all ${DOCUMENTED.length} documented re-exports`),
  );

  // The source's docblock is what tells users which names it re-exports:
  // `schmock` and a parenthesised list of response helpers, which must be
  // exactly the names the source re-exports.
  const docblock = /^\/\*\*[\s\S]*?\*\//.exec(
    readFileSync(META_SOURCE, "utf8"),
  )?.[0];
  assert.ok(docblock, `${META_SOURCE} has no leading docblock`);
  const prose = docblock.replace(/^\s*\*+\s?/gm, "").replace(/\s+/g, " ");
  const clause =
    /re-exports only `(\w+)` and the response helpers \(([^)]*)\)/.exec(prose);
  assert.ok(clause, `${META_SOURCE}'s docblock does not list its re-exports`);
  const listed = clause[2]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  assert.deepEqual([clause[1], ...listed].sort(), DOCUMENTED);
});

test("the meta consumer fails when a re-export does not resolve at runtime", () => {
  const result = runMetaConsumer({
    coreNames: without(DOCUMENTED, "paginate"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /does not load on its own/);
  assert.match(result.output, /paginate/);
});

test("the meta consumer fails when a re-export does not type-check", () => {
  const result = runMetaConsumer({
    typeReexports: without(DOCUMENTED, "paginate"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /has no exported member 'paginate'/);
  assert.match(result.output, /do not type-check on their own/);
});

test("the meta consumer fails on a @schmock/* import its manifest does not declare", () => {
  // The isolated install's hoisted fallback resolves core for the
  // meta-package even when it is not declared.
  const result = runMetaConsumer({
    coreLocation: "fallback",
    metaDependencies: {},
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.output,
    /imports @schmock\/core in index\.(?:d\.ts|js) but does not declare it as a dependency/,
  );
});

test("the meta consumer fails when the fixture does not override a candidate", () => {
  const result = runMetaConsumer({
    overrides: { "@schmock/schmock": "file:schmock.tgz" },
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.output,
    /does not override @schmock\/core to its packed tarball/,
  );
});

test("the meta consumer fails when the meta-package cannot reach core", () => {
  const result = runMetaConsumer({ coreLocation: "absent" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /cannot resolve its dependency @schmock\/core/);
});

test("the meta consumer fails on an export its documentation does not list", () => {
  const result = runMetaConsumer({
    coreNames: [...DOCUMENTED, "undocumented"],
    runtimeReexports: [...DOCUMENTED, "undocumented"],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /exports names its documentation does not list/);
});

test("the meta consumer refuses a fixture that is not meta-only", () => {
  // Hoisted, core would resolve whether or not the meta-package declares it.
  const hoisted = runMetaConsumer({ coreLocation: "root" });
  assert.notEqual(hoisted.status, 0);
  assert.match(hoisted.output, /resolvable from the meta-only fixture root/);

  const direct = runMetaConsumer({
    fixtureDependencies: {
      "@schmock/core": "file:core.tgz",
      "@schmock/schmock": "file:schmock.tgz",
    },
  });
  assert.notEqual(direct.status, 0);
  assert.match(direct.output, /must depend on @schmock\/schmock alone/);
});

test("check-release-candidate.sh runs the meta-only consumer", () => {
  const syntax = spawnSync("bash", ["-n", RELEASE_CANDIDATE_SCRIPT], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);

  const dryRun = spawnSync("bash", [RELEASE_CANDIDATE_SCRIPT, "--dry-run"], {
    encoding: "utf8",
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(
    dryRun.stdout,
    /^\[meta 1\/1\] Install the @schmock\/schmock tarball alone/m,
  );

  // The stage copies the consumer into its own fixture and runs it there,
  // with the repository's tsc, after an isolated install.
  const script = readFileSync(RELEASE_CANDIDATE_SCRIPT, "utf8");
  assert.match(
    script,
    /cp "\$ROOT_DIR\/scripts\/release-candidate-meta\.js" "\$META_FIXTURE_DIR\/meta-consumer\.mjs"/,
  );
  // Its manifest depends on the meta tarball alone and carries the main
  // consumer's overrides.
  assert.match(
    script,
    /dependencies: \{ \[metaPackage\]: tarball \},\n\s*overrides: consumer\.overrides,/,
  );
  const stage = script.slice(script.indexOf('cd "$META_FIXTURE_DIR"'));
  assert.match(stage, /^\s*bun install --linker isolated$/m);
  assert.match(
    stage,
    /^\s*TSC_BIN="\$ROOT_DIR\/node_modules\/\.bin\/tsc" node \.\/meta-consumer\.mjs$/m,
  );
});

// macOS still ships Bash 3.2 as /bin/bash, and the release scripts run under
// whichever bash comes first on PATH. Before 4.4, `set -u` treats "${arr[@]}"
// of an empty array as an unbound variable.
const SYSTEM_BASH = "/bin/bash";

test("check-release-candidate.sh runs under the system Bash", {
  skip: !existsSync(SYSTEM_BASH) && `${SYSTEM_BASH} is absent`,
}, () => {
  const dryRun = spawnSync(
    SYSTEM_BASH,
    [RELEASE_CANDIDATE_SCRIPT, "--dry-run"],
    { encoding: "utf8" },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /^Discovered \d+ release-candidate packages$/m);
});

// ── Tarball allowlist ───────────────────────────────────────────────────────

const REAL_BUN = spawnSync("sh", ["-c", "command -v bun"], {
  encoding: "utf8",
}).stdout.trim();

/**
 * Runs a copy of check-release-candidate.sh against a one-package workspace
 * whose `bun pm pack` (a stub) packs exactly `entries` under package/. The
 * publint stub stops the run, so a tarball that passes the allowlist reports
 * "publint reached" and goes no further.
 *
 * With `throughRanges`, publint and attw pass, `bun -e` runs the real Bun, and
 * the stubbed `bun install` stops the run instead, reporting
 * "install reached" and the dependency names of the consumer manifest the
 * ranges stage wrote. `packedManifest` replaces the packed package.json.
 * `shell` is the bash that runs the script.
 */
function packAllowlistRun(
  entries,
  { shell = "bash", throughRanges = false, packedManifest } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "schmock-pack-allowlist-"));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(
      RELEASE_CANDIDATE_SCRIPT,
      join(root, "scripts/check-release-candidate.sh"),
    );
    writePackage(
      join(root, "packages/fixture"),
      { name: "@schmock/fixture", version: "9.9.9" },
      {},
    );
    const stub = (path, body) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    stub(
      join(root, "node_modules/.bin/publint"),
      throughRanges ? "exit 0" : 'echo "publint reached"; exit 3',
    );
    stub(
      join(root, "node_modules/.bin/attw"),
      throughRanges ? "exit 0" : "exit 3",
    );
    stub(join(root, "packages/openapi/node_modules/.bin/esbuild"), "exit 3");
    if (throughRanges) {
      // The consumer scripts the stage after the ranges copies in.
      for (const name of [
        "release-candidate-consumer.js",
        "release-candidate-types.js",
        "release-candidate-browser.js",
        "release-candidate-browser-openapi.js",
      ]) {
        writeFileSync(join(root, "scripts", name), "");
      }
    }
    const bin = join(root, "bin");
    stub(
      join(bin, "bun"),
      `[ "$1" = "-e" ] && exec "$SCHMOCK_TEST_REAL_BUN" "$@"
[ "$1" = "install" ] && {
  echo "install reached"
  node -e 'console.log("consumer dependencies: " + JSON.stringify(Object.keys(require("./package.json").dependencies)))'
  exit 3
}
[ "$1 $2 $3" = "pm pack --destination" ] || exit 3
stage=$(mktemp -d)
cd "$stage" || exit 3
for entry in $SCHMOCK_TEST_PACK_ENTRIES; do
  mkdir -p "$(dirname "$entry")"
  echo '{}' > "$entry"
done
[ -n "$SCHMOCK_TEST_PACKED_MANIFEST" ] && printf '%s' "$SCHMOCK_TEST_PACKED_MANIFEST" > package/package.json
tar -czf "$4/schmock-fixture-9.9.9.tgz" $SCHMOCK_TEST_PACK_ENTRIES`,
    );
    const result = spawnSync(
      shell,
      [join(root, "scripts/check-release-candidate.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          TMPDIR: root,
          SCHMOCK_TEST_PACK_ENTRIES: entries.join(" "),
          SCHMOCK_TEST_REAL_BUN: REAL_BUN,
          SCHMOCK_TEST_PACKED_MANIFEST: packedManifest
            ? JSON.stringify(packedManifest)
            : "",
        },
      },
    );
    return `${result.stdout}${result.stderr}`;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the tarball allowlist passes metadata, dist and stub manifests", () => {
  const output = packAllowlistRun([
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/dist/index.js",
    "package/adapter/package.json",
    "package/adapter/README.md",
  ]);
  assert.doesNotMatch(output, /non-distributable/);
  assert.match(output, /publint reached/);
});

test("the tarball allowlist rejects names that only start with an allowed file", () => {
  const forbidden = [
    "package/LICENSE.orig",
    "package/README.md.bak",
    "package/package.json.tmp",
    "package/LICENSEsrc/secret.ts",
    "package/adapter/package.json.bak",
    // The dots are literal: no other character stands in for them.
    "package/packageXjson",
    "package/READMEXmd",
  ];
  const output = packAllowlistRun(["package/package.json", ...forbidden]);
  assert.match(output, /included non-distributable files/);
  for (const entry of forbidden) {
    assert.ok(
      output.includes(`  - ${entry}\n`),
      `${entry} not flagged:\n${output}`,
    );
  }
  assert.doesNotMatch(output, /publint reached/);
});

test("check-release-candidate.sh passes no consumer extras under the system Bash", {
  skip: !existsSync(SYSTEM_BASH) && `${SYSTEM_BASH} is absent`,
}, () => {
  // @schmock/fixture adds no consumer dependency, so the extras array the
  // ranges stage expands is empty: Bash 3.2 must still reach the install.
  const output = packAllowlistRun(
    ["package/package.json", "package/dist/index.js"],
    { shell: SYSTEM_BASH, throughRanges: true },
  );
  assert.doesNotMatch(output, /unbound variable/);
  assert.match(output, /^\[ranges 1\/1\]/m);
  assert.match(output, /^install reached$/m);
  // No empty extra spec either: the consumer depends on the candidate alone.
  assert.match(output, /^consumer dependencies: \["@schmock\/fixture"\]$/m);
});

test("the ranges stage stops on an internal range that rejects a candidate", () => {
  const output = packAllowlistRun(
    ["package/package.json", "package/dist/index.js"],
    {
      throughRanges: true,
      packedManifest: {
        name: "@schmock/fixture",
        version: "9.9.9",
        peerDependencies: { "@schmock/fixture": "^1.0.0" },
      },
    },
  );
  assert.match(
    output,
    /declares peerDependencies\.@schmock\/fixture as "\^1\.0\.0", which does not accept release candidate 9\.9\.9/,
  );
  assert.doesNotMatch(output, /install reached/);
});
