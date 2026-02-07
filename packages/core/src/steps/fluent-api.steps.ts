import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { CallableMockInstance } from "../types";

const feature = await loadFeature("../../features/fluent-api.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: any;
  let responses: any[] = [];

  Scenario("Simple route with generator function", ({ Given, When, Then }) => {
    Given("I create a mock with a JSON generator at {string}", (_, route: string) => {
      mock = schmock({});
      mock(route as Schmock.RouteKey, () => [{ id: 1, name: "John" }], {
        contentType: "application/json",
      });
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
    "Route with dynamic response and global state",
    ({ Given, When, Then, And }) => {
      responses = [];

      Given("I create a mock with a stateful counter", () => {
        mock = schmock({ state: { count: 0 } });
        mock(
          "GET /counter",
          ({ state }) => {
            const s = state as { count: number };
            s.count++;
            return { value: s.count };
          },
          { contentType: "application/json" },
        );
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
    Given("I create a mock with a parameterized route {string}", (_, route: string) => {
      mock = schmock({});
      mock(route as Schmock.RouteKey, ({ params }) => ({ userId: params.id }), {
        contentType: "application/json",
      });
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
    Given("I create a mock returning status {int} for {string}", (_, _status: number, route: string) => {
      mock = schmock({});
      mock(route as Schmock.RouteKey, ({ body }) => {
        const b = body as Record<string, unknown>;
        return [201, { id: 1, ...b }];
      }, {
        contentType: "application/json",
      });
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

  Scenario("Static data response", ({ Given, When, Then }) => {
    Given("I create a mock with static config data at {string}", (_, route: string) => {
      mock = schmock({});
      mock(route as Schmock.RouteKey, { version: "1.0.0", features: ["auth"] }, {
        contentType: "application/json",
      });
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

  Scenario("404 for undefined routes", ({ Given, When, Then }) => {
    Given("I create a mock with only a {string} route", (_, route: string) => {
      mock = schmock({});
      mock(route as Schmock.RouteKey, () => [], { contentType: "application/json" });
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
    Given("I create a mock that reads query parameters at {string}", (_, route: string) => {
      mock = schmock({});
      mock(
        route as Schmock.RouteKey,
        ({ query }) => ({
          results: [],
          query: query.q,
        }),
        { contentType: "application/json" },
      );
    });

    When("I request {string}", async (_, request: string) => {
      const [method, fullPath] = request.split(" ");
      const [path, queryString] = fullPath.split("?");

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
    Given("I create a mock that reads headers at {string}", (_, route: string) => {
      mock = schmock({});
      mock(
        route as Schmock.RouteKey,
        ({ headers }) => ({
          authenticated: headers.authorization === "Bearer token123",
        }),
        { contentType: "application/json" },
      );
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

  Scenario("Global configuration with namespace", ({ Given, When, Then }) => {
    Given("I create a mock with namespace {string}", (_, namespace: string) => {
      mock = schmock({ namespace });
      mock("GET /users", () => [], { contentType: "application/json" });
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

  Scenario("Plugin pipeline with pipe chaining", ({ Given, When, Then }) => {
    Given("I create a mock with two passthrough plugins", () => {
      mock = schmock({});
      mock("GET /users", () => [{ id: 1, name: "John" }], {
        contentType: "application/json",
      })
        .pipe({
          name: "logging",
          process: (ctx, response) => ({ context: ctx, response }),
        })
        .pipe({
          name: "cors",
          process: (ctx, response) => ({ context: ctx, response }),
        });
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
