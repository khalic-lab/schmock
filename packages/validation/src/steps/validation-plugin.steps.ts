import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { validationPlugin } from "../index";

const feature = await loadFeature("../../features/validation-plugin.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: any;
  let response: any;

  Scenario("Valid request body passes validation", ({ Given, When, Then, And }) => {
    Given("I create a validated mock that requires name and email", () => {
      mock = schmock();
      mock("POST /users", ({ body }: any) => [201, body])
        .pipe(validationPlugin({
          request: {
            body: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string" },
              },
              required: ["name", "email"],
            },
          },
        }));
    });

    When("I send a valid POST with name {string} and email {string}", async (_, name: string, email: string) => {
      response = await mock.handle("POST", "/users", {
        body: { name, email },
      });
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response body should have property {string} with value {string}", (_, prop: string, value: string) => {
      expect(response.body[prop]).toBe(value);
    });
  });

  Scenario("Invalid request body returns 400", ({ Given, When, Then, And }) => {
    Given("I create a validated mock that requires name and email", () => {
      mock = schmock();
      mock("POST /users", ({ body }: any) => [201, body])
        .pipe(validationPlugin({
          request: {
            body: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string" },
              },
              required: ["name", "email"],
            },
          },
        }));
    });

    When("I send an invalid POST missing required fields", async () => {
      response = await mock.handle("POST", "/users", {
        body: { name: "John" },
      });
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response body should have error code {string}", (_, code: string) => {
      expect(response.body.code).toBe(code);
    });
  });

  Scenario("Invalid response body returns 500", ({ Given, When, Then, And }) => {
    Given("I create a mock with response validation that expects a number id", () => {
      mock = schmock();
      mock("GET /item", { id: "not-a-number", name: "Test" })
        .pipe(validationPlugin({
          response: {
            body: {
              type: "object",
              properties: {
                id: { type: "number" },
                name: { type: "string" },
              },
              required: ["id"],
            },
          },
        }));
    });

    When("I request the endpoint", async () => {
      response = await mock.handle("GET", "/item");
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response body should have error code {string}", (_, code: string) => {
      expect(response.body.code).toBe(code);
    });
  });

  Scenario("Valid response passes validation", ({ Given, When, Then, And }) => {
    Given("I create a mock with valid response and response validation", () => {
      mock = schmock();
      mock("GET /item", { id: 42, name: "Test" })
        .pipe(validationPlugin({
          response: {
            body: {
              type: "object",
              properties: {
                id: { type: "number" },
                name: { type: "string" },
              },
              required: ["id"],
            },
          },
        }));
    });

    When("I request the endpoint", async () => {
      response = await mock.handle("GET", "/item");
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response body should have property {string} with numeric value", (_, prop: string) => {
      expect(typeof response.body[prop]).toBe("number");
    });
  });

  Scenario("Header validation rejects missing required headers", ({ Given, When, Then, And }) => {
    Given("I create a mock requiring an authorization header", () => {
      mock = schmock();
      mock("GET /secure", { data: "secret" })
        .pipe(validationPlugin({
          request: {
            headers: {
              type: "object",
              properties: {
                authorization: { type: "string" },
              },
              required: ["authorization"],
            },
          },
        }));
    });

    When("I request without authorization header", async () => {
      response = await mock.handle("GET", "/secure");
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response body should have error code {string}", (_, code: string) => {
      expect(response.body.code).toBe(code);
    });
  });

  Scenario("Header validation passes with required headers", ({ Given, When, Then }) => {
    Given("I create a mock requiring an authorization header", () => {
      mock = schmock();
      mock("GET /secure", { data: "secret" })
        .pipe(validationPlugin({
          request: {
            headers: {
              type: "object",
              properties: {
                authorization: { type: "string" },
              },
              required: ["authorization"],
            },
          },
        }));
    });

    When("I request with authorization header {string}", async (_, token: string) => {
      response = await mock.handle("GET", "/secure", {
        headers: { authorization: token },
      });
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });
  });

  Scenario("Query parameter validation", ({ Given, When, Then, And }) => {
    let invalidQueryResponse: any;

    Given("I create a mock requiring page query parameter", () => {
      mock = schmock();
      mock("GET /items", [{ id: 1 }])
        .pipe(validationPlugin({
          request: {
            query: {
              type: "object",
              properties: {
                page: { type: "string" },
              },
              required: ["page"],
            },
          },
        }));
    });

    When("I request with query page {string}", async (_, page: string) => {
      response = await mock.handle("GET", "/items", {
        query: { page },
      });
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    When("I request without required query parameter", async () => {
      invalidQueryResponse = await mock.handle("GET", "/items");
    });

    Then("the invalid query status should be {int}", (_, status: number) => {
      expect(invalidQueryResponse.status).toBe(status);
    });

    And("the invalid query response should have error code {string}", (_, code: string) => {
      expect(invalidQueryResponse.body.code).toBe(code);
    });
  });

  Scenario("Numeric array response is not misinterpreted as status tuple", ({ Given, When, Then, And }) => {
    Given("I create a mock returning numeric array with response validation", () => {
      mock = schmock();
      mock("GET /numbers", [1, 2, 3])
        .pipe(validationPlugin({
          response: {
            body: {
              type: "array",
              items: { type: "number" },
            },
          },
        }));
    });

    When("I request the numeric array endpoint", async () => {
      response = await mock.handle("GET", "/numbers");
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response body should be the array [1, 2, 3]", () => {
      expect(response.body).toEqual([1, 2, 3]);
    });
  });

  Scenario("Custom error status codes", ({ Given, When, Then }) => {
    Given("I create a validated mock with custom error status {int}", (_, status: number) => {
      mock = schmock();
      mock("POST /users", ({ body }: any) => [201, body])
        .pipe(validationPlugin({
          request: {
            body: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
              required: ["name"],
            },
          },
          requestErrorStatus: status,
        }));
    });

    When("I send an invalid request body", async () => {
      response = await mock.handle("POST", "/users", {
        body: {},
      });
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });
  });
});
