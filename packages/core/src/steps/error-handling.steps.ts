import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock, toHttpMethod, toRouteKey } from "../index";
import type { CallableMockInstance, Plugin } from "../types";

const feature = await loadFeature("../../features/error-handling.feature");

function parseRequest(request: string): {
  method: Schmock.HttpMethod;
  path: string;
} {
  const separator = request.indexOf(" ");
  const methodText = request.slice(0, separator);
  const path = request.slice(separator + 1);
  if (separator <= 0 || !path.startsWith("/")) {
    throw new Error(`Expected request in METHOD /path format, got: ${request}`);
  }
  return { method: toHttpMethod(methodText), path };
}

function requireRecord(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${description} to be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function responseBodyString(response: Schmock.Response, field: string): string {
  const value = requireRecord(response.body, "response body")[field];
  if (typeof value !== "string") {
    throw new Error(`Expected response body field ${field} to be a string`);
  }
  return value;
}

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: Schmock.Response;

  Scenario("Route not found returns 404", ({ Given, When, Then, And }) => {
    Given(
      "I create a mock with a GET /users route returning a user list",
      () => {
        mock = schmock();
        mock("GET /users", [{ id: 1, name: "John" }]);
      },
    );

    When("I request {string}", async (_, request: string) => {
      const { method, path } = parseRequest(request);
      response = await mock.handle(method, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And(
      "the response should contain error {string}",
      (_, errorMessage: string) => {
        expect(responseBodyString(response, "error")).toContain(errorMessage);
      },
    );

    And(
      "the response should have error code {string}",
      (_, errorCode: string) => {
        expect(responseBodyString(response, "code")).toBe(errorCode);
      },
    );
  });

  Scenario("Wrong HTTP method returns 404", ({ Given, When, Then, And }) => {
    Given(
      "I create a mock with a GET /api/data route returning success",
      () => {
        mock = schmock();
        mock("GET /api/data", { success: true });
      },
    );

    When("I request {string}", async (_, request: string) => {
      const { method, path } = parseRequest(request);
      response = await mock.handle(method, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And(
      "the response should contain error {string}",
      (_, errorMessage: string) => {
        expect(responseBodyString(response, "error")).toContain(errorMessage);
      },
    );
  });

  Scenario(
    "Plugin throws error returns 500 with PluginError",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock with a plugin that throws {string}",
        (_, errorMsg: string) => {
          mock = schmock();
          const failingPlugin: Plugin = {
            name: "failing-plugin",
            process: () => {
              throw new Error(errorMsg);
            },
          };
          mock("GET /test", "original").pipe(failingPlugin);
        },
      );

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response should contain error {string}",
        (_, errorMessage: string) => {
          expect(responseBodyString(response, "error")).toContain(errorMessage);
        },
      );

      And(
        "the response should have error code {string}",
        (_, errorCode: string) => {
          expect(responseBodyString(response, "code")).toBe(errorCode);
        },
      );
    },
  );

  Scenario(
    "Plugin onError hook recovers from failure",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock with a recoverable plugin that returns {string}",
        (_, recoveredBody: string) => {
          mock = schmock();
          const recoverablePlugin: Plugin = {
            name: "recoverable",
            process: () => {
              throw new Error("Initial failure");
            },
            onError: () => ({ status: 200, body: recoveredBody, headers: {} }),
          };
          mock("GET /test", "original").pipe(recoverablePlugin);
        },
      );

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And("I should receive text {string}", (_, expectedText: string) => {
        expect(response.body).toBe(expectedText);
      });
    },
  );

  Scenario(
    "Plugin returns invalid result structure",
    ({ Given, When, Then, And }) => {
      Given("I create a mock with a plugin returning an invalid result", () => {
        mock = schmock();
        const invalidPlugin: Plugin = {
          name: "invalid",
          process: (context) => ({ context }),
        };
        Object.defineProperty(invalidPlugin, "process", {
          value: () => ({ wrongStructure: true }),
        });
        mock("GET /test", "original").pipe(invalidPlugin);
      });

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response should contain error {string}",
        (_, errorMessage: string) => {
          expect(responseBodyString(response, "error")).toContain(errorMessage);
        },
      );
    },
  );

  Scenario(
    "Function generator throws error returns 500",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock with a generator that throws {string}",
        (_, errorMsg: string) => {
          mock = schmock();
          mock("GET /fail", () => {
            throw new Error(errorMsg);
          });
        },
      );

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response should contain error {string}",
        (_, errorMessage: string) => {
          expect(responseBodyString(response, "error")).toContain(errorMessage);
        },
      );

      And(
        "the response should have error code {string}",
        (_, errorCode: string) => {
          expect(responseBodyString(response, "code")).toBe(errorCode);
        },
      );
    },
  );

  Scenario("Namespace mismatch returns 404", ({ Given, When, Then, And }) => {
    Given(
      "I create a mock with namespace {string} and a GET /users route",
      (_, namespace: string) => {
        mock = schmock({ namespace });
        mock("GET /users", [{ id: 1 }]);
      },
    );

    When("I request {string}", async (_, request: string) => {
      const { method, path } = parseRequest(request);
      response = await mock.handle(method, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And(
      "the response should contain error {string}",
      (_, errorMessage: string) => {
        expect(responseBodyString(response, "error")).toContain(errorMessage);
      },
    );
  });

  Scenario(
    "Multiple plugin failures cascade properly",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock with two failing plugins piped in sequence",
        () => {
          mock = schmock();
          const plugin1: Plugin = {
            name: "first-fail",
            process: () => {
              throw new Error("First error");
            },
          };
          const plugin2: Plugin = {
            name: "second-fail",
            process: () => {
              throw new Error("Second error");
            },
          };
          mock("GET /cascade", "original").pipe(plugin1).pipe(plugin2);
        },
      );

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response should contain error {string}",
        (_, errorMessage: string) => {
          expect(responseBodyString(response, "error")).toContain(errorMessage);
        },
      );
    },
  );

  Scenario("Plugin onError hook also fails", ({ Given, When, Then, And }) => {
    Given(
      "I create a mock with a plugin whose error handler also throws",
      () => {
        mock = schmock({ debug: true });
        const brokenPlugin: Plugin = {
          name: "broken-handler",
          process: () => {
            throw new Error("Process failed");
          },
          onError: () => {
            throw new Error("Handler failed");
          },
        };
        mock("GET /broken", "original").pipe(brokenPlugin);
      },
    );

    When("I request {string}", async (_, request: string) => {
      const { method, path } = parseRequest(request);
      response = await mock.handle(method, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And(
      "the response should contain error {string}",
      (_, errorMessage: string) => {
        expect(responseBodyString(response, "error")).toContain(errorMessage);
      },
    );
  });

  Scenario(
    "Downstream error handler recovers an earlier plugin failure",
    ({ Given, When, Then, And }) => {
      Given("I create a failing plugin followed by a recovery plugin", () => {
        mock = schmock();
        mock("GET /downstream-recovery", "original")
          .pipe({
            name: "upstream-failure",
            process() {
              throw new Error("upstream failed");
            },
          })
          .pipe({
            name: "downstream-recovery",
            process(context, currentResponse) {
              return { context, response: currentResponse };
            },
            onError() {
              return [
                503,
                {
                  error: "Recovered by downstream plugin",
                  code: "RECOVERED_DOWNSTREAM",
                },
              ];
            },
          });
      });

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And("the response should have error code {string}", (_, code: string) => {
        expect(responseBodyString(response, "code")).toBe(code);
      });
    },
  );

  Scenario(
    "Empty parameter in route returns 404",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock with a parameterized route {string}",
        (_, route: string) => {
          mock = schmock();
          const { method, path } = parseRequest(route);
          mock(toRouteKey(method, path), ({ params }) => ({
            userId: params.id,
          }));
        },
      );

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response should contain error {string}",
        (_, errorMessage: string) => {
          expect(responseBodyString(response, "error")).toContain(errorMessage);
        },
      );
    },
  );

  Scenario("Async generator error handling", ({ Given, When, Then, And }) => {
    Given(
      "I create a mock with an async generator that throws {string}",
      (_, errorMsg: string) => {
        mock = schmock();
        mock("GET /async-fail", async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error(errorMsg);
        });
      },
    );

    When("I request {string}", async (_, request: string) => {
      const { method, path } = parseRequest(request);
      response = await mock.handle(method, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And(
      "the response should contain error {string}",
      (_, errorMessage: string) => {
        expect(responseBodyString(response, "error")).toContain(errorMessage);
      },
    );
  });

  Scenario(
    "Error responses include proper headers",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock with a generator that throws {string}",
        (_, errorMsg: string) => {
          mock = schmock();
          mock("GET /error", () => {
            throw new Error(errorMsg);
          });
        },
      );

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And("the content-type should be {string}", (_, contentType: string) => {
        expect(response.headers["content-type"]).toBe(contentType);
      });

      And(
        "the response body should be a structured {string} error for {string}",
        (_, code: string, message: string) => {
          expect(response.body).toEqual({ error: message, code });
        },
      );
    },
  );

  Scenario(
    "Invalid plugin recovery status returns a structured error",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock with a plugin whose error handler returns status 0",
        () => {
          mock = schmock();
          const plugin: Plugin = {
            name: "zero-status",
            process: () => {
              throw new Error("fail");
            },
            onError: () => ({ status: 0, body: "zero status", headers: {} }),
          };
          mock("GET /zero", "original").pipe(plugin);
        },
      );

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And("the response should have error code {string}", (_, code: string) => {
        expect(response.body).toMatchObject({ code });
      });
    },
  );

  Scenario(
    "Plugin null/undefined return handling",
    ({ Given, When, Then, And }) => {
      Given("I create a mock with a plugin that returns null", () => {
        mock = schmock();
        const nullPlugin: Plugin = {
          name: "null-plugin",
          process: (context) => ({ context }),
        };
        Object.defineProperty(nullPlugin, "process", {
          value: () => null,
        });
        mock("GET /null", "original").pipe(nullPlugin);
      });

      When("I request {string}", async (_, request: string) => {
        const { method, path } = parseRequest(request);
        response = await mock.handle(method, path);
      });

      Then("I should receive status {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response should contain error {string}",
        (_, errorMessage: string) => {
          expect(responseBodyString(response, "error")).toContain(errorMessage);
        },
      );
    },
  );
});
