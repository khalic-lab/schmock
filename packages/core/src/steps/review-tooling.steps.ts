import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { createViteServer } from "vitest/node";
import { distJsSize, sourceSize } from "../../../../benchmarks/bundle-size";
import { createParamRouteLookup } from "../../../../benchmarks/handle-throughput";

const feature = await loadFeature("../../features/review-tooling.feature");

const repoRoot = resolve(import.meta.dirname, "../../../..");
const gateScript = join(repoRoot, "scripts/check-browser-node-imports.mjs");

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf-8",
    env: { ...process.env, ...options.env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeStub(binDir: string, name: string, body: string): void {
  const path = join(binDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** One external import of an esbuild metafile output. */
interface ExternalImport {
  path: string;
  kind: "dynamic-import" | "import-statement" | "require-call";
}

/**
 * An esbuild metafile with one output whose externals are `externals`. A bare
 * specifier is a lazy `import()`, which is how core reaches `node:http`.
 */
function metafileWithExternals(
  externals: Array<string | ExternalImport>,
): string {
  return JSON.stringify({
    inputs: {},
    outputs: {
      "bundle.js": {
        imports: externals.map((external) => ({
          ...(typeof external === "string"
            ? { path: external, kind: "dynamic-import" }
            : external),
          external: true,
        })),
      },
    },
  });
}

/**
 * Shell commands of `text` in order: backslash continuations joined, leading
 * indentation removed.
 */
function commandLines(text: string): string[] {
  return text
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim());
}

interface Fixture {
  root: string;
  binDir: string;
  commandLog: string;
}

function createFixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  return { root, binDir, commandLog: join(root, "commands.log") };
}

function loggedCommands(fixture: Fixture): string[] {
  if (!existsSync(fixture.commandLog)) return [];
  return readFileSync(fixture.commandLog, "utf-8").split("\n").filter(Boolean);
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  const cleanup: string[] = [];

  AfterEachScenario(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── #115: the browser gate reads esbuild metafiles, not bundle text ──────

  function gateScenario(): {
    givenMetafile: (externals: Array<string | ExternalImport>) => void;
    check: () => void;
    result: () => CommandResult;
  } {
    let metafilePath = "";
    let result: CommandResult = { exitCode: -1, stdout: "", stderr: "" };
    return {
      givenMetafile: (externals) => {
        const dir = mkdtempSync(join(tmpdir(), "schmock-browser-gate-"));
        cleanup.push(dir);
        metafilePath = join(dir, "meta.json");
        writeFileSync(metafilePath, metafileWithExternals(externals));
      },
      check: () => {
        result = runCommand("node", [
          gateScript,
          "--allow",
          "node:http",
          metafilePath,
        ]);
      },
      result: () => result,
    };
  }

  Scenario(
    "The browser gate rejects a Node built-in that is not on the allowlist",
    ({ Given, When, Then }) => {
      const gate = gateScenario();

      Given(
        'an esbuild metafile whose bundle imports "node:http" and "node:util" as externals',
        () => gate.givenMetafile(["node:http", "node:util"]),
      );

      When(
        'I check it with the browser Node-import gate allowing only "node:http"',
        () => gate.check(),
      );

      Then('the gate fails and names "node:util"', () => {
        expect(gate.result().exitCode).toBe(1);
        expect(gate.result().stderr).toContain("node:util");
      });
    },
  );

  Scenario(
    "The browser gate accepts a bundle whose only Node import is allowlisted",
    ({ Given, When, Then }) => {
      const gate = gateScenario();

      Given(
        'an esbuild metafile whose bundle imports "node:http" as an external',
        () => gate.givenMetafile(["node:http"]),
      );

      When(
        'I check it with the browser Node-import gate allowing only "node:http"',
        () => gate.check(),
      );

      Then("the gate passes", () => {
        expect(gate.result().stderr).toBe("");
        expect(gate.result().exitCode).toBe(0);
      });
    },
  );

  // A static `import "node:http"` passes esbuild's `--external:node:*` but
  // fails Angular's builder, which externalises nothing: only a caught
  // `import()` survives there.
  Scenario(
    "The browser gate rejects a static import of an allowlisted built-in",
    ({ Given, When, Then }) => {
      const gate = gateScenario();

      Given(
        'an esbuild metafile whose bundle imports "node:http" statically as an external',
        () =>
          gate.givenMetafile([{ path: "node:http", kind: "import-statement" }]),
      );

      When(
        'I check it with the browser Node-import gate allowing only "node:http"',
        () => gate.check(),
      );

      Then('the gate fails and names "node:http" as a static import', () => {
        expect(gate.result().exitCode).toBe(1);
        expect(gate.result().stderr).toContain("node:http (import-statement");
      });
    },
  );

  Scenario(
    "The browser gate rejects an allowlisted built-in imported both lazily and statically",
    ({ Given, When, Then }) => {
      const gate = gateScenario();

      Given(
        'an esbuild metafile whose bundle imports "node:http" both dynamically and through require',
        () =>
          gate.givenMetafile([
            "node:http",
            { path: "node:http", kind: "require-call" },
          ]),
      );

      When(
        'I check it with the browser Node-import gate allowing only "node:http"',
        () => gate.check(),
      );

      Then('the gate fails and names "node:http" as a require call', () => {
        expect(gate.result().exitCode).toBe(1);
        expect(gate.result().stderr).toContain("node:http (require-call");
      });
    },
  );

  Scenario(
    "The browser gate treats a bare built-in as a Node import",
    ({ Given, When, Then }) => {
      const gate = gateScenario();

      Given(
        'an esbuild metafile whose bundle imports "util" as an external',
        () => gate.givenMetafile(["util"]),
      );

      When(
        'I check it with the browser Node-import gate allowing only "node:http"',
        () => gate.check(),
      );

      Then('the gate fails and names "util"', () => {
        expect(gate.result().exitCode).toBe(1);
        expect(gate.result().stderr).toMatch(/\butil\b/);
      });
    },
  );

  Scenario(
    "Both browser bundles of the release candidate go through the Node-import gate",
    ({ Given, Then, And }) => {
      let script = "";

      Given("the release-candidate check script", () => {
        script = readFileSync(
          join(repoRoot, "scripts/check-release-candidate.sh"),
          "utf-8",
        );
      });

      Then("both browser stages are bundled by esbuild with a metafile", () => {
        const esbuildInvocations = commandLines(script).filter((line) =>
          line.startsWith('"$ESBUILD_BIN" '),
        );
        const consumers = esbuildInvocations.map((invocation) =>
          invocation.includes("./browser-consumer.mjs")
            ? "validation"
            : invocation.includes("./browser-openapi-consumer.mjs")
              ? "openapi"
              : "other",
        );
        expect(consumers).toEqual(
          expect.arrayContaining(["validation", "openapi"]),
        );
        for (const invocation of esbuildInvocations) {
          expect(invocation).toContain("--platform=browser");
          expect(invocation).toMatch(/--metafile=\S+/);
        }
        // Bun's browser target inlines a polyfill for every `node:` builtin,
        // so a bun-built bundle has no Node import left for any gate to see.
        expect(script).not.toMatch(/bun build[\s\\]+\.\/browser-consumer\.mjs/);
      });

      And("each metafile is checked by the browser Node-import gate", () => {
        const gateCalls = commandLines(script).filter((line) =>
          line.startsWith(
            'node "$ROOT_DIR/scripts/check-browser-node-imports.mjs" ',
          ),
        );
        const checked = gateCalls.map(
          (line) => line.match(/"\$FIXTURE_DIR\/([^"]+)"$/)?.[1] ?? line,
        );
        expect(checked).toEqual([
          "browser-dist/meta.json",
          "browser-openapi-dist/meta.json",
        ]);
        for (const line of gateCalls) {
          expect(line).toContain("BROWSER_NODE_IMPORT_ALLOWLIST");
        }
        // The old text scan comment claimed survivors were reported "above".
        expect(script).not.toContain("reported by the scan above");
      });
    },
  );

  // ── #117 / #139: downstream suites test source, not the last dist ────────

  Scenario(
    "Downstream package suites resolve sibling packages to their source",
    ({ Given, When, Then }) => {
      const imports: Record<string, string[]> = {
        faker: ["@schmock/core"],
        openapi: ["@schmock/core", "@schmock/faker"],
        validation: ["@schmock/core"],
        query: ["@schmock/core"],
        react: ["@schmock/core"],
        vue: ["@schmock/core"],
      };
      const configs: Array<{ pkg: string; file: string }> = [];
      const resolved: Array<{
        config: string;
        specifier: string;
        id: string;
        expected: string;
      }> = [];

      Given(
        "the unit and BDD vitest configs of faker, openapi, validation, query, react and vue",
        () => {
          for (const pkg of Object.keys(imports)) {
            for (const file of ["vitest.config.ts", "vitest.config.bdd.ts"]) {
              configs.push({ pkg, file });
            }
          }
        },
      );

      When(
        "each config resolves the @schmock packages that package imports",
        async () => {
          for (const { pkg, file } of configs) {
            const pkgDir = join(repoRoot, "packages", pkg);
            const server = await createViteServer({
              root: pkgDir,
              configFile: join(pkgDir, file),
              logLevel: "silent",
              appType: "custom",
              server: { middlewareMode: true, hmr: false, ws: false },
              optimizeDeps: { noDiscovery: true },
            });
            try {
              for (const specifier of imports[pkg] ?? []) {
                const sibling = specifier.replace("@schmock/", "");
                const result = await server.pluginContainer.resolveId(
                  specifier,
                  join(pkgDir, "src", "index.ts"),
                );
                resolved.push({
                  config: `${pkg}/${file}`,
                  specifier,
                  id: result?.id ?? "<unresolved>",
                  expected: realpathSync(
                    join(repoRoot, "packages", sibling, "src"),
                  ),
                });
              }
            } finally {
              await server.close();
            }
          }
        },
      );

      Then(
        "every one resolves into the sibling package's src directory",
        () => {
          expect(resolved).toHaveLength(14);
          const outside = resolved.filter(
            ({ id, expected }) =>
              !(existsSync(id) ? realpathSync(id) : id).startsWith(expected),
          );
          expect(outside).toEqual([]);
        },
      );
    },
  );

  Scenario(
    "The publish entry point builds before it runs the test suite",
    ({ Given, When, Then }) => {
      let fixture: Fixture;

      Given(
        "the publish entry point with every external command stubbed",
        () => {
          fixture = createFixture("schmock-review-publish-");
          cleanup.push(fixture.root);
          mkdirSync(join(fixture.root, "packages", "core"), {
            recursive: true,
          });
          writeFileSync(
            join(fixture.root, "packages", "core", "package.json"),
            JSON.stringify({ name: "@schmock/core", version: "9.9.9" }),
          );
          const guarded = join(fixture.root, "guarded.sh");
          writeFileSync(
            guarded,
            `#!/usr/bin/env bash\nprintf 'guarded %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"\n`,
          );
          chmodSync(guarded, 0o755);
          writeStub(
            fixture.binDir,
            "bun",
            `printf 'bun %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"`,
          );
          writeStub(
            fixture.binDir,
            "git",
            `printf 'git %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"
case "$*" in
  "rev-parse HEAD") printf '0123456789abcdef0123456789abcdef01234567\\n' ;;
esac`,
          );
        },
      );

      When("I run it with no arguments", () => {
        const result = runCommand(
          "bash",
          [join(repoRoot, "scripts/publish.sh")],
          {
            env: {
              PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
              SCHMOCK_ROOT: fixture.root,
              SCHMOCK_PUBLISH_SCRIPT: join(fixture.root, "guarded.sh"),
              SCHMOCK_TEST_COMMAND_LOG: fixture.commandLog,
            },
          },
        );
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      });

      Then('"bun run build" runs before "bun run test:all"', () => {
        const log = loggedCommands(fixture);
        const build = log.indexOf("bun run build");
        const testAll = log.indexOf("bun run test:all");
        expect(build).toBeGreaterThanOrEqual(0);
        expect(testAll).toBeGreaterThan(build);
      });
    },
  );

  Scenario(
    "The guarded publish script builds before it runs the test suite",
    ({ Given, Then }) => {
      let validation: string[] = [];

      Given("the guarded publish script", () => {
        const script = readFileSync(
          join(repoRoot, ".agents/skills/devops/scripts/publish.sh"),
          "utf-8",
        );
        const start = script.indexOf('echo "Running validation..."');
        expect(start).toBeGreaterThanOrEqual(0);
        validation = commandLines(script.slice(start)).slice(0, 8);
      });

      Then(
        'its validation block runs "bun run build" before "bun run test:all"',
        () => {
          const build = validation.indexOf("bun run build");
          const testAll = validation.indexOf("bun run test:all");
          expect(build).toBeGreaterThanOrEqual(0);
          expect(testAll).toBeGreaterThan(build);
        },
      );
    },
  );

  // ── #153: the pre-commit hook gates only what it can enforce ─────────────

  function hookFixture(): {
    create: () => void;
    makeDirty: () => void;
    run: () => void;
    result: () => CommandResult;
    commands: () => string[];
  } {
    let fixture: Fixture;
    let dirty = "0";
    let result: CommandResult = { exitCode: -1, stdout: "", stderr: "" };
    return {
      create: () => {
        fixture = createFixture("schmock-review-hook-");
        cleanup.push(fixture.root);
        writeStub(
          fixture.binDir,
          "bun",
          `printf 'bun %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"`,
        );
        writeStub(
          fixture.binDir,
          "git",
          `printf 'git %s\\n' "$*" >> "$SCHMOCK_TEST_COMMAND_LOG"
if [ "$1" = "diff" ] && [ "$SCHMOCK_TEST_DIRTY" = "1" ]; then exit 1; fi
exit 0`,
        );
      },
      makeDirty: () => {
        dirty = "1";
      },
      run: () => {
        result = runCommand("sh", [join(repoRoot, ".githooks/pre-commit")], {
          cwd: fixture.root,
          env: {
            PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
            SCHMOCK_TEST_COMMAND_LOG: fixture.commandLog,
            SCHMOCK_TEST_DIRTY: dirty,
          },
        });
      },
      result: () => result,
      commands: () => loggedCommands(fixture),
    };
  }

  Scenario(
    "The pre-commit hook does not run an unenforced benchmark",
    ({ Given, When, Then, And }) => {
      const hook = hookFixture();

      Given("the pre-commit hook with every external command stubbed", () =>
        hook.create(),
      );

      When("I run the hook", () => hook.run());

      Then("it runs lint and the quiet test suite", () => {
        expect(hook.result().exitCode).toBe(0);
        expect(hook.commands()).toEqual(
          expect.arrayContaining(["bun run lint", "bun run test:all:quiet"]),
        );
      });

      And("it does not run the benchmark", () => {
        expect(
          hook.commands().filter((line) => line.startsWith("bun run bench")),
        ).toEqual([]);
      });
    },
  );

  Scenario(
    "The pre-commit hook reports unstaged changes as the developer's own",
    ({ Given, When, Then, And }) => {
      const hook = hookFixture();

      Given("the pre-commit hook with every external command stubbed", () =>
        hook.create(),
      );

      And("the working tree has unstaged changes", () => hook.makeDirty());

      When("I run the hook", () => hook.run());

      Then("it fails with a message about unstaged changes", () => {
        expect(hook.result().exitCode).toBe(1);
        expect(hook.result().stdout).toMatch(/unstaged changes/i);
      });

      And("it does not claim that linting changed files", () => {
        expect(hook.result().stdout).not.toMatch(/linting may have fixed/i);
      });
    },
  );

  // ── #129: the route-lookup benchmark reaches the linear param scan ───────

  Scenario(
    "The route lookup benchmark exercises the param-route scan",
    ({ Given, When, Then, And }) => {
      let lookup: ReturnType<typeof createParamRouteLookup>;
      let hit: Schmock.Response;
      let miss: Schmock.Response;

      Given(
        "the throughput benchmark's param-route mock with 2000 routes",
        () => {
          lookup = createParamRouteLookup(2000);
        },
      );

      When(
        "I request the last param route and a path that matches no route",
        async () => {
          hit = await lookup.mock.handle("GET", lookup.lastRoutePath);
          miss = await lookup.mock.handle("GET", lookup.missPath);
        },
      );

      Then("the last route answers with its captured param", () => {
        expect(hit.status).toBe(200);
        expect(hit.body).toEqual({ route: 1999, id: "last" });
      });

      And("the miss answers 404", () => {
        expect(miss.status).toBe(404);
      });
    },
  );

  // ── #147: bundle-size reports shipped JS, not declarations and maps ──────

  Scenario(
    "The bundle-size benchmark counts only shipped JavaScript",
    ({ Given, When, Then }) => {
      let dist = "";
      let measured = -1;

      Given(
        "a dist directory with a JS file, a declaration, a declaration map and a source map",
        () => {
          dist = mkdtempSync(join(tmpdir(), "schmock-bundle-size-"));
          cleanup.push(dist);
          mkdirSync(join(dist, "nested"));
          writeFileSync(join(dist, "index.js"), "x".repeat(100));
          writeFileSync(join(dist, "nested", "chunk.mjs"), "y".repeat(20));
          writeFileSync(join(dist, "index.d.ts"), "d".repeat(1000));
          writeFileSync(join(dist, "index.d.ts.map"), "m".repeat(1000));
          writeFileSync(join(dist, "index.js.map"), "s".repeat(1000));
        },
      );

      When("the bundle-size benchmark measures its JavaScript", () => {
        measured = distJsSize(dist);
      });

      Then("only the JS file's bytes are counted", () => {
        expect(measured).toBe(120);
      });
    },
  );

  Scenario(
    "The bundle-size benchmark leaves test helpers out of the source size",
    ({ Given, When, Then }) => {
      let src = "";
      let measured = -1;

      Given(
        "a src directory with a module, a test, a step file and a test-utils helper",
        () => {
          src = mkdtempSync(join(tmpdir(), "schmock-source-size-"));
          cleanup.push(src);
          mkdirSync(join(src, "steps"));
          writeFileSync(join(src, "index.ts"), "x".repeat(100));
          writeFileSync(join(src, "index.test.ts"), "t".repeat(1000));
          writeFileSync(join(src, "steps", "a.steps.ts"), "s".repeat(1000));
          // packages/faker/src/test-utils.ts is imported only by tests.
          writeFileSync(join(src, "test-utils.ts"), "u".repeat(1000));
        },
      );

      When("the bundle-size benchmark measures its source", () => {
        measured = sourceSize(src);
      });

      Then("only the module's bytes are counted", () => {
        expect(measured).toBe(100);
      });
    },
  );
});
