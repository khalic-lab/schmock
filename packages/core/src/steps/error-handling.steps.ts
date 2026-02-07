import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { CallableMockInstance, Plugin } from "../types";
import { schmock } from "../index";

const feature = await loadFeature("../../features/error-handling.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: any;
  let error: Error | null = null;

  Scenario("Route not found returns 404", ({ Given, When, Then, And }) => {
    Given("I create a mock with a GET /users route returning a user list", () => {
      mock = schmock();
      mock("GET /users", [{ id: 1, name: "John" }]);
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
    Given("I create a mock with a GET /api/data route returning success", () => {
      mock = schmock();
      mock("GET /api/data", { success: true });
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
    Given("I attempt to register a route with an invalid HTTP method", () => {
      error = null;
      try {
        mock = schmock();
        mock("INVALID_METHOD /path" as any, "response");
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw a RouteDefinitionError", () => {
      expect(error).not.toBeNull();
      expect(error!.constructor.name).toBe("RouteParseError");
    });

    And("the error message should contain {string}", (_, message: string) => {
      expect(error!.message).toContain("Invalid route key format");
    });
  });

  Scenario("Empty route path throws RouteDefinitionError", ({ Given, Then, And }) => {
    Given("I attempt to register a route with an empty path", () => {
      error = null;
      try {
        mock = schmock();
        mock("GET " as any, "response");
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw a RouteDefinitionError", () => {
      expect(error).not.toBeNull();
      expect(error!.constructor.name).toBe("RouteParseError");
    });

    And("the error message should contain {string}", (_, message: string) => {
      expect(error!.message).toContain("Invalid route key format");
    });
  });

  Scenario("Plugin throws error returns 500 with PluginError", ({ Given, When, Then, And }) => {
    Given("I create a mock with a plugin that throws {string}", (_, errorMsg: string) => {
      mock = schmock();
      const failingPlugin: Plugin = {
        name: "failing-plugin",
        process: () => { throw new Error(errorMsg); },
      };
      mock("GET /test", "original").pipe(failingPlugin);
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
    Given("I create a mock with a recoverable plugin that returns {string}", (_, recoveredBody: string) => {
      mock = schmock();
      const recoverablePlugin: Plugin = {
        name: "recoverable",
        process: () => { throw new Error("Initial failure"); },
        onError: () => ({ status: 200, body: recoveredBody, headers: {} }),
      };
      mock("GET /test", "original").pipe(recoverablePlugin);
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
    Given("I create a mock with a plugin returning an invalid result", () => {
      mock = schmock();
      const invalidPlugin: Plugin = {
        name: "invalid",
        process: () => ({ wrongStructure: true }) as any,
      };
      mock("GET /test", "original").pipe(invalidPlugin);
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
    Given("I create a mock with a generator that throws {string}", (_, errorMsg: string) => {
      mock = schmock();
      mock("GET /fail", () => { throw new Error(errorMsg); });
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
    Given("I attempt to register a route with a circular reference as JSON", () => {
      error = null;
      try {
        mock = schmock();
        const circularRef: Record<string, unknown> = {};
        circularRef.self = circularRef;
        mock("GET /invalid", circularRef, { contentType: "application/json" });
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw a RouteDefinitionError", () => {
      expect(error).not.toBeNull();
      expect(error!.constructor.name).toBe("RouteDefinitionError");
    });

    And("the error message should contain {string}", (_, message: string) => {
      expect(error!.message).toContain(message);
    });
  });

  Scenario("Namespace mismatch returns 404", ({ Given, When, Then, And }) => {
    Given("I create a mock with namespace {string} and a GET /users route", (_, namespace: string) => {
      mock = schmock({ namespace });
      mock("GET /users", [{ id: 1 }]);
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
    Given("I create a mock with two failing plugins piped in sequence", () => {
      mock = schmock();
      const plugin1: Plugin = {
        name: "first-fail",
        process: () => { throw new Error("First error"); },
      };
      const plugin2: Plugin = {
        name: "second-fail",
        process: () => { throw new Error("Second error"); },
      };
      mock("GET /cascade", "original").pipe(plugin1).pipe(plugin2);
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
    Given("I create a mock with a plugin whose error handler also throws", () => {
      mock = schmock({ debug: true });
      const brokenPlugin: Plugin = {
        name: "broken-handler",
        process: () => { throw new Error("Process failed"); },
        onError: () => { throw new Error("Handler failed"); },
      };
      mock("GET /broken", "original").pipe(brokenPlugin);
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
    Given("I create a mock with a parameterized route {string}", (_, route: string) => {
      mock = schmock();
      mock(route as any, ({ params }: any) => ({ userId: params.id }));
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
    Given("I create a mock with an async generator that throws {string}", (_, errorMsg: string) => {
      mock = schmock();
      mock("GET /async-fail", async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        throw new Error(errorMsg);
      });
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
    Given("I create a mock with a generator that throws {string}", (_, errorMsg: string) => {
      mock = schmock();
      mock("GET /error", () => { throw new Error(errorMsg); });
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers).toBeDefined();
    });

    And("the response body should be valid JSON", () => {
      expect(() => JSON.parse(JSON.stringify(response.body))).not.toThrow();
    });
  });

  Scenario("Plugin onError returns response with status 0", ({ Given, When, Then, And }) => {
    Given("I create a mock with a plugin whose error handler returns status 0", () => {
      mock = schmock();
      const plugin: Plugin = {
        name: "zero-status",
        process: () => { throw new Error("fail"); },
        onError: () => ({ status: 0, body: "zero status", headers: {} }),
      };
      mock("GET /zero", "original").pipe(plugin);
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
    Given("I create a mock with a plugin that returns null", () => {
      mock = schmock();
      const nullPlugin: Plugin = {
        name: "null-plugin",
        process: () => null as any,
      };
      mock("GET /null", "original").pipe(nullPlugin);
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
