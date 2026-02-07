import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { evalMockSetup } from "./eval-mock";
import type { MockInstance } from "../types";

const feature = await loadFeature("../../features/plugin-integration.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: MockInstance<any>;
  let requestResponses: any[] = [];

  Scenario("Plugin state sharing with pipeline", ({ Given, When, Then, And }) => {
    requestResponses = [];

    Given("I create a mock with stateful plugin:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string} three times", async (_, request: string) => {
      const [method, path] = request.split(" ");
      requestResponses = [];

      for (let i = 0; i < 3; i++) {
        const response = await mock.handle(method as any, path);
        requestResponses.push(response);
      }
    });

    Then("each response should have incrementing {string} values", (_, property: string) => {
      expect(requestResponses).toHaveLength(3);

      for (let i = 0; i < requestResponses.length; i++) {
        expect(requestResponses[i].body[property]).toBe(i + 1);
      }
    });

    And("each response should have a {string} timestamp", (_, property: string) => {
      for (const response of requestResponses) {
        expect(response.body[property]).toBeDefined();
        expect(typeof response.body[property]).toBe('string');
        expect(new Date(response.body[property]).getTime()).toBeGreaterThan(0);
      }
    });

    And("the route state should persist across requests", () => {
      // Actually testing that state persists across requests for shared plugin state
      // The name is misleading but the test expects [1, 2, 3] which shows shared state
      const requestNumbers = requestResponses.map(r => r.body.request_number);
      expect(requestNumbers).toEqual([1, 2, 3]);
    });
  });

  Scenario("Multiple plugins in pipeline", ({ Given, When, Then }) => {
    Given("I create a mock with multiple plugins:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string} with headers:", async (_, request: string, docString: string) => {
      const [method, path] = request.split(" ");
      const headers = JSON.parse(docString);
      requestResponses = [await mock.handle(method as any, path, { headers })];
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(requestResponses[0].body).toEqual(expected);
    });
  });

  Scenario("Plugin error handling", ({ Given, When, Then, And }) => {
    Given("I create a mock with error handling plugin:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string} without authorization", async (_, request: string) => {
      const [method, path] = request.split(" ");
      requestResponses = [await mock.handle(method as any, path)];
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(requestResponses[0].status).toBe(status);
    });

    And("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(requestResponses[0].body).toEqual(expected);
    });
  });

  Scenario("Pipeline order and response transformation", ({ Given, When, Then }) => {
    Given("I create a mock with ordered plugins:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      requestResponses = [await mock.handle(method as any, path)];
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(requestResponses[0].body).toEqual(expected);
    });
  });

  Scenario("Schema plugin in pipeline", ({ Given, When, Then, And }) => {
    Given("I create a mock with schema plugin:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      requestResponses = [await mock.handle(method as any, path)];
    });

    Then("the response should have a {string} array", (_, property: string) => {
      expect(requestResponses[0].body).toHaveProperty(property);
      expect(Array.isArray(requestResponses[0].body[property])).toBe(true);
    });

    And("the response should have a {string} field", (_, property: string) => {
      expect(requestResponses[0].body).toHaveProperty(property);
    });

    And("the response should have a {string} timestamp", (_, property: string) => {
      expect(requestResponses[0].body).toHaveProperty(property);
      expect(typeof requestResponses[0].body[property]).toBe('string');
    });
  });
});
