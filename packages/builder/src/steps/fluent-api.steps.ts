import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { MockInstance } from "../types";

const feature = await loadFeature("../../features/fluent-api.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: MockInstance<any>;
  let response: any;
  let responses: any[] = [];
  const error: Error | null = null;

  Scenario("Simple route with static response", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      // Evaluate the code string to create the mock
      // In a real implementation, we'd parse this more carefully
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario(
    "Route with dynamic response and state",
    ({ Given, When, Then, And }) => {
      responses = [];

      Given("I create a mock with:", (_, docString: string) => {
        const createMock = new Function("schmock", `return ${docString}`);
        mock = createMock(schmock).build();
      });

      When("I request {string} twice", async (_, request: string) => {
        const [method, path] = request.split(" ");
        responses = [];
        responses.push(await mock.handle(method as any, path));
        responses.push(await mock.handle(method as any, path));
      });

      Then("the first response should have value {int}", (_, value: number) => {
        expect(responses[0].body).toEqual({ value });
      });

      And("the second response should have value {int}", (_, value: number) => {
        expect(responses[1].body).toEqual({ value });
      });
    },
  );

  Scenario("Route with parameters", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("Response with custom status code", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    When(
      "I request {string} with body:",
      async (_, request: string, docString: string) => {
        const [method, path] = request.split(" ");
        const body = JSON.parse(docString);
        response = await mock.handle(method as any, path, { body });
      },
    );

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("404 for undefined routes", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });
  });

  Scenario("Query parameters", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, fullPath] = request.split(" ");
      const [path, queryString] = fullPath.split("?");

      // Parse query string
      const query: Record<string, string> = {};
      if (queryString) {
        queryString.split("&").forEach((param) => {
          const [key, value] = param.split("=");
          query[key] = value;
        });
      }

      response = await mock.handle(method as any, path, { query });
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("Request headers access", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    When(
      "I request {string} with headers:",
      async (_, request: string, docString: string) => {
        const [method, path] = request.split(" ");
        const headers = JSON.parse(docString);
        response = await mock.handle(method as any, path, { headers });
      },
    );

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("Configuration with namespace", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });
});
