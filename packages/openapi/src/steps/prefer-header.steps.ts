import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/prefer-header.feature");

const specWith404 = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                  },
                },
              },
            },
          },
          "404": {
            description: "Not found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string", default: "Not found" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const specWithExamples = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                  },
                },
                examples: {
                  dog: { value: { name: "Buddy", type: "dog" } },
                  cat: { value: { name: "Whiskers", type: "cat" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  Scenario("Prefer code returns specific status code", ({ Given, When, Then }) => {
    Given("a mock with an OpenAPI spec with 200 and 404 responses", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWith404 }));
    });

    When('I request with Prefer header "code=404"', async () => {
      response = await mock.handle("GET", "/items", {
        headers: { prefer: "code=404" },
      });
    });

    Then("the response status is 404", () => {
      expect(response.status).toBe(404);
    });
  });

  Scenario("Prefer example returns named example", ({ Given, When, Then }) => {
    Given("a mock with an OpenAPI spec with named examples", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWithExamples }));
    });

    When('I request with Prefer header "example=dog"', async () => {
      response = await mock.handle("GET", "/pets", {
        headers: { prefer: "example=dog" },
      });
    });

    Then('the response body name is "Buddy"', () => {
      const body = response.body as Record<string, unknown>;
      expect(body.name).toBe("Buddy");
    });
  });

  Scenario("Prefer dynamic regenerates from schema", ({ Given, When, Then, And }) => {
    Given("a mock with an OpenAPI spec with a response schema", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWith404 }));
    });

    When('I request with Prefer header "dynamic=true"', async () => {
      response = await mock.handle("GET", "/items", {
        headers: { prefer: "dynamic=true" },
      });
    });

    Then('the response body has a "name" property', () => {
      const body = response.body as Record<string, unknown>;
      expect(body.name).toBeDefined();
    });

    And('the response body has an "id" property', () => {
      const body = response.body as Record<string, unknown>;
      expect(body.id).toBeDefined();
    });
  });
});
