import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { CallableMockInstance, Plugin, PluginContext } from "../types";

const feature = await loadFeature("../../features/developer-experience.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: any;
  let responses: any[] = [];

  Scenario("Forgetting to provide response data", ({ Given, When, Then, And }) => {
    Given("I create a mock with no response data on {string}", (_, route: string) => {
      mock = schmock();
      mock(route as Schmock.RouteKey, undefined);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response body should be empty", () => {
      expect(response.body).toBeUndefined();
    });
  });

  Scenario("Using wrong parameter name in route", ({ Given, When, Then }) => {
    Given("I create a mock with a mismatched parameter name on {string}", (_, route: string) => {
      mock = schmock();
      mock(route as Schmock.RouteKey, ({ params }) => ({ id: params.id }));
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the wrong parameter should be undefined", () => {
      expect(response.body).toEqual({ id: undefined });
    });
  });

  Scenario("Correct parameter usage", ({ Given, When, Then }) => {
    Given("I create a mock with a matching parameter name on {string}", (_, route: string) => {
      mock = schmock();
      mock(route as Schmock.RouteKey, ({ params }) => ({ id: params.userId }));
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

  Scenario("Mixing content types without explicit configuration", ({ Given, When, Then, And }) => {
    Given("I create a mock with JSON, text, number, and boolean routes", () => {
      mock = schmock();
      mock("GET /json", { data: "json" });
      mock("GET /text", "plain text");
      mock("GET /number", 42);
      mock("GET /boolean", true);
    });

    When("I test all mixed content type routes", async () => {
      responses = [];
      responses.push(await mock.handle("GET", "/json"));
      responses.push(await mock.handle("GET", "/text"));
      responses.push(await mock.handle("GET", "/number"));
      responses.push(await mock.handle("GET", "/boolean"));
    });

    Then("JSON route should have content-type {string}", (_, contentType: string) => {
      expect(responses[0].headers?.["content-type"]).toBe(contentType);
    });

    And("text route should have content-type {string}", (_, contentType: string) => {
      expect(responses[1].headers?.["content-type"]).toBe(contentType);
    });

    And("number route should have content-type {string}", (_, contentType: string) => {
      expect(responses[2].headers?.["content-type"]).toBe(contentType);
    });

    And("boolean route should have content-type {string}", (_, contentType: string) => {
      expect(responses[3].headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("Expecting JSON but getting string conversion", ({ Given, When, Then, And }) => {
    Given("I create a mock returning a decimal number on {string}", (_, route: string) => {
      mock = schmock();
      mock(route as Schmock.RouteKey, 19.99);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive text {string}", (_, expectedText: string) => {
      expect(response.body).toBe(expectedText);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("Forgetting await with async generators", ({ Given, When, Then, And }) => {
    Given("I create a mock with an async handler on {string}", (_, route: string) => {
      mock = schmock();
      mock(route as Schmock.RouteKey, async () => ({ async: true }));
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("State confusion between global and local state", ({ Given, When, Then, And }) => {
    Given("I create a mock with global state and a local state counter", () => {
      mock = schmock({ state: { global: 1 } });
      mock("GET /counter", ({ state }) => {
        const current = (state.local as number | undefined) || 0;
        state.local = current + 1;
        return { global: state.global, local: state.local };
      });
    });

    When("I request {string} twice", async (_, request: string) => {
      const [method, path] = request.split(" ");
      responses = [];
      responses.push(await mock.handle(method as any, path));
      responses.push(await mock.handle(method as any, path));
    });

    Then("the first response should have:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[0].body).toEqual(expected);
    });

    And("the second response should have:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[1].body).toEqual(expected);
    });
  });

  Scenario("Query parameter edge cases", ({ Given, When, Then }) => {
    Given("I create a mock that echoes query parameters on {string}", (_, route: string) => {
      mock = schmock();
      mock(route as Schmock.RouteKey, ({ query }) => ({
        term: query.q,
        page: query.page,
        empty: query.empty,
      }));
    });

    When("I request {string}", async (_, request: string) => {
      const [method, fullPath] = request.split(" ");
      const [path, queryString] = fullPath.split("?");

      const query: Record<string, string> = {};
      if (queryString) {
        queryString.split("&").forEach((param) => {
          const [key, value] = param.split("=");
          query[key] = value || "";
        });
      }

      response = await mock.handle(method as any, path, { query });
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("Headers case sensitivity", ({ Given, When, Then }) => {
    Given("I create a mock that echoes headers on {string}", (_, route: string) => {
      mock = schmock();
      mock(route as Schmock.RouteKey, ({ headers }) => ({
        auth: headers.authorization,
        authUpper: headers.Authorization,
        contentType: headers["content-type"],
      }));
    });

    When("I request {string} with headers:", async (_, request: string, docString: string) => {
      const [method, path] = request.split(" ");
      const headers = JSON.parse(docString);
      response = await mock.handle(method as any, path, { headers });
    });

    Then("the header case sensitivity should show expected values", () => {
      expect(response.body).toEqual({
        auth: undefined,
        authUpper: "Bearer token",
        contentType: undefined,
      });
    });
  });

  Scenario("Route precedence with similar paths", ({ Given, When, Then, And }) => {
    Given("I create a mock with an exact route and a parameterized route on {string}", (_, basePath: string) => {
      mock = schmock();
      mock(`GET ${basePath}/profile`, { type: "profile" });
      mock(`GET ${basePath}/:id`, ({ params }) => ({ type: "user", id: params.id }));
    });

    When("I test both route precedence scenarios", async () => {
      responses = [];
      responses.push(await mock.handle("GET", "/users/profile"));
      responses.push(await mock.handle("GET", "/users/123"));
    });

    Then("the profile route should return exact match:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[0].body).toEqual(expected);
    });

    And("the parameterized route should match with param:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[1].body).toEqual(expected);
    });
  });

  Scenario("Plugin order affecting results", ({ Given, When, Then }) => {
    Given("I create a mock with two plugins that each set a step number", () => {
      mock = schmock();
      const plugin1: Plugin = {
        name: "first",
        process: (ctx: PluginContext, response: unknown) => ({
          context: ctx,
          response: { ...(response as Record<string, unknown>), step: 1 },
        }),
      };
      const plugin2: Plugin = {
        name: "second",
        process: (ctx: PluginContext, response: unknown) => ({
          context: ctx,
          response: { ...(response as Record<string, unknown>), step: 2 },
        }),
      };
      mock("GET /order", { original: true }).pipe(plugin1).pipe(plugin2);
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

  Scenario("Namespace confusion with absolute paths", ({ Given, When, Then, And }) => {
    Given("I create a mock with namespace {string} and a users route", (_, namespace: string) => {
      mock = schmock({ namespace });
      mock("GET /users", []);
    });

    When("I test both namespace scenarios", async () => {
      responses = [];
      responses.push(await mock.handle("GET", "/users"));
      responses.push(await mock.handle("GET", "/api/v1/users"));
    });

    Then("the wrong namespace should receive status {int}", (_, status: number) => {
      expect(responses[0].status).toBe(status);
    });

    And("the correct namespace should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[1].body).toEqual(expected);
    });
  });

  Scenario("Plugin expecting different context structure", ({ Given, When, Then }) => {
    Given("I create a mock with a plugin that reads context properties", () => {
      mock = schmock();
      const plugin: Plugin = {
        name: "context-reader",
        process: (ctx: PluginContext, _response: unknown) => ({
          context: ctx,
          response: {
            method: ctx.method,
            path: ctx.path,
            hasBody: !!ctx.body,
            hasQuery: !!ctx.query && Object.keys(ctx.query).length > 0,
          },
        }),
      };
      mock("POST /analyze", null).pipe(plugin);
    });

    When("I request {string} with body:", async (_, request: string, docString: string) => {
      const [method, fullPath] = request.split(" ");
      const [path, queryString] = fullPath.split("?");

      const query: Record<string, string> = {};
      if (queryString) {
        queryString.split("&").forEach((param) => {
          const [key, value] = param.split("=");
          query[key] = value || "";
        });
      }

      const body = JSON.parse(docString);
      response = await mock.handle(method as any, path, { body, query });
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("Response tuple format edge cases", ({ Given, When, Then, And }) => {
    Given("I create a mock with three tuple response routes", () => {
      mock = schmock();
      mock("GET /created", [201, null]);
      mock("GET /with-headers", [200, { data: true }, { "x-custom": "header" }]);
      mock("GET /empty-with-status", [204, null]);
    });

    When("I test all tuple response formats", async () => {
      responses = [];
      responses.push(await mock.handle("GET", "/created"));
      responses.push(await mock.handle("GET", "/with-headers"));
      responses.push(await mock.handle("GET", "/empty-with-status"));
    });

    Then("the created endpoint should return status 201 with empty body", () => {
      expect(responses[0].status).toBe(201);
      expect(responses[0].body).toBeUndefined();
    });

    And("the headers endpoint should return status 200 with data and custom header", () => {
      expect(responses[1].status).toBe(200);
      expect(responses[1].body).toEqual({ data: true });
      expect(responses[1].headers?.["x-custom"]).toBe("header");
    });

    And("the empty endpoint should return status 204 with null body", () => {
      expect(responses[2].status).toBe(204);
      expect(responses[2].body).toBeUndefined();
    });
  });

  Scenario("Common typos in method names", ({ Given, When, Then, And }) => {
    let errors: Error[] = [];

    Given("I create an empty mock for testing method typos", () => {
      mock = schmock();
    });

    When("I test all common method typos", () => {
      errors = [];
      const typos = ["GETS /users", "post /users", "GET/users"];

      for (const typo of typos) {
        try {
          mock(typo as Schmock.RouteKey, "test");
          errors.push(new Error("No error thrown"));
        } catch (e) {
          errors.push(e as Error);
        }
      }
    });

    Then("the wrong method typo should throw RouteParseError", () => {
      expect(errors[0]).not.toBeNull();
      expect(errors[0].constructor.name).toBe("RouteParseError");
      expect(errors[0].message).toContain("Invalid route key format");
    });

    And("the lowercase method typo should throw RouteParseError", () => {
      expect(errors[1]).not.toBeNull();
      expect(errors[1].constructor.name).toBe("RouteParseError");
      expect(errors[1].message).toContain("Invalid route key format");
    });

    And("the missing space typo should throw RouteParseError", () => {
      expect(errors[2]).not.toBeNull();
      expect(errors[2].constructor.name).toBe("RouteParseError");
      expect(errors[2].message).toContain("Invalid route key format");
    });
  });

  Scenario("Registering duplicate routes first route wins", ({ Given, When, Then }) => {
    Given("I create a mock with two routes on {string} with different data", (_, route: string) => {
      mock = schmock();
      mock(route as Schmock.RouteKey, [{ id: 1 }]);
      mock(route as Schmock.RouteKey, [{ id: 2 }]);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the first route response should win:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("Plugin returning unexpected structure", ({ Given, When, Then, And }) => {
    Given("I create a mock with a plugin that returns an invalid structure", () => {
      mock = schmock();
      const badPlugin = {
        name: "bad-structure",
        process: () => ({ wrong: "structure" }),
      };
      mock("GET /bad", "original").pipe(badPlugin as any);
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
