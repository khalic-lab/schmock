import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/content-negotiation.feature");

const specWithJson = {
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
                  properties: { id: { type: "integer" } },
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

  Scenario("JSON accepted returns 200", ({ Given, When, Then }) => {
    Given("a mock with a spec defining JSON responses", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWithJson }));
    });

    When('I request with Accept header "application/json"', async () => {
      response = await mock.handle("GET", "/items", {
        headers: { accept: "application/json" },
      });
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });
  });

  Scenario("Unsupported content type returns 406", ({ Given, When, Then, And }) => {
    Given("a mock with a spec defining JSON responses", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWithJson }));
    });

    When('I request with Accept header "application/xml"', async () => {
      response = await mock.handle("GET", "/items", {
        headers: { accept: "application/xml" },
      });
    });

    Then("the response status is 406", () => {
      expect(response.status).toBe(406);
    });

    And('the error body has an "acceptable" array', () => {
      const body = response.body as Record<string, unknown>;
      expect(Array.isArray(body.acceptable)).toBe(true);
      expect(body.acceptable).toContain("application/json");
    });
  });

  Scenario("Wildcard Accept passes through", ({ Given, When, Then }) => {
    Given("a mock with a spec defining JSON responses", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWithJson }));
    });

    When('I request with Accept header "*/*"', async () => {
      response = await mock.handle("GET", "/items", {
        headers: { accept: "*/*" },
      });
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });
  });

  Scenario("No Accept header defaults to success", ({ Given, When, Then }) => {
    Given("a mock with a spec defining JSON responses", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWithJson }));
    });

    When("I request without an Accept header", async () => {
      response = await mock.handle("GET", "/items", { headers: {} });
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });
  });
});
