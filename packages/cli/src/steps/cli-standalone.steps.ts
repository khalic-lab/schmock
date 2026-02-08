import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { CliServer } from "../cli";
import { createCliServer } from "../cli";

const feature = await loadFeature("../../features/cli-standalone.feature");
const fixturesDir = resolve(
  import.meta.dirname,
  "../../../openapi/src/__fixtures__",
);

describeFeature(feature, ({ Scenario }) => {
  let cliServer: CliServer;
  let httpResponse: Response;
  let specPath: string;
  let seedPath: string;
  let thrownError: Error | undefined;

  function baseUrl(): string {
    return `http://${cliServer.hostname}:${cliServer.port}`;
  }

  Scenario(
    "Start server from a spec file",
    ({ Given, When, Then, And }) => {
      Given("I have a petstore spec file", () => {
        specPath = resolve(fixturesDir, "petstore-openapi3.json");
      });

      When("I create a CLI server from the spec", async () => {
        cliServer = await createCliServer({ spec: specPath, port: 0 });
      });

      Then("the CLI server should be running", () => {
        expect(cliServer.port).toBeGreaterThan(0);
      });

      When("I fetch {string} from the CLI server", async (_, route: string) => {
        const [, path] = route.split(" ");
        httpResponse = await fetch(`${baseUrl()}${path}`);
      });

      Then("the CLI response status should be {int}", (_, status: number) => {
        expect(httpResponse.status).toBe(status);
      });

      And("the CLI response body should be an array", async () => {
        const body = await httpResponse.json();
        expect(Array.isArray(body)).toBe(true);
      });

      When("I stop the CLI server", () => {
        cliServer.close();
      });
    },
  );

  Scenario("Serve with seed data", ({ Given, When, And, Then }) => {
    Given("I have a petstore spec file", () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
    });

    And("I have a seed data file with pets", () => {
      seedPath = resolve(tmpdir(), `schmock-test-seed-${Date.now()}.json`);
      const seedData = {
        pets: [{ id: 1, name: "Buddy", tag: "dog" }],
      };
      writeFileSync(seedPath, JSON.stringify(seedData));
    });

    When("I create a CLI server with seed data", async () => {
      cliServer = await createCliServer({
        spec: specPath,
        port: 0,
        seed: seedPath,
      });
    });

    And("I fetch {string} from the CLI server", async (_, route: string) => {
      const [, path] = route.split(" ");
      httpResponse = await fetch(`${baseUrl()}${path}`);
    });

    Then("the CLI response status should be {int}", (_, status: number) => {
      expect(httpResponse.status).toBe(status);
    });

    And("the CLI response body should contain the seeded pet", async () => {
      const body = await httpResponse.json();
      expect(Array.isArray(body)).toBe(true);
      const pets = body as Array<{ name: string }>;
      expect(pets.some((p) => p.name === "Buddy")).toBe(true);
    });

    When("I stop the CLI server", () => {
      cliServer.close();
    });
  });

  Scenario("Custom port", ({ Given, When, Then }) => {
    Given("I have a petstore spec file", () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
    });

    When("I create a CLI server on port {int}", async (_, port: number) => {
      cliServer = await createCliServer({ spec: specPath, port });
    });

    Then(
      "the CLI server should be running on port {int}",
      (_, port: number) => {
        expect(cliServer.port).toBe(port);
        cliServer.close();
      },
    );

    When("I stop the CLI server", () => {
      cliServer.close();
    });
  });

  Scenario("CORS headers on responses", ({ Given, When, Then, And }) => {
    Given("I have a petstore spec file", () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
    });

    When("I create a CLI server with CORS enabled", async () => {
      cliServer = await createCliServer({
        spec: specPath,
        port: 0,
        cors: true,
      });
    });

    And("I fetch {string} from the CLI server", async (_, route: string) => {
      const [, path] = route.split(" ");
      httpResponse = await fetch(`${baseUrl()}${path}`);
    });

    Then("the CLI response should have CORS headers", () => {
      expect(httpResponse.headers.get("access-control-allow-origin")).toBe(
        "*",
      );
    });

    When("I stop the CLI server", () => {
      cliServer.close();
    });
  });

  Scenario("CORS preflight OPTIONS request", ({ Given, When, Then, And }) => {
    Given("I have a petstore spec file", () => {
      specPath = resolve(fixturesDir, "petstore-openapi3.json");
    });

    When("I create a CLI server with CORS enabled", async () => {
      cliServer = await createCliServer({
        spec: specPath,
        port: 0,
        cors: true,
      });
    });

    And("I send an OPTIONS preflight to the CLI server", async () => {
      httpResponse = await fetch(`${baseUrl()}/pets`, {
        method: "OPTIONS",
      });
    });

    Then("the CLI response status should be {int}", (_, status: number) => {
      expect(httpResponse.status).toBe(status);
    });

    And("the CLI response should have CORS headers", () => {
      expect(httpResponse.headers.get("access-control-allow-origin")).toBe(
        "*",
      );
    });

    When("I stop the CLI server", () => {
      cliServer.close();
    });
  });

  Scenario("Missing spec shows usage error", ({ When, Then }) => {
    When("I create a CLI server without a spec", async () => {
      try {
        await createCliServer({ spec: "" });
        thrownError = undefined;
      } catch (error) {
        thrownError = error instanceof Error ? error : new Error(String(error));
      }
    });

    Then("the CLI should throw a missing spec error", () => {
      expect(thrownError).toBeDefined();
    });
  });

  Scenario("Invalid spec shows error", ({ Given, When, Then }) => {
    Given("I have an invalid spec file", () => {
      specPath = resolve(tmpdir(), `schmock-invalid-${Date.now()}.json`);
      writeFileSync(specPath, '{ "not": "a spec" }');
    });

    When("I create a CLI server from the invalid spec", async () => {
      try {
        await createCliServer({ spec: specPath });
        thrownError = undefined;
      } catch (error) {
        thrownError = error instanceof Error ? error : new Error(String(error));
      }
    });

    Then("the CLI should throw a parse error", () => {
      expect(thrownError).toBeDefined();
    });
  });
});
