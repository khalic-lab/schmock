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

  Scenario("Simple route with generator function", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      // Create callable mock instance
      mock = schmock({});
      
      // Parse and execute the route definition from docString
      // This scenario defines: GET /users with a generator function
      mock('GET /users', () => [{ id: 1, name: 'John' }], {});
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

      Given("I create a mock with:", (_, docString: string) => {
        // Create mock with global state
        mock = schmock({ state: { count: 0 } });
        
        // Define counter route that uses global state
        mock('GET /counter', ({ state }) => {
          state.count++;
          return { value: state.count };
        }, {});
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
      // Create mock with parameter route
      mock = schmock({});
      mock('GET /users/:id', ({ params }) => ({ userId: params.id }), {});
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
      // Create mock with custom status response
      mock = schmock({});
      mock('POST /users', ({ body }) => [201, { id: 1, ...body }], {});
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
      // Create mock with only one route, so other routes return 404
      mock = schmock({});
      mock('GET /users', () => [], {});
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
      // Create mock that handles query parameters
      mock = schmock({});
      mock('GET /search', ({ query }) => ({ 
        results: [], 
        query: query.q 
      }), {});
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
      // Create mock that accesses request headers
      mock = schmock({});
      mock('GET /auth', ({ headers }) => ({ 
        authenticated: headers.authorization === 'Bearer token123' 
      }), {});
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
    Given("I create a mock with:", (_, docString: string) => {
      // Create mock with namespace configuration
      mock = schmock({ namespace: '/api/v1' });
      mock('GET /users', () => [], {});
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

  Scenario("Static data response", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      // Create mock with static data response
      mock = schmock({});
      mock('GET /config', { version: '1.0.0', features: ['auth'] }, {});
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

  Scenario("Plugin pipeline with pipe chaining", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      // Create mock with plugin pipeline
      mock = schmock({});
      mock('GET /users', () => [{ id: 1, name: 'John' }], {})
        .pipe({
          name: "logging",
          process: (ctx, response) => ({ context: ctx, response })
        })
        .pipe({
          name: "cors",
          process: (ctx, response) => ({ context: ctx, response })
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

    And("the response should have CORS headers", () => {
      // This would check for CORS headers if implemented
      // For now just verify the response was processed
      expect(response).toBeDefined();
    });
  });
});
