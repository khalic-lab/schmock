import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import type { MockInstance } from "vitest";
import { expect, vi } from "vitest";
import type { CliServer } from "../cli";
import { createCliServer, run } from "../cli";

const feature = await loadFeature("../../features/review-cli.feature");

const PETSTORE_SPEC = resolve(
  __dirname,
  "../../../openapi/src/__fixtures__/petstore-openapi3.json",
);

const ADMIN_TOKEN = "review-admin-token";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refSpec(): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Split spec", version: "1.0.0" },
    paths: {
      "/thing": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "./schemas.json#/Thing" },
                },
              },
            },
          },
        },
      },
    },
  });
}

function thingSchemas(version: string): string {
  return JSON.stringify({
    Thing: {
      type: "object",
      required: ["v"],
      properties: { v: { type: "string", enum: [version] } },
    },
  });
}

function pets(name: string): Array<Record<string, unknown>> {
  return [{ id: 1, name, tag: "dog" }];
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Poll until `probe` returns true or the deadline passes; returns the last verdict. */
async function eventually(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(50);
  }
  return probe();
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let tempDir: string | undefined;
  let specPath = "";
  let seedPath = "";
  let server: CliServer | undefined;
  let stderr = "";
  let stderrSpy: MockInstance | undefined;
  let stalled: Socket | undefined;
  let historyBody: unknown;

  AfterEachScenario(async () => {
    stalled?.destroy();
    stalled = undefined;
    await server?.close();
    server = undefined;
    stderrSpy?.mockRestore();
    stderrSpy = undefined;
    stderr = "";
    historyBody = undefined;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function requireServer(): CliServer {
    if (!server) throw new Error("Expected a running CLI server");
    return server;
  }

  function baseUrl(): string {
    const { hostname, port } = requireServer();
    return `http://${hostname}:${port}`;
  }

  function makeTempDir(): string {
    tempDir = mkdtempSync(join(tmpdir(), "schmock-review-cli-"));
    return tempDir;
  }

  function captureStderr(): void {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      });
  }

  async function startWatched(options: {
    spec: string;
    seed?: string;
    refsExternal?: boolean;
  }): Promise<void> {
    captureStderr();
    server = await createCliServer({
      ...options,
      port: 0,
      watch: true,
      shutdownGraceMs: 100,
    });
    // Let the watcher arm, and let any event the OS reports late for the
    // files the Given step just wrote (macOS FSEvents does) run its debounced
    // reload now — otherwise that stale reload would pick up the edit below
    // and pass the scenario without the edited file being watched at all.
    await sleep(800);
  }

  async function fetchJson(path: string): Promise<unknown> {
    const response = await fetch(`${baseUrl()}${path}`);
    return response.json();
  }

  async function servesThing(version: string): Promise<boolean> {
    const body = await fetchJson("/thing");
    return isRecord(body) && body.v === version;
  }

  async function servesPet(name: string): Promise<boolean> {
    const body = await fetchJson("/pets");
    return (
      Array.isArray(body) &&
      body.some((pet) => isRecord(pet) && pet.name === name)
    );
  }

  function givenSplitSpec(): void {
    const directory = makeTempDir();
    specPath = join(directory, "spec.json");
    writeFileSync(join(directory, "schemas.json"), thingSchemas("v1"));
    writeFileSync(specPath, refSpec());
  }

  async function givenWatchedSplitSpec(): Promise<void> {
    await startWatched({ spec: specPath, refsExternal: true });
    expect(await servesThing("v1")).toBe(true);
  }

  function whenSchemaEdited(): void {
    if (!tempDir) throw new Error("Expected a temp directory");
    writeFileSync(join(tempDir, "schemas.json"), thingSchemas("v2"));
  }

  async function thenEditedSchemaServed(): Promise<void> {
    expect(await eventually(() => servesThing("v2"))).toBe(true);
  }

  // ── #91: --watch follows $ref'd files and the seed manifest ─────────────

  Scenario(
    "Editing a referenced schema file reloads a spec loaded with external refs",
    ({ Given, And, When, Then }) => {
      Given(
        "a temp spec whose response schema lives in a sibling schema file",
        givenSplitSpec,
      );
      And(
        "a CLI server is started watching that spec with external refs",
        givenWatchedSplitSpec,
      );
      When("the sibling schema file is edited", whenSchemaEdited);
      Then("the response reflects the edited schema", thenEditedSchemaServed);
    },
  );

  Scenario(
    "Editing the seed manifest reloads the mock",
    ({ Given, And, When, Then }) => {
      Given("a seed manifest with inline pets", () => {
        seedPath = join(makeTempDir(), "seed.json");
        writeFileSync(seedPath, JSON.stringify({ pets: pets("Buddy") }));
      });
      And(
        "a CLI server is started watching the petstore spec with that seed manifest",
        async () => {
          await startWatched({ spec: PETSTORE_SPEC, seed: seedPath });
          expect(await servesPet("Buddy")).toBe(true);
        },
      );
      When("the seed manifest is edited to seed a different pet", () => {
        writeFileSync(seedPath, JSON.stringify({ pets: pets("Rex") }));
      });
      Then("the pet list serves the newly seeded pet", async () => {
        expect(await eventually(() => servesPet("Rex"))).toBe(true);
      });
    },
  );

  Scenario(
    "Editing a seed data file named by the manifest reloads the mock",
    ({ Given, And, When, Then }) => {
      Given("a seed manifest whose entry points at a sibling pets file", () => {
        const directory = makeTempDir();
        seedPath = join(directory, "seed.json");
        writeFileSync(
          join(directory, "pets.json"),
          JSON.stringify(pets("Buddy")),
        );
        writeFileSync(seedPath, JSON.stringify({ pets: "./pets.json" }));
      });
      And(
        "a CLI server is started watching the petstore spec with that seed manifest",
        async () => {
          await startWatched({ spec: PETSTORE_SPEC, seed: seedPath });
          expect(await servesPet("Buddy")).toBe(true);
        },
      );
      When("the sibling pets file is edited to seed a different pet", () => {
        if (!tempDir) throw new Error("Expected a temp directory");
        writeFileSync(join(tempDir, "pets.json"), JSON.stringify(pets("Rex")));
      });
      Then("the pet list serves the newly seeded pet", async () => {
        expect(await eventually(() => servesPet("Rex"))).toBe(true);
      });
    },
  );

  Scenario(
    "A seed manifest broken and then fixed under watch recovers",
    ({ Given, And, When, Then }) => {
      Given("a seed manifest with inline pets", () => {
        seedPath = join(makeTempDir(), "seed.json");
        writeFileSync(seedPath, JSON.stringify({ pets: pets("Buddy") }));
      });
      And(
        "a CLI server is started watching the petstore spec with that seed manifest",
        async () => {
          await startWatched({ spec: PETSTORE_SPEC, seed: seedPath });
          expect(await servesPet("Buddy")).toBe(true);
        },
      );
      When("the seed manifest is overwritten with invalid JSON", () => {
        writeFileSync(seedPath, "{broken");
      });
      Then("the reload failure is reported", async () => {
        expect(await eventually(() => stderr.includes("Reload failed"))).toBe(
          true,
        );
      });
      And("the pet list still serves the originally seeded pet", async () => {
        expect(await servesPet("Buddy")).toBe(true);
      });
      // The failed reload re-armed with no seed entries; the manifest itself
      // must still be watched for this edit to be seen.
      When("the seed manifest is edited to seed a different pet", () => {
        writeFileSync(seedPath, JSON.stringify({ pets: pets("Rex") }));
      });
      Then("the pet list serves the newly seeded pet", async () => {
        expect(await eventually(() => servesPet("Rex"))).toBe(true);
      });
    },
  );

  // ── #97: a reload announces that it starts from empty state ─────────────

  Scenario(
    "A watch reload says that state and request history start empty",
    ({ Given, And, When, Then }) => {
      Given(
        "a temp spec whose response schema lives in a sibling schema file",
        givenSplitSpec,
      );
      And(
        "a CLI server is started watching that spec with external refs",
        givenWatchedSplitSpec,
      );
      When("the sibling schema file is edited", whenSchemaEdited);
      Then("the response reflects the edited schema", thenEditedSchemaServed);
      And(
        "the reload notice says state and request history were reset",
        async () => {
          expect(
            await eventually(() =>
              stderr.includes("Schmock server reloaded on"),
            ),
          ).toBe(true);
          expect(stderr).toMatch(
            /Schmock server reloaded on \S+ \(state and request history reset\)/,
          );
        },
      );
    },
  );

  // ── cold-review cli-2: --refs-external ignores non-schema siblings ──────

  Scenario(
    "Writing a log or text file next to a spec loaded with external refs does not reload",
    ({ Given, And, When, Then }) => {
      Given(
        "a temp spec whose response schema lives in a sibling schema file",
        givenSplitSpec,
      );
      And(
        "a CLI server is started watching that spec with external refs",
        async () => {
          await givenWatchedSplitSpec();
          // Anything the startup printed is not a reload of the writes below.
          stderr = "";
        },
      );
      When(
        "a log file and a text file are written next to the spec",
        async () => {
          if (!tempDir) throw new Error("Expected a temp directory");
          // A log grows by appends, each one a directory event on Linux;
          // several spaced writes stand in for that.
          for (let line = 1; line <= 3; line += 1) {
            writeFileSync(join(tempDir, "mock.log"), `line ${line}\n`, {
              flag: "a",
            });
            writeFileSync(join(tempDir, "unrelated.txt"), `x${line}\n`);
            await sleep(100);
          }
        },
      );
      Then("no reload is announced", async () => {
        // Past the 500 ms debounce, with slack for macOS FSEvents latency.
        await sleep(1_200);
        expect(stderr).not.toContain("Spec changed, reloading");
        expect(await servesThing("v1")).toBe(true);
      });
      When("the sibling schema file is edited", whenSchemaEdited);
      Then("the response reflects the edited schema", thenEditedSchemaServed);
    },
  );

  // ── #92: history redaction covers query keys and custom key headers ─────

  Scenario(
    "Admin history masks credential-shaped query parameters and headers",
    ({ Given, When, And, Then }) => {
      function recorded(field: "query" | "headers"): Record<string, unknown> {
        if (!Array.isArray(historyBody)) {
          throw new Error("Expected the history body to be an array");
        }
        const record: unknown = historyBody.find(
          (entry) => isRecord(entry) && entry.path === "/pets",
        );
        if (!isRecord(record)) throw new Error("Expected a /pets record");
        const value = record[field];
        if (!isRecord(value)) throw new Error(`Expected a ${field} record`);
        return value;
      }

      Given("a CLI server with the admin API and a known token", async () => {
        server = await createCliServer({
          spec: PETSTORE_SPEC,
          port: 0,
          admin: true,
          adminToken: ADMIN_TOKEN,
          shutdownGraceMs: 100,
        });
      });

      When(
        "a client calls the mock with an api key in the query and in a custom header",
        async () => {
          const response = await fetch(
            `${baseUrl()}/pets?api_key=QUERY-SECRET&access_token=TOKEN-SECRET&page=2`,
            {
              headers: { "X-Pet-Key": "HEADER-SECRET", "X-Trace": "visible" },
            },
          );
          await response.arrayBuffer();
        },
      );

      And("the admin history is fetched with the token", async () => {
        const response = await fetch(`${baseUrl()}/schmock-admin/history`, {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        expect(response.status).toBe(200);
        historyBody = await response.json();
      });

      Then('the recorded query masks "api_key" and "access_token"', () => {
        const query = recorded("query");
        expect(query.api_key).toBe("[redacted]");
        expect(query.access_token).toBe("[redacted]");
        expect(JSON.stringify(historyBody)).not.toContain("SECRET");
      });

      And('the recorded query keeps "page" as "2"', () => {
        expect(recorded("query").page).toBe("2");
      });

      And('the recorded headers mask "x-pet-key"', () => {
        expect(recorded("headers")["x-pet-key"]).toBe("[redacted]");
      });

      And('the recorded headers keep "x-trace" as "visible"', () => {
        expect(recorded("headers")["x-trace"]).toBe("visible");
      });
    },
  );

  // ── #93: close() is bounded even when closeAllConnections is a no-op ────

  Scenario(
    "Closing the server settles when the runtime leaves a stalled upload open",
    ({ Given, And, When, Then }) => {
      let closeOutcome: "settled" | "timed out" | undefined;

      Given("a CLI server with a short shutdown grace window", async () => {
        server = await createCliServer({
          spec: PETSTORE_SPEC,
          port: 0,
          shutdownGraceMs: 200,
        });
      });

      And("the runtime cannot force-close connections", () => {
        // Bun's node:http shim returns from closeAllConnections() without
        // releasing a connection whose request body is incomplete.
        requireServer().server.closeAllConnections = () => undefined;
      });

      And("a client has stalled halfway through a request body", async () => {
        const { hostname, port } = requireServer();
        const socket = connect(port, hostname);
        stalled = socket;
        socket.on("error", () => {});
        await new Promise<void>((ready) => socket.once("connect", ready));
        socket.write(
          `POST /pets HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
            "Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n" +
            '{"na',
        );
        await sleep(150);
      });

      When("the CLI server is closed", async () => {
        closeOutcome = await Promise.race([
          requireServer()
            .close()
            .then(() => "settled" as const),
          sleep(3_000).then(() => "timed out" as const),
        ]);
      });

      Then("the close settles within a few seconds", () => {
        expect(closeOutcome).toBe("settled");
      });
    },
  );

  // ── #144: IPv6 hosts are bracketed in the printed URL ───────────────────

  Scenario("The startup banner brackets an IPv6 host", ({ Given, Then }) => {
    Given("the CLI is run bound to {string}", async (_, host: string) => {
      const baseline = process.listeners("SIGINT");
      captureStderr();
      const runPromise = run([
        "--spec",
        PETSTORE_SPEC,
        "--hostname",
        host,
        "--port",
        "0",
      ]);
      runPromise.catch(() => {});
      await eventually(
        () => /Schmock server running on|Schmock failed/.test(stderr),
        10_000,
      );
      const added = process
        .listeners("SIGINT")
        .filter((listener) => !baseline.includes(listener));
      for (const listener of added) listener("SIGINT");
      await runPromise;
    });

    Then("the startup banner prints a bracketed IPv6 URL", () => {
      expect(stderr).toMatch(
        /Schmock server running on http:\/\/\[::1\]:\d+\n/,
      );
      const printed = /Schmock server running on (\S+)/.exec(stderr)?.[1];
      expect(() => new URL(printed ?? "")).not.toThrow();
    });
  });
});
