import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import type { ParsedSpec } from "../parser";
import { parseSpec } from "../parser";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/openapi-parsing.feature");
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");

describeFeature(feature, ({ Scenario }) => {
  let parsedSpec: ParsedSpec;
  let mock: Schmock.CallableMockInstance;

  Scenario("Parse Swagger 2.0 spec", ({ Given, When, Then, And }) => {
    Given("a Swagger 2.0 Petstore spec", () => {
      // Spec will be loaded in the When step
    });

    When("I create an openapi plugin from the spec", async () => {
      parsedSpec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
    });

    Then("the parsed spec has title {string}", (_, title: string) => {
      expect(parsedSpec.title).toBe(title);
    });

    And("the parsed spec has version {string}", (_, version: string) => {
      expect(parsedSpec.version).toBe(version);
    });

    And("the parsed spec has basePath {string}", (_, basePath: string) => {
      expect(parsedSpec.basePath).toBe(basePath);
    });
  });

  Scenario("Parse OpenAPI 3.0 spec", ({ Given, When, Then, And }) => {
    Given("an OpenAPI 3.0 Petstore spec", () => {
      // Spec will be loaded in the When step
    });

    When("I create an openapi plugin from the spec", async () => {
      parsedSpec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-openapi3.json` }),
      );
    });

    Then("the parsed spec has title {string}", (_, title: string) => {
      expect(parsedSpec.title).toBe(title);
    });

    And("the parsed spec has version {string}", (_, version: string) => {
      expect(parsedSpec.version).toBe(version);
    });

    And("routes are auto-registered from the spec", async () => {
      const response = await mock.handle("GET", "/pets");
      expect(response.status).toBe(200);
    });
  });

  Scenario("Parse inline spec object", ({ Given, When, Then }) => {
    Given("an inline OpenAPI spec object", () => {
      // Inline spec prepared in When step
    });

    When("I create an openapi plugin from the inline spec", async () => {
      mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: {
            openapi: "3.0.3",
            info: { title: "Inline", version: "1.0.0" },
            paths: {
              "/hello": {
                get: {
                  responses: {
                    "200": {
                      description: "Hello",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            properties: { msg: { type: "string" } },
                          },
                        },
                      },
                    },
                  },
                },
                post: {
                  responses: {
                    "201": { description: "Created" },
                  },
                },
              },
            },
          },
        }),
      );
    });

    Then("routes are registered from the inline spec", async () => {
      const response = await mock.handle("GET", "/hello");
      expect(response.status).toBe(200);
    });
  });
});
