/// <reference path="../../../core/schmock.d.ts" />

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { runInit } from "../init.js";

const feature = await loadFeature("../../features/devtools-init.feature");

const PROGRAM = "schmock-devtools";
const USAGE = "Usage: schmock-devtools init <publicDir>";

/** Stand-in for dist/schmock-sw.js: distinctive bytes, non-ASCII included. */
const PACKAGED_WORKER = Buffer.from(
  "/* schmock-sw.js fixture: ünïcödé ✓ */\nself.addEventListener('fetch', () => {});\n",
  "utf8",
);

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let tempDirs: string[] = [];
  let projectDir = "";
  let source = "";
  let stdout: string[] = [];
  let stderr: string[] = [];
  let exitCode: number | undefined;

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  /** A fresh project directory, and a packaged worker unless told otherwise. */
  function setup(options: { packaged: boolean } = { packaged: true }) {
    projectDir = makeTempDir("schmock-init-project-");
    const packageDir = makeTempDir("schmock-init-package-");
    source = join(packageDir, "schmock-sw.js");
    if (options.packaged) writeFileSync(source, PACKAGED_WORKER);
    stdout = [];
    stderr = [];
    exitCode = undefined;
  }

  function writeProjectFile(relativePath: string, content: string) {
    const target = join(projectDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  function run(commandLine: string) {
    const [program, ...argv] = commandLine.split(" ");
    if (program !== PROGRAM) {
      throw new Error(`Expected a "${PROGRAM}" command: ${commandLine}`);
    }
    exitCode = runInit(argv, {
      cwd: projectDir,
      source,
      stdout: (text) => {
        stdout.push(text);
      },
      stderr: (text) => {
        stderr.push(text);
      },
    });
  }

  function expectPackagedWorkerAt(relativePath: string) {
    expect(readFileSync(join(projectDir, relativePath))).toEqual(
      PACKAGED_WORKER,
    );
  }

  AfterEachScenario(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  Scenario(
    "init copies the worker script into the public directory",
    ({ Given, When, Then, And }) => {
      Given("an empty project directory", () => setup());

      When('I run "schmock-devtools init public"', () => {
        run("schmock-devtools init public");
      });

      Then("the command exits with code 0", () => {
        expect(exitCode).toBe(0);
      });

      And('"public/schmock-sw.js" is identical to the packaged worker', () => {
        expectPackagedWorkerAt("public/schmock-sw.js");
      });

      And(
        'the output names "public/schmock-sw.js" and "await startServiceWorkerRelay()"',
        () => {
          const output = stdout.join("");
          expect(output).toContain("public/schmock-sw.js");
          expect(output).toContain("await startServiceWorkerRelay()");
        },
      );
    },
  );

  Scenario(
    "init creates a missing public directory",
    ({ Given, When, Then, And }) => {
      Given("an empty project directory", () => setup());

      When('I run "schmock-devtools init static/assets"', () => {
        run("schmock-devtools init static/assets");
      });

      Then("the command exits with code 0", () => {
        expect(exitCode).toBe(0);
      });

      And(
        '"static/assets/schmock-sw.js" is identical to the packaged worker',
        () => {
          expectPackagedWorkerAt("static/assets/schmock-sw.js");
        },
      );
    },
  );

  Scenario("init replaces an outdated worker", ({ Given, When, Then }) => {
    Given(
      'a project whose "public/schmock-sw.js" contains "old worker"',
      () => {
        setup();
        writeProjectFile("public/schmock-sw.js", "old worker");
      },
    );

    When('I run "schmock-devtools init public"', () => {
      run("schmock-devtools init public");
    });

    Then('"public/schmock-sw.js" is identical to the packaged worker', () => {
      expectPackagedWorkerAt("public/schmock-sw.js");
    });
  });

  Scenario(
    "init without a directory prints usage and fails",
    ({ Given, When, Then, And }) => {
      Given("an empty project directory", () => setup());

      When('I run "schmock-devtools init"', () => {
        run("schmock-devtools init");
      });

      Then("the command exits with code 1", () => {
        expect(exitCode).toBe(1);
      });

      And(`the error output contains "${USAGE}"`, () => {
        expect(stderr.join("")).toContain(USAGE);
      });
    },
  );

  Scenario(
    "An unknown command prints usage and fails",
    ({ Given, When, Then, And }) => {
      Given("an empty project directory", () => setup());

      When('I run "schmock-devtools serve public"', () => {
        run("schmock-devtools serve public");
      });

      Then("the command exits with code 1", () => {
        expect(exitCode).toBe(1);
      });

      And(`the error output contains "${USAGE}"`, () => {
        expect(stderr.join("")).toContain(USAGE);
      });
    },
  );

  Scenario("help prints usage", ({ Given, When, Then, And }) => {
    Given("an empty project directory", () => setup());

    When('I run "schmock-devtools --help"', () => {
      run("schmock-devtools --help");
    });

    Then("the command exits with code 0", () => {
      expect(exitCode).toBe(0);
    });

    And(`the output contains "${USAGE}"`, () => {
      expect(stdout.join("")).toContain(USAGE);
    });
  });

  Scenario(
    "A missing packaged worker is reported",
    ({ Given, When, Then, And }) => {
      Given("an empty project directory and no packaged worker", () => {
        setup({ packaged: false });
      });

      When('I run "schmock-devtools init public"', () => {
        run("schmock-devtools init public");
      });

      Then("the command exits with code 1", () => {
        expect(exitCode).toBe(1);
      });

      And("the error output names the missing packaged worker", () => {
        expect(stderr.join("")).toContain(source);
      });
    },
  );
});
