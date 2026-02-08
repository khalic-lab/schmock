import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { CliServer } from "../cli";
import { createCliServer, reloadServer } from "../cli";

const feature = await loadFeature("../../features/watch-mode.feature");

function makeSpec(paths: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Test", version: "1.0.0" },
    paths,
  });
}

function makeTempSpec(): string {
  const dir = mkdtempSync(join(tmpdir(), "schmock-watch-"));
  const specPath = join(dir, "spec.json");
  writeFileSync(
    specPath,
    makeSpec({
      "/items": {
        get: { responses: { "200": { description: "OK" } } },
      },
    }),
  );
  return specPath;
}

describeFeature(feature, ({ Scenario }) => {
  Scenario("Server reloads with new routes after spec change", ({ Given, And, When, Then }) => {
    let specPath: string;
    let server: CliServer;
    let originalPort: number;

    Given("a temp spec file with one route", () => {
      specPath = makeTempSpec();
    });

    And("a CLI server is started", async () => {
      server = await createCliServer({ spec: specPath, port: 0 });
      originalPort = server.port;
    });

    When("the spec file is updated to include a new route", () => {
      writeFileSync(
        specPath,
        makeSpec({
          "/items": {
            get: { responses: { "200": { description: "OK" } } },
          },
          "/users": {
            get: { responses: { "200": { description: "OK" } } },
          },
        }),
      );
    });

    And("the server is reloaded", async () => {
      server = await reloadServer(server, { spec: specPath });
    });

    Then("the reloaded server is listening", () => {
      expect(server.server.listening).toBe(true);
      expect(server.port).toBe(originalPort);
      server.close();
    });
  });

  Scenario("Reload preserves the port", ({ Given, And, When, Then }) => {
    let specPath: string;
    let server: CliServer;
    let originalPort: number;

    Given("a temp spec file with one route", () => {
      specPath = makeTempSpec();
    });

    And("a CLI server is started on a random port", async () => {
      server = await createCliServer({ spec: specPath, port: 0 });
      originalPort = server.port;
    });

    When("the server is reloaded", async () => {
      server = await reloadServer(server, { spec: specPath });
    });

    Then("the port number is the same as before", () => {
      expect(server.port).toBe(originalPort);
      server.close();
    });
  });
});
