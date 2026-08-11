import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { CallableMockInstance } from "../types";

const feature = await loadFeature("../../features/plugin-integration.feature");

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object response");
  }
  return Object.fromEntries(Object.entries(value));
}

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let requestResponses: any[] = [];
  let guardedGeneratorExecutions = 0;

  Scenario(
    "Plugin state sharing with pipeline",
    ({ Given, When, Then, And }) => {
      requestResponses = [];

      Given("I create a mock with a counter plugin using route state", () => {
        mock = schmock({ state: {} });
        mock("GET /counter", null, { contentType: "application/json" }).pipe({
          name: "counter-plugin",
          process: (ctx, response) => {
            const routeState = ctx.routeState;
            if (!routeState) throw new Error("Expected persistent route state");
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
            expect(new Date(response.body[property]).getTime()).toBeGreaterThan(
              0,
            );
          }
        },
      );

      And("the route state should persist across requests", () => {
        const requestNumbers = requestResponses.map(
          (r) => r.body.request_number,
        );
        expect(requestNumbers).toEqual([1, 2, 3]);
      });
    },
  );

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
    "Request guard prevents route side effects",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock whose guarded generator records each execution",
        () => {
          guardedGeneratorExecutions = 0;
          mock = schmock();
          mock("POST /guarded", () => {
            guardedGeneratorExecutions += 1;
            return [201, { created: true }];
          });

          const guardPlugin = {
            name: "pre-request-auth",
            beforeRequest(context: Schmock.PluginContext) {
              if (!context.headers.authorization) {
                return {
                  context,
                  response: [
                    401,
                    { error: "Unauthorized", code: "AUTH_REQUIRED" },
                  ],
                };
              }
              return { context };
            },
            process(context: Schmock.PluginContext, response?: unknown) {
              return { context, response };
            },
          };

          mock.pipe(guardPlugin);
        },
      );

      When("I request the guarded route without authorization", async () => {
        requestResponses = [await mock.handle("POST", "/guarded")];
      });

      Then(
        "the guarded response status should be {int}",
        (_, status: number) => {
          expect(requestResponses[0].status).toBe(status);
        },
      );

      And("the guarded generator should not have executed", () => {
        expect(guardedGeneratorExecutions).toBe(0);
      });
    },
  );

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

    Then(
      "the response should have a {string} array with {int} items",
      (_, property: string, count: number) => {
        expect(requestResponses[0].body).toHaveProperty(property);
        expect(Array.isArray(requestResponses[0].body[property])).toBe(true);
        expect(requestResponses[0].body[property]).toHaveLength(count);
      },
    );

    And(
      "the response should have {string} equal to {int}",
      (_, property: string, value: number) => {
        expect(requestResponses[0].body[property]).toBe(value);
      },
    );

    And(
      "the response should have a {string} timestamp",
      (_, property: string) => {
        expect(requestResponses[0].body).toHaveProperty(property);
        expect(typeof requestResponses[0].body[property]).toBe("string");
      },
    );
  });

  Scenario(
    "Failed installation does not activate a plugin",
    ({ Given, When, Then, And }) => {
      let failingPlugin: Schmock.Plugin;
      let installationError: Error | undefined;
      let processCount = 0;

      Given(
        "a route and a plugin whose install hook registers a route and throws",
        () => {
          mock = schmock();
          mock("GET /install", { installed: false });
          failingPlugin = {
            name: "failed-install",
            install(instance) {
              instance("GET /failed-install-route", { leaked: true });
              throw new Error("installation failed");
            },
            process(context, response) {
              processCount += 1;
              return { context, response };
            },
          };
        },
      );

      When("I try to pipe the failing plugin", () => {
        try {
          mock.pipe(failingPlugin);
        } catch (error) {
          installationError =
            error instanceof Error ? error : new Error(String(error));
        }
      });

      Then("pipe should report the installation failure", () => {
        expect(installationError?.message).toBe("installation failed");
      });

      And("the failed installation route should not be registered", () => {
        expect(mock.getRoutes()).toEqual([
          { method: "GET", path: "/install", hasParams: false },
        ]);
      });

      When("I request the installation test route", async () => {
        await mock.handle("GET", "/install");
      });

      Then("the failed plugin should not process the response", () => {
        expect(processCount).toBe(0);
      });
    },
  );

  Scenario(
    "Async installation is rejected before plugin registration",
    ({ Given, When, Then, And }) => {
      let asyncPlugin: Schmock.Plugin;
      let pipeError: unknown;
      let processCount = 0;

      Given(
        "a plugin whose install hook registers routes around a promise",
        () => {
          mock = schmock();
          mock("GET /async-install", { active: false });
          asyncPlugin = {
            name: "async-install",
            async install(instance) {
              instance("GET /before-await", { leaked: true });
              await Promise.resolve();
              instance("GET /after-await", { leaked: true });
            },
            process(context, response) {
              processCount += 1;
              return { context, response };
            },
          };
        },
      );

      When("I try to pipe the async-install plugin", () => {
        try {
          mock.pipe(asyncPlugin);
        } catch (error) {
          pipeError = error;
        }
      });

      Then("pipe should fail with code {string}", (_, expectedCode: string) => {
        expect(pipeError).toMatchObject({ code: expectedCode });
      });

      And("the async-install plugin should remain inactive", async () => {
        await mock.handle("GET", "/async-install");
        expect(processCount).toBe(0);
      });

      And("the async-install routes should not be registered", async () => {
        await Promise.resolve();
        expect(mock.getRoutes()).toEqual([
          { method: "GET", path: "/async-install", hasParams: false },
        ]);
      });
    },
  );

  Scenario(
    "Plugins registered during a request start on the next request",
    ({ Given, When, Then }) => {
      let lateProcessCount = 0;
      let registered = false;

      Given(
        "a plugin that registers a late processor during beforeRequest",
        () => {
          mock = schmock();
          mock("GET /late-plugin", { ok: true });
          const latePlugin: Schmock.Plugin = {
            name: "late",
            process(context, response) {
              lateProcessCount += 1;
              return { context, response };
            },
          };
          mock.pipe({
            name: "registrar",
            beforeRequest(context) {
              if (!registered) {
                registered = true;
                mock.pipe(latePlugin);
              }
              return { context };
            },
            process(context, response) {
              return { context, response };
            },
          });
        },
      );

      When("I request the late-plugin route for the first time", async () => {
        await mock.handle("GET", "/late-plugin");
      });

      Then("the late processor should not have executed", () => {
        expect(lateProcessCount).toBe(0);
      });

      When("I request the late-plugin route for the second time", async () => {
        await mock.handle("GET", "/late-plugin");
      });

      Then("the late processor should have executed once", () => {
        expect(lateProcessCount).toBe(1);
      });
    },
  );

  Scenario(
    "Reset uninstalls plugins in reverse registration order",
    ({ Given, When, Then }) => {
      const uninstallOrder: string[] = [];

      Given("two installed plugins that record their uninstall order", () => {
        mock = schmock();
        const first = {
          name: "first",
          process(context: Schmock.PluginContext, response?: unknown) {
            return { context, response };
          },
          uninstall() {
            uninstallOrder.push("first");
          },
        };
        const second = {
          name: "second",
          process(context: Schmock.PluginContext, response?: unknown) {
            return { context, response };
          },
          uninstall() {
            uninstallOrder.push("second");
          },
        };
        mock.pipe(first).pipe(second);
      });

      When("I reset the mock with installed plugins", () => {
        mock.reset();
      });

      Then(
        "the plugin uninstall order should be {string}",
        (_, expected: string) => {
          expect(uninstallOrder).toEqual(expected.split(","));
        },
      );
    },
  );

  Scenario(
    "An admitted request keeps its plugin snapshot across reset",
    ({ Given, When, Then, And }) => {
      let releaseOldRequest = () => {};
      let oldRequestEntered: Promise<void>;
      let oldResponse: Schmock.Response;
      let newResponse: Schmock.Response;
      const pluginCalls: string[] = [];

      Given(
        "an old plugin pauses an admitted request before processing",
        () => {
          let markEntered = () => {};
          oldRequestEntered = new Promise((resolve) => {
            markEntered = resolve;
          });
          const release = new Promise<void>((resolve) => {
            releaseOldRequest = resolve;
          });

          mock = schmock();
          mock("GET /generation", { generation: "old" });
          mock.pipe({
            name: "old",
            async beforeRequest(context) {
              pluginCalls.push("old:before");
              markEntered();
              await release;
              return { context };
            },
            process(context, response) {
              pluginCalls.push("old:process");
              return {
                context,
                response: { ...requireObject(response), plugin: "old" },
              };
            },
            uninstall() {
              pluginCalls.push("old:uninstall");
            },
          });
        },
      );

      When(
        "I reset the mock and install a new plugin before releasing the request",
        async () => {
          const pending = mock.handle("GET", "/generation");
          await oldRequestEntered;
          mock.reset();
          mock("GET /generation", { generation: "new" });
          mock.pipe({
            name: "new",
            process(context, response) {
              pluginCalls.push("new:process");
              return {
                context,
                response: { ...requireObject(response), plugin: "new" },
              };
            },
          });
          releaseOldRequest();
          oldResponse = await pending;
          newResponse = await mock.handle("GET", "/generation");
        },
      );

      Then(
        "the admitted request should use only the old plugin generation",
        () => {
          expect(oldResponse.body).toEqual({
            generation: "old",
            plugin: "old",
          });
          expect(pluginCalls.slice(0, 2)).toEqual([
            "old:before",
            "old:process",
          ]);
        },
      );

      And(
        "the old plugin should uninstall before a new request uses the new plugin generation",
        () => {
          expect(newResponse.body).toEqual({
            generation: "new",
            plugin: "new",
          });
          expect(pluginCalls).toEqual([
            "old:before",
            "old:process",
            "old:uninstall",
            "new:process",
          ]);
        },
      );
    },
  );
});
