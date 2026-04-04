import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { CallableMockInstance, Plugin, PluginContext } from "../types";

const feature = await loadFeature("../../features/developer-experience.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: any;
  let responses: any[] = [];

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

});
