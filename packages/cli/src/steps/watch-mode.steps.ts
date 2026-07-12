import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { CliServer, WatchHandle } from "../cli";
import { createCliServer, startWatch } from "../cli";

const feature = await loadFeature("../../features/watch-mode.feature");

function makeSpec(paths: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Test", version: "1.0.0" },
    paths,
  });
}

function initialPaths(): Record<string, unknown> {
  return {
    "/items": {
      get: { responses: { "200": { description: "OK" } } },
    },
  };
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let tempDir: string | undefined;
  let specPath = "";
  let server: CliServer | undefined;
  let watchHandle: WatchHandle | undefined;
  let originalPort = 0;
  let reloadPromise: Promise<CliServer> | undefined;

  AfterEachScenario(async () => {
    watchHandle?.close();
    watchHandle = undefined;

    if (server?.server.listening) {
      server.server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server?.server.close(() => resolve()),
      );
    }
    server = undefined;

    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function createTempSpec(): void {
    tempDir = mkdtempSync(join(tmpdir(), "schmock-watch-"));
    specPath = join(tempDir, "spec.json");
    writeFileSync(specPath, makeSpec(initialPaths()));
  }

  async function startWatchedServer(): Promise<void> {
    server = await createCliServer({ spec: specPath, port: 0 });
    originalPort = server.port;
    reloadPromise = new Promise<CliServer>((resolve) => {
      watchHandle = startWatch(
        specPath,
        { spec: specPath, port: 0 },
        () => {
          if (!server) throw new Error("Expected a running CLI server");
          return server;
        },
        (reloaded) => {
          server = reloaded;
          resolve(reloaded);
        },
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async function waitForReload(): Promise<CliServer> {
    if (!reloadPromise) throw new Error("Watch reload was not configured");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reloadPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("Timed out waiting for watched spec reload")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  Scenario(
    "Spec changes reload automatically on the same port",
    ({ Given, And, When, Then }) => {
      Given("a temp spec file with one route", () => {
        createTempSpec();
      });

      And("a CLI server is started with file watching", async () => {
        await startWatchedServer();
      });

      When("the spec file is updated to include a new route", () => {
        writeFileSync(
          specPath,
          makeSpec({
            ...initialPaths(),
            "/users": {
              get: { responses: { "200": { description: "OK" } } },
            },
          }),
        );
      });

      Then(
        "the server reloads automatically on the original port",
        async () => {
          const reloaded = await waitForReload();
          expect(reloaded.server.listening).toBe(true);
          expect(reloaded.port).toBe(originalPort);
        },
      );

      And("the new route responds successfully", async () => {
        if (!server) throw new Error("Expected the reloaded CLI server");
        const response = await fetch(
          `http://${server.hostname}:${server.port}/users`,
        );
        expect(response.status).toBe(200);
      });
    },
  );

  Scenario(
    "Invalid spec changes keep the current server online",
    ({ Given, And, When, Then }) => {
      Given("a temp spec file with one route", () => {
        createTempSpec();
      });

      And("a CLI server is started with file watching", async () => {
        await startWatchedServer();
      });

      When("the spec file is changed to invalid JSON", () => {
        writeFileSync(specPath, "{");
      });

      Then(
        "the original route remains available after the failed reload",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 800));
          if (!server) throw new Error("Expected the original CLI server");
          expect(server.port).toBe(originalPort);
          expect(server.server.listening).toBe(true);
          const response = await fetch(
            `http://${server.hostname}:${server.port}/items`,
          );
          expect(response.status).toBe(200);
        },
      );
    },
  );
});
