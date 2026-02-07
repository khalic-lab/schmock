import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { CallableMockInstance } from "../types";

const feature = await loadFeature("../../features/plugin-integration.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let requestResponses: any[] = [];

  Scenario("Plugin state sharing with pipeline", ({ Given, When, Then, And }) => {
    requestResponses = [];

    Given("I create a mock with a counter plugin using route state", () => {
      mock = schmock({ state: {} });
      mock("GET /counter", null, { contentType: "application/json" }).pipe({
        name: "counter-plugin",
        process: (ctx, response) => {
          const routeState = ctx.routeState!;
          routeState.request_count =
            ((routeState.request_count as number) || 0) + 1;

          if (!response) {
            return {
              context: ctx,
              response: {
                request_number: routeState.request_count,
                path: ctx.path,
                processed_at: new Date().toISOString(),
              },
            };
          }

          return { context: ctx, response };
        },
      });
    });

    When("I request {string} three times", async (_, request: string) => {
      const [method, path] = request.split(" ");
      requestResponses = [];

      for (let i = 0; i < 3; i++) {
        const response = await mock.handle(method as any, path);
        requestResponses.push(response);
      }
    });

    Then(
      "each response should have incrementing {string} values",
      (_, property: string) => {
        expect(requestResponses).toHaveLength(3);

        for (let i = 0; i < requestResponses.length; i++) {
          expect(requestResponses[i].body[property]).toBe(i + 1);
        }
      },
    );

    And(
      "each response should have a {string} timestamp",
      (_, property: string) => {
        for (const response of requestResponses) {
          expect(response.body[property]).toBeDefined();
          expect(typeof response.body[property]).toBe("string");
          expect(new Date(response.body[property]).getTime()).toBeGreaterThan(0);
        }
      },
    );

    And("the route state should persist across requests", () => {
      const requestNumbers = requestResponses.map(
        (r) => r.body.request_number,
      );
      expect(requestNumbers).toEqual([1, 2, 3]);
    });
  });

  Scenario("Multiple plugins in pipeline", ({ Given, When, Then }) => {
    Given("I create a mock with auth and wrapper plugins", () => {
      mock = schmock({});
      mock("GET /users", () => [{ id: 1, name: "John" }], {
        contentType: "application/json",
      })
        .pipe({
          name: "auth-plugin",
          process: (ctx, response) => {
            if (!ctx.headers.authorization) {
              throw new Error("Missing authorization");
            }
            ctx.state.set("user", { id: 1, name: "Admin" });
            return { context: ctx, response };
          },
        })
        .pipe({
          name: "wrapper-plugin",
          process: (ctx, response) => {
            if (response) {
              return {
                context: ctx,
                response: {
                  data: response,
                  meta: {
                    user: ctx.state.get("user"),
                    timestamp: "2025-01-31T10:15:30.123Z",
                  },
                },
              };
            }
            return { context: ctx, response };
          },
        });
    });

    When(
      "I request {string} with headers:",
      async (_, request: string, docString: string) => {
        const [method, path] = request.split(" ");
        const headers = JSON.parse(docString);
        requestResponses = [
          await mock.handle(method as any, path, { headers }),
        ];
      },
    );

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(requestResponses[0].body).toEqual(expected);
    });
  });

  Scenario("Plugin error handling", ({ Given, When, Then, And }) => {
    Given("I create a mock with an auth guard plugin", () => {
      mock = schmock({});
      mock("GET /protected", () => ({ secret: "data" }), {
        contentType: "application/json",
      }).pipe({
        name: "auth-plugin",
        process: (ctx, response) => {
          if (!ctx.headers.authorization) {
            return {
              context: ctx,
              response: [401, { error: "Unauthorized", code: "AUTH_REQUIRED" }],
            };
          }
          return { context: ctx, response };
        },
      });
    });

    When(
      "I request {string} without authorization",
      async (_, request: string) => {
        const [method, path] = request.split(" ");
        requestResponses = [await mock.handle(method as any, path)];
      },
    );

    Then("the status should be {int}", (_, status: number) => {
      expect(requestResponses[0].status).toBe(status);
    });

    And("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(requestResponses[0].body).toEqual(expected);
    });
  });

  Scenario(
    "Pipeline order and response transformation",
    ({ Given, When, Then }) => {
      Given("I create a mock with three ordered step plugins", () => {
        mock = schmock({});
        mock("GET /data", () => ({ value: 42 }), {
          contentType: "application/json",
        })
          .pipe({
            name: "step-1",
            process: (ctx, response) => {
              ctx.state.set("step1", "processed");
              if (response) {
                return {
                  context: ctx,
                  response: { ...response, step1: "processed" },
                };
              }
              return { context: ctx, response };
            },
          })
          .pipe({
            name: "step-2",
            process: (ctx, response) => {
              if (response) {
                return {
                  context: ctx,
                  response: { ...response, step2: "processed" },
                };
              }
              return { context: ctx, response };
            },
          })
          .pipe({
            name: "step-3",
            process: (ctx, response) => {
              if (response) {
                return {
                  context: ctx,
                  response: { ...response, step3: "processed" },
                };
              }
              return { context: ctx, response };
            },
          });
      });

      When("I request {string}", async (_, request: string) => {
        const [method, path] = request.split(" ");
        requestResponses = [await mock.handle(method as any, path)];
      });

      Then("I should receive:", (_, docString: string) => {
        const expected = JSON.parse(docString);
        expect(requestResponses[0].body).toEqual(expected);
      });
    },
  );

  Scenario("Schema plugin in pipeline", ({ Given, When, Then, And }) => {
    Given("I create a mock with a metadata wrapper plugin", () => {
      mock = schmock({});
      mock(
        "GET /users",
        () => [
          { id: 1, name: "John Doe", email: "john@example.com" },
          { id: 2, name: "Jane Smith", email: "jane@example.com" },
        ],
        { contentType: "application/json" },
      ).pipe({
        name: "add-metadata",
        process: (ctx, response) => {
          if (response && Array.isArray(response)) {
            return {
              context: ctx,
              response: {
                users: response,
                count: response.length,
                generated_at: new Date().toISOString(),
              },
            };
          }
          return { context: ctx, response };
        },
      });
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

    And(
      "the response should have a {string} timestamp",
      (_, property: string) => {
        expect(requestResponses[0].body).toHaveProperty(property);
        expect(typeof requestResponses[0].body[property]).toBe("string");
      },
    );
  });
});
