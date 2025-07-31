import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { MockInstance } from "../types";

const feature = await loadFeature("../../features/plugin-lifecycle.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: MockInstance<any>;
  let response: any;
  let lifecycleEvents: string[] = [];
  let generateCalled = false;

  // Helper to create tracking plugin
  const createTrackingPlugin = (events: string[]) => ({
    name: "tracking",
    version: "1.0.0",
    
    beforeRequest(context: any) {
      events.push("beforeRequest");
      return context;
    },
    
    beforeGenerate(context: any) {
      events.push("beforeGenerate");
      return undefined; // Continue to generate
    },
    
    generate(context: any) {
      events.push("generate");
      generateCalled = true;
      return { data: "test" };
    },
    
    afterGenerate(data: any, context: any) {
      events.push("afterGenerate");
      return data;
    },
    
    beforeResponse(response: any, context: any) {
      events.push("beforeResponse");
      return response;
    }
  });

  // Reset before each scenario
  beforeEach(() => {
    lifecycleEvents = [];
    generateCalled = false;
  });

  Scenario("Plugin hooks are called in correct order", ({ Given, And, When, Then }) => {
    const testEvents: string[] = []; // Local array for this test
    
    Given("I create a mock with a tracking plugin", () => {
      const trackingPlugin = {
        name: "tracking",
        version: "1.0.0",
        
        beforeRequest(context: any) {
          testEvents.push("beforeRequest");
          return context;
        },
        
        beforeGenerate(context: any) {
          testEvents.push("beforeGenerate");
          return undefined; // Continue to generate
        },
        
        generate(context: any) {
          testEvents.push("generate");
          return { data: "test" };
        },
        
        afterGenerate(data: any, context: any) {
          testEvents.push("afterGenerate");
          return data;
        },
        
        beforeResponse(response: any, context: any) {
          testEvents.push("beforeResponse");
          return response;
        }
      };
      
      mock = schmock()
        .use(trackingPlugin)
        .routes({
          "GET /test": {
            // No response function, will use plugin generate
          }
        })
        .build();
    });

    And("I have a route {string} that returns data", (_, route: string) => {
      // Route already defined above
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the plugin hooks should be called in order:", (_, table: any) => {
      const expectedOrder = table.map((row: any) => row.hook);
      expect(testEvents).toEqual(expectedOrder);
    });
  });

  Scenario("beforeRequest hook can modify the context", ({ Given, And, When, Then }) => {
    Given("I create a mock with a plugin that adds custom headers", () => {
      const headerPlugin = {
        name: "header-adder",
        beforeRequest(context: any) {
          context.headers["X-Custom-Header"] = "custom-value";
          return context;
        }
      };

      mock = schmock()
        .use(headerPlugin)
        .routes({
          "GET /headers": {
            response: (ctx) => ({
              headers: ctx.headers
            })
          }
        })
        .build();
    });

    And("I have a route {string} that echoes headers", () => {
      // Route already defined above
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should include the custom header", () => {
      expect(response.body.headers["X-Custom-Header"]).toBe("custom-value");
    });
  });

  Scenario("beforeGenerate hook can return early response", ({ Given, And, When, Then }) => {
    const cache = new Map([["GET /cached", { cached: true, data: "from-cache" }]]);

    Given("I create a mock with a caching plugin", () => {
      const cachePlugin = {
        name: "cache",
        beforeGenerate(context: any) {
          const key = `${context.method} ${context.path}`;
          if (cache.has(key)) {
            return cache.get(key);
          }
          return undefined;
        },
        generate() {
          generateCalled = true;
          return { cached: false, data: "from-generate" };
        }
      };

      mock = schmock()
        .use(cachePlugin)
        .routes({
          "GET /cached": {
            // No response, will use plugin
          }
        })
        .build();
    });

    And("the cache contains data for {string}", () => {
      // Cache already set up above
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should be from cache", () => {
      expect(response.body.cached).toBe(true);
      expect(response.body.data).toBe("from-cache");
    });

    And("the generate hook should not be called", () => {
      expect(generateCalled).toBe(false);
    });
  });

  Scenario("afterGenerate hook can transform data", ({ Given, And, When, Then }) => {
    Given("I create a mock with a transformation plugin", () => {
      const transformPlugin = {
        name: "transformer",
        afterGenerate(data: any) {
          return {
            ...data,
            transformed: true,
            original: data.value,
            value: data.value.toUpperCase()
          };
        }
      };

      mock = schmock()
        .use(transformPlugin)
        .routes({
          "GET /transform": {
            response: () => ({ value: "hello world" })
          }
        })
        .build();
    });

    And("I have a route {string} that returns raw data", () => {
      // Route already defined above
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should be transformed", () => {
      expect(response.body.transformed).toBe(true);
      expect(response.body.original).toBe("hello world");
      expect(response.body.value).toBe("HELLO WORLD");
    });
  });

  Scenario("beforeResponse hook can modify final response", ({ Given, And, When, Then }) => {
    Given("I create a mock with a response modifier plugin", () => {
      const modifierPlugin = {
        name: "response-modifier",
        beforeResponse(response: any) {
          return {
            ...response,
            status: 201,
            headers: {
              ...response.headers,
              "X-Modified": "true"
            }
          };
        }
      };

      mock = schmock()
        .use(modifierPlugin)
        .routes({
          "GET /modify": {
            response: () => ({ data: "test" })
          }
        })
        .build();
    });

    And("I have a route {string} that returns data", () => {
      // Route already defined above
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should include custom headers", () => {
      expect(response.headers["X-Modified"]).toBe("true");
    });

    And("the response should have modified status", () => {
      expect(response.status).toBe(201);
    });
  });

  Scenario("onError hook can handle errors gracefully", ({ Given, And, When, Then }) => {
    Given("I create a mock with an error handling plugin", () => {
      const errorPlugin = {
        name: "error-handler",
        onError(error: Error) {
          return {
            status: 503,
            body: {
              error: "Service Unavailable",
              message: error.message,
              handled: true
            },
            headers: {
              "X-Error-Handled": "true"
            }
          };
        }
      };

      mock = schmock()
        .use(errorPlugin)
        .routes({
          "GET /error": {
            response: () => {
              throw new Error("Something went wrong");
            }
          }
        })
        .build();
    });

    And("I have a route {string} that throws an error", () => {
      // Route already defined above
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should have custom error format", () => {
      expect(response.body.error).toBe("Service Unavailable");
      expect(response.body.handled).toBe(true);
      expect(response.headers["X-Error-Handled"]).toBe("true");
    });
  });

  Scenario("Plugin enforce ordering works correctly", ({ Given, When, Then }) => {
    let executionOrder: string[] = [];

    Given("I create a mock with multiple plugins:", (_, table: any) => {
      executionOrder = []; // Reset for this test
      const plugins = table.map((row: any) => ({
        name: row.name,
        enforce: row.enforce === '' ? undefined : row.enforce,
        generate() {
          executionOrder.push(row.name);
          return undefined; // Let next plugin handle
        }
      }));

      // Find the last plugin and make it return data
      const lastPlugin = plugins[plugins.length - 1];
      const originalGenerate = lastPlugin.generate;
      lastPlugin.generate = function() {
        originalGenerate.call(this);
        return { order: executionOrder };
      };

      let builder = schmock();
      
      // Add all plugins
      plugins.forEach(p => {
        builder = builder.use(p);
      });
      
      mock = builder
        .routes({
          "GET /order": {}
        })
        .build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the plugins should execute in order: first, second, third", () => {
      expect(executionOrder).toEqual(["first", "second", "third"]);
    });
  });

  Scenario("Multiple plugins can compose transformations", ({ Given, And, When, Then }) => {
    Given("I create a mock with plugins:", (_, table: any) => {
      const uppercasePlugin = {
        name: "uppercase",
        afterGenerate(data: any) {
          return typeof data === 'string' ? data.toUpperCase() : data;
        }
      };

      const exclaimPlugin = {
        name: "exclaim",
        afterGenerate(data: any) {
          return typeof data === 'string' ? data + "!!!" : data;
        }
      };

      mock = schmock()
        .use(uppercasePlugin)
        .use(exclaimPlugin)
        .routes({
          "GET /compose": {
            response: () => "hello"
          }
        })
        .build();
    });

    And("I have a route {string} that returns {string}", () => {
      // Route already defined above
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should be {string}", (_, expected: string) => {
      expect(response.body).toBe(expected);
    });
  });

  Scenario("Plugin state is shared across hooks", ({ Given, And, When, Then }) => {
    let stateValues: any[] = [];

    Given("I create a mock with a stateful plugin", () => {
      const statefulPlugin = {
        name: "stateful",
        
        beforeRequest(context: any) {
          context.state.set("request-time", Date.now());
          return context;
        },
        
        generate(context: any) {
          const requestTime = context.state.get("request-time");
          context.state.set("generate-time", Date.now());
          return { requestTime };
        },
        
        afterGenerate(data: any, context: any) {
          stateValues.push({
            requestTime: context.state.get("request-time"),
            generateTime: context.state.get("generate-time")
          });
          return {
            ...data,
            generateTime: context.state.get("generate-time")
          };
        }
      };

      mock = schmock()
        .use(statefulPlugin)
        .routes({
          "GET /stateful": {}
        })
        .build();
    });

    And("I have a route {string}", () => {
      // Route already defined above
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the plugin state should be preserved across hooks", () => {
      expect(response.body.requestTime).toBeDefined();
      expect(response.body.generateTime).toBeDefined();
      expect(stateValues[0].requestTime).toBe(response.body.requestTime);
      expect(stateValues[0].generateTime).toBe(response.body.generateTime);
    });
  });

  Scenario("Plugin errors are wrapped correctly", ({ Given, And, When, Then }) => {
    Given("I create a mock with a failing plugin", () => {
      const failingPlugin = {
        name: "failing-plugin",
        generate() {
          throw new Error("Plugin internal error");
        }
      };

      mock = schmock()
        .use(failingPlugin)
        .routes({
          "GET /plugin-error": {}
        })
        .build();
    });

    And("I have a route {string}", () => {
      // Route already defined above
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the error should indicate which plugin failed", () => {
      expect(response.body.error).toContain("failing-plugin");
      expect(response.body.code).toBe("PLUGIN_ERROR");
    });
  });
});