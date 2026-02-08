import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/errors-mode.feature");

const specWithRequestBody = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": { description: "List" },
        },
      },
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  price: { type: "number" },
                },
                required: ["name", "price"],
              },
            },
          },
        },
        responses: {
          "201": { description: "Created" },
        },
      },
    },
    "/items/{itemId}": {
      get: {
        parameters: [{ name: "itemId", in: "path", required: true }],
        responses: { "200": { description: "OK" } },
      },
    },
  },
};

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  Scenario("Invalid request body returns 400 with validation errors", ({ Given, When, Then, And }) => {
    Given("a mock with validateRequests enabled", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWithRequestBody, validateRequests: true }));
    });

    When("I POST an invalid body to a route with a requestBody schema", async () => {
      response = await mock.handle("POST", "/items", {
        body: { name: 123 }, // name should be string, price missing
        headers: { "content-type": "application/json" },
      });
    });

    Then("the response status is 400", () => {
      expect(response.status).toBe(400);
    });

    And('the error body has a "details" array', () => {
      const body = response.body as Record<string, unknown>;
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(body.details)).toBe(true);
      const details = body.details as unknown[];
      expect(details.length).toBeGreaterThan(0);
    });
  });

  Scenario("Valid request body passes through", ({ Given, When, Then }) => {
    Given("a mock with validateRequests enabled", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: specWithRequestBody, validateRequests: true }));
    });

    When("I POST a valid body to a route with a requestBody schema", async () => {
      response = await mock.handle("POST", "/items", {
        body: { name: "Widget", price: 9.99 },
        headers: { "content-type": "application/json" },
      });
    });

    Then("the response status is 201", () => {
      expect(response.status).toBe(201);
    });
  });
});
