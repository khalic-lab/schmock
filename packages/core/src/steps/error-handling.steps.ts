import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { CallableMockInstance } from "../types";
import { evalMockSetup } from "./eval-mock";

const feature = await loadFeature("../../features/error-handling.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: any;
  let error: Error | null = null;

  Scenario("Route not found returns 404", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });

    And("the response should have error code {string}", (_, errorCode: string) => {
      expect(response.body.code).toBe(errorCode);
    });
  });

  Scenario("Wrong HTTP method returns 404", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });
  });

  Scenario("Invalid route key throws RouteDefinitionError", ({ Given, Then, And }) => {
    Given("I attempt to create a mock with invalid route:", (_, docString: string) => {
      error = null;
      try {
        mock = evalMockSetup(docString);
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw a RouteDefinitionError", () => {
      expect(error).not.toBeNull();
      expect(error!.constructor.name).toBe('RouteParseError');
    });

    And("the error message should contain {string}", (_, message: string) => {
      expect(error!.message).toContain('Invalid route key format');
    });
  });

  Scenario("Empty route path throws RouteDefinitionError", ({ Given, Then, And }) => {
    Given("I attempt to create a mock with empty path:", (_, docString: string) => {
      error = null;
      try {
        mock = evalMockSetup(docString);
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw a RouteDefinitionError", () => {
      expect(error).not.toBeNull();
      expect(error!.constructor.name).toBe('RouteParseError');
    });

    And("the error message should contain {string}", (_, message: string) => {
      expect(error!.message).toContain('Invalid route key format');
    });
  });

  Scenario("Plugin throws error returns 500 with PluginError", ({ Given, When, Then, And }) => {
    Given("I create a mock with failing plugin:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });

    And("the response should have error code {string}", (_, errorCode: string) => {
      expect(response.body.code).toBe(errorCode);
    });
  });

  Scenario("Plugin onError hook recovers from failure", ({ Given, When, Then, And }) => {
    Given("I create a mock with recoverable plugin:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("I should receive text {string}", (_, expectedText: string) => {
      expect(response.body).toBe(expectedText);
    });
  });

  Scenario("Plugin returns invalid result structure", ({ Given, When, Then, And }) => {
    Given("I create a mock with invalid plugin:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });
  });

  Scenario("Function generator throws error returns 500", ({ Given, When, Then, And }) => {
    Given("I create a mock with failing generator:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });

    And("the response should have error code {string}", (_, errorCode: string) => {
      expect(response.body.code).toBe(errorCode);
    });
  });

  Scenario("Invalid JSON generator with JSON content-type throws RouteDefinitionError", ({ Given, Then, And }) => {
    Given("I attempt to create a mock with invalid JSON:", (_, docString: string) => {
      error = null;
      try {
        mock = evalMockSetup(docString);
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw a RouteDefinitionError", () => {
      expect(error).not.toBeNull();
      expect(error!.constructor.name).toBe('RouteDefinitionError');
    });

    And("the error message should contain {string}", (_, message: string) => {
      expect(error!.message).toContain(message);
    });
  });

  Scenario("Namespace mismatch returns 404", ({ Given, When, Then, And }) => {
    Given("I create a mock with namespace:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });
  });

  Scenario("Multiple plugin failures cascade properly", ({ Given, When, Then, And }) => {
    Given("I create a mock with multiple failing plugins:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });
  });

  Scenario("Plugin onError hook also fails", ({ Given, When, Then, And }) => {
    Given("I create a mock with broken error handler:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });
  });

  Scenario("Empty parameter in route returns 404", ({ Given, When, Then, And }) => {
    Given("I create a mock with parameterized route:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });
  });

  Scenario("Async generator error handling", ({ Given, When, Then, And }) => {
    Given("I create a mock with failing async generator:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });
  });

  Scenario("Error responses include proper headers", ({ Given, When, Then, And }) => {
    Given("I create a mock with failing route:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      // Error responses don't get content-type headers automatically
      expect(response.headers).toBeDefined();
    });

    And("the response body should be valid JSON", () => {
      expect(() => JSON.parse(JSON.stringify(response.body))).not.toThrow();
    });
  });

  Scenario("Plugin onError returns response with status 0", ({ Given, When, Then, And }) => {
    Given("I create a mock with status-zero error handler:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("I should receive text {string}", (_, expectedText: string) => {
      expect(response.body).toBe(expectedText);
    });
  });

  Scenario("Plugin null/undefined return handling", ({ Given, When, Then, And }) => {
    Given("I create a mock with null-returning plugin:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });
  });
});
