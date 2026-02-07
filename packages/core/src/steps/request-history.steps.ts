import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { CallableMockInstance } from "../types";
import { schmock } from "../index";

const feature = await loadFeature("../../features/request-history.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: any;

  Scenario("No requests recorded initially", ({ Given, Then, And }) => {
    Given("I create a mock with a single GET route for history", () => {
      mock = schmock();
      mock("GET /users", [{ id: 1 }]);
    });

    Then("the mock should not have been called", () => {
      expect(mock.called()).toBe(false);
    });

    And("the call count should be 0", () => {
      expect(mock.callCount()).toBe(0);
    });

    And("the history should be empty", () => {
      expect(mock.history()).toEqual([]);
    });
  });

  Scenario("Record a single GET request", ({ Given, When, Then, And }) => {
    Given("I create a mock returning users at {string}", (_, route: string) => {
      mock = schmock();
      mock(route as Schmock.RouteKey, [{ id: 1, name: "John" }]);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the mock should have been called", () => {
      expect(mock.called()).toBe(true);
    });

    And("the call count should be 1", () => {
      expect(mock.callCount()).toBe(1);
    });

    And("the history should have 1 entry", () => {
      expect(mock.history()).toHaveLength(1);
    });

    And("the last request method should be {string}", (_, method: string) => {
      expect(mock.lastRequest()?.method).toBe(method);
    });

    And("the last request path should be {string}", (_, path: string) => {
      expect(mock.lastRequest()?.path).toBe(path);
    });
  });

  Scenario("Record multiple requests", ({ Given, When, And, Then }) => {
    Given("I create a mock with GET and POST user routes", () => {
      mock = schmock();
      mock("GET /users", [{ id: 1 }]);
      mock("POST /users", ({ body }) => [201, body]);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    And(
      "I request {string} with body:",
      async (_, request: string, docString: string) => {
        const [method, path] = request.split(" ");
        const body = JSON.parse(docString);
        response = await mock.handle(method as any, path, { body });
      },
    );

    And("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the call count should be 3", () => {
      expect(mock.callCount()).toBe(3);
    });

    And(
      "the call count for {string} should be {int}",
      (_, route: string, count: number) => {
        const [method, path] = route.split(" ");
        expect(mock.callCount(method as any, path)).toBe(count);
      },
    );

    And(
      "the call count for {string} should be {int} request",
      (_, route: string, count: number) => {
        const [method, path] = route.split(" ");
        expect(mock.callCount(method as any, path)).toBe(count);
      },
    );
  });

  Scenario("Filter history by method and path", ({ Given, When, And, Then }) => {
    Given("I create a mock with users and posts routes", () => {
      mock = schmock();
      mock("GET /users", []);
      mock("POST /users", ({ body }) => [201, body]);
      mock("GET /posts", []);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    And(
      "I request {string} with body:",
      async (_, request: string, docString: string) => {
        const [method, path] = request.split(" ");
        const body = JSON.parse(docString);
        response = await mock.handle(method as any, path, { body });
      },
    );

    And("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then(
      "the history for {string} should have {int} record",
      (_, route: string, count: number) => {
        const [method, path] = route.split(" ");
        expect(mock.history(method as any, path)).toHaveLength(count);
      },
    );

    And(
      "the history for {string} should have {int} record",
      (_, route: string, count: number) => {
        const [method, path] = route.split(" ");
        expect(mock.history(method as any, path)).toHaveLength(count);
      },
    );

    And(
      "the history for {string} should have {int} entry",
      (_, route: string, count: number) => {
        const [method, path] = route.split(" ");
        expect(mock.history(method as any, path)).toHaveLength(count);
      },
    );

    And(
      "the history for {string} should have {int} entries",
      (_, route: string, count: number) => {
        const [method, path] = route.split(" ");
        expect(mock.history(method as any, path)).toHaveLength(count);
      },
    );
  });

  Scenario("Check if specific route was called", ({ Given, When, Then, And }) => {
    Given("I create a mock with users and posts list routes", () => {
      mock = schmock();
      mock("GET /users", []);
      mock("GET /posts", []);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("{string} should have been called", (_, route: string) => {
      const [method, path] = route.split(" ");
      expect(mock.called(method as any, path)).toBe(true);
    });

    And("{string} should not have been called", (_, route: string) => {
      const [method, path] = route.split(" ");
      expect(mock.called(method as any, path)).toBe(false);
    });
  });

  Scenario("Request record captures full details", ({ Given, When, Then, And }) => {
    Given("I create a mock with a parameterized POST route", () => {
      mock = schmock();
      mock("POST /users/:id", ({ params, body }) => [
        200,
        { ...(body as Record<string, unknown>), id: params.id },
      ]);
    });

    When(
      "I request {string} with headers and body:",
      async (_, request: string, docString: string) => {
        const [method, path] = request.split(" ");
        const options = JSON.parse(docString);
        response = await mock.handle(method as any, path, options);
      },
    );

    Then("the last request should have:", (_, table: any) => {
      const record = mock.lastRequest();
      expect(record).toBeDefined();
      for (const row of table) {
        const field = row.field as keyof typeof record;
        expect(record![field]).toBe(row.value);
      }
    });

    And(
      "the last request params should include {string} = {string}",
      (_, key: string, value: string) => {
        expect(mock.lastRequest()?.params[key]).toBe(value);
      },
    );

    And(
      "the last request headers should include {string} = {string}",
      (_, key: string, value: string) => {
        expect(mock.lastRequest()?.headers[key]).toBe(value);
      },
    );

    And(
      "the last request body should have property {string} with value {string}",
      (_, prop: string, value: string) => {
        expect((mock.lastRequest()?.body as any)?.[prop]).toBe(value);
      },
    );

    And("the last request should have a timestamp", () => {
      const record = mock.lastRequest();
      expect(record?.timestamp).toBeDefined();
      expect(typeof record?.timestamp).toBe("number");
      expect(record!.timestamp).toBeGreaterThan(0);
    });

    And(
      "the last request response status should be {int}",
      (_, status: number) => {
        expect(mock.lastRequest()?.response.status).toBe(status);
      },
    );
  });

  Scenario("Get last request for a specific route", ({ Given, When, And, Then }) => {
    Given("I create a mock echoing POST body at {string}", (_, path: string) => {
      mock = schmock();
      mock(`POST ${path}`, ({ body }) => [201, body]);
    });

    When(
      "I request {string} with body:",
      async (_, request: string, docString: string) => {
        const [method, path] = request.split(" ");
        const body = JSON.parse(docString);
        response = await mock.handle(method as any, path, { body });
      },
    );

    And(
      "I request {string} with body:",
      async (_, request: string, docString: string) => {
        const [method, path] = request.split(" ");
        const body = JSON.parse(docString);
        response = await mock.handle(method as any, path, { body });
      },
    );

    Then(
      "the last request for {string} body should have property {string} with value {string}",
      (_, route: string, prop: string, value: string) => {
        const [method, path] = route.split(" ");
        const record = mock.lastRequest(method as any, path);
        expect((record?.body as any)?.[prop]).toBe(value);
      },
    );
  });

  Scenario("History works with namespaced mocks", ({ Given, When, Then, And }) => {
    Given("I create a namespaced mock under {string}", (_, namespace: string) => {
      mock = schmock({ namespace });
      mock("GET /users", [{ id: 1 }]);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the mock should have been called", () => {
      expect(mock.called()).toBe(true);
    });

    And("the call count should be 1", () => {
      expect(mock.callCount()).toBe(1);
    });

    And("the last request path should be {string}", (_, path: string) => {
      expect(mock.lastRequest()?.path).toBe(path);
    });
  });

  Scenario("404 requests are not recorded in history", ({ Given, When, Then, And }) => {
    Given("I create a mock with only a users route", () => {
      mock = schmock();
      mock("GET /users", []);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the mock should not have been called", () => {
      expect(mock.called()).toBe(false);
    });

    And("the call count should be 0", () => {
      expect(mock.callCount()).toBe(0);
    });
  });
});
