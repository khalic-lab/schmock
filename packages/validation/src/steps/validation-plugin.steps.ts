import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { validationPlugin } from "../index";

const feature = await loadFeature("../../features/validation-plugin.feature");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseBodyRecord(
  response: Schmock.Response,
): Record<string, unknown> {
  if (!isRecord(response.body)) {
    throw new Error("Expected the validation response body to be an object");
  }
  return response.body;
}

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;
  let validatedGeneratorExecutions = 0;

  Scenario(
    "Valid request body passes validation",
    ({ Given, When, Then, And }) => {
      Given("I create a validated mock that requires name and email", () => {
        mock = schmock();
        mock("POST /users", ({ body }) => [201, body]).pipe(
          validationPlugin({
            request: {
              body: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  email: { type: "string" },
                },
                required: ["name", "email"],
              },
            },
          }),
        );
      });

      When(
        "I send a valid POST with name {string} and email {string}",
        async (_, name: string, email: string) => {
          response = await mock.handle("POST", "/users", {
            body: { name, email },
          });
        },
      );

      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response body should have property {string} with value {string}",
        (_, prop: string, value: string) => {
          expect(responseBodyRecord(response)[prop]).toBe(value);
        },
      );
    },
  );

  Scenario("Invalid request body returns 400", ({ Given, When, Then, And }) => {
    Given("I create a validated mock that requires name and email", () => {
      mock = schmock();
      mock("POST /users", ({ body }) => [201, body]).pipe(
        validationPlugin({
          request: {
            body: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string" },
              },
              required: ["name", "email"],
            },
          },
        }),
      );
    });

    When("I send an invalid POST missing required fields", async () => {
      response = await mock.handle("POST", "/users", {
        body: { name: "John" },
      });
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And(
      "the response body should have error code {string}",
      (_, code: string) => {
        expect(responseBodyRecord(response).code).toBe(code);
      },
    );
  });

  Scenario(
    "Required body flag works without a request schema",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a validated mock with body required but no body schema",
        () => {
          validatedGeneratorExecutions = 0;
          mock = schmock();
          mock("POST /required-body", () => {
            validatedGeneratorExecutions += 1;
            return [201, { created: true }];
          }).pipe(
            validationPlugin({
              request: {
                bodyRequired: true,
              },
            }),
          );
        },
      );

      When("I send the POST without a body", async () => {
        response = await mock.handle("POST", "/required-body");
      });

      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response body should have error code {string}",
        (_, code: string) => {
          expect(responseBodyRecord(response).code).toBe(code);
        },
      );

      And("the validated generator should not have executed", () => {
        expect(validatedGeneratorExecutions).toBe(0);
      });
    },
  );

  Scenario(
    "Request rejection is not replaced by response validation",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock with incompatible request and response validation",
        () => {
          validatedGeneratorExecutions = 0;
          mock = schmock();
          mock("POST /combined-validation", () => {
            validatedGeneratorExecutions += 1;
            return { created: true };
          }).pipe(
            validationPlugin({
              request: {
                body: {
                  type: "object",
                  required: ["name"],
                  properties: { name: { type: "string" } },
                },
              },
              response: {
                body: {
                  type: "object",
                  required: ["created"],
                  properties: { created: { type: "boolean" } },
                },
              },
            }),
          );
        },
      );

      When("I send an invalid POST to the combined validator", async () => {
        response = await mock.handle("POST", "/combined-validation", {
          body: {},
        });
      });

      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response body should have error code {string}",
        (_, code: string) => {
          expect(responseBodyRecord(response).code).toBe(code);
        },
      );

      And("the validated generator should not have executed", () => {
        expect(validatedGeneratorExecutions).toBe(0);
      });
    },
  );

  Scenario(
    "Invalid response body returns 500",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock with response validation that expects a number id",
        () => {
          mock = schmock();
          mock("GET /item", { id: "not-a-number", name: "Test" }).pipe(
            validationPlugin({
              response: {
                body: {
                  type: "object",
                  properties: {
                    id: { type: "number" },
                    name: { type: "string" },
                  },
                  required: ["id"],
                },
              },
            }),
          );
        },
      );

      When("I request the endpoint", async () => {
        response = await mock.handle("GET", "/item");
      });

      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response body should have error code {string}",
        (_, code: string) => {
          expect(responseBodyRecord(response).code).toBe(code);
        },
      );
    },
  );

  Scenario("Valid response passes validation", ({ Given, When, Then, And }) => {
    Given("I create a mock with valid response and response validation", () => {
      mock = schmock();
      mock("GET /item", { id: 42, name: "Test" }).pipe(
        validationPlugin({
          response: {
            body: {
              type: "object",
              properties: {
                id: { type: "number" },
                name: { type: "string" },
              },
              required: ["id"],
            },
          },
        }),
      );
    });

    When("I request the endpoint", async () => {
      response = await mock.handle("GET", "/item");
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And(
      "the response body should have property {string} with numeric value",
      (_, prop: string) => {
        expect(typeof responseBodyRecord(response)[prop]).toBe("number");
      },
    );
  });

  Scenario(
    "Structured response object validates its semantic body",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock returning a structured response with a valid numeric id",
        () => {
          mock = schmock();
          mock("GET /structured-response", () => ({
            status: 202,
            body: { id: 42 },
            headers: { "x-response-shape": "structured" },
          })).pipe(
            validationPlugin({
              response: {
                body: {
                  type: "object",
                  properties: { id: { type: "number" } },
                  required: ["id"],
                },
              },
            }),
          );
        },
      );

      When("I request the structured response endpoint", async () => {
        response = await mock.handle("GET", "/structured-response");
      });

      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response body should have property {string} with numeric value",
        (_, prop: string) => {
          expect(typeof responseBodyRecord(response)[prop]).toBe("number");
        },
      );

      And(
        "the response header {string} should be {string}",
        (_, header: string, value: string) => {
          expect(response.headers[header]).toBe(value);
        },
      );
    },
  );

  Scenario(
    "Malformed response envelope is validated as a plain body",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock returning a structured response with non-string headers",
        () => {
          mock = schmock();
          // Core refuses to unwrap an envelope whose headers are not a string
          // record and delivers the whole object as the body, so validation
          // must judge that same object.
          mock("GET /malformed-envelope", () => ({
            status: 200,
            body: { ok: true },
            headers: { attempts: 5 },
          })).pipe(
            validationPlugin({
              response: {
                body: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                  required: ["ok"],
                },
              },
            }),
          );
        },
      );

      When("I request the malformed envelope endpoint", async () => {
        response = await mock.handle("GET", "/malformed-envelope");
      });

      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response body should have error code {string}",
        (_, code: string) => {
          expect(responseBodyRecord(response).code).toBe(code);
        },
      );
    },
  );

  Scenario(
    "Undefined semantic response body is validated",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock returning an undefined body against a null response schema",
        () => {
          mock = schmock();
          mock("GET /undefined-response", () => ({
            status: 204,
            body: undefined,
            headers: {},
          })).pipe(
            validationPlugin({
              response: { body: { type: "null" } },
            }),
          );
        },
      );

      When("I request the undefined response endpoint", async () => {
        response = await mock.handle("GET", "/undefined-response");
      });

      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response body should have error code {string}",
        (_, code: string) => {
          expect(responseBodyRecord(response).code).toBe(code);
        },
      );
    },
  );

  Scenario(
    "Header validation rejects missing required headers",
    ({ Given, When, Then, And }) => {
      Given("I create a mock requiring an authorization header", () => {
        mock = schmock();
        mock("GET /secure", { data: "secret" }).pipe(
          validationPlugin({
            request: {
              headers: {
                type: "object",
                properties: {
                  authorization: { type: "string" },
                },
                required: ["authorization"],
              },
            },
          }),
        );
      });

      When("I request without authorization header", async () => {
        response = await mock.handle("GET", "/secure");
      });

      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });

      And(
        "the response body should have error code {string}",
        (_, code: string) => {
          expect(responseBodyRecord(response).code).toBe(code);
        },
      );
    },
  );

  Scenario(
    "Header validation passes with required headers",
    ({ Given, When, Then }) => {
      Given("I create a mock requiring an authorization header", () => {
        mock = schmock();
        mock("GET /secure", { data: "secret" }).pipe(
          validationPlugin({
            request: {
              headers: {
                type: "object",
                properties: {
                  authorization: { type: "string" },
                },
                required: ["authorization"],
              },
            },
          }),
        );
      });

      When(
        "I request with authorization header {string}",
        async (_, token: string) => {
          response = await mock.handle("GET", "/secure", {
            headers: { authorization: token },
          });
        },
      );

      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });
    },
  );

  Scenario("Query parameter validation", ({ Given, When, Then, And }) => {
    let invalidQueryResponse: Schmock.Response;

    Given("I create a mock requiring page query parameter", () => {
      mock = schmock();
      mock("GET /items", [{ id: 1 }]).pipe(
        validationPlugin({
          request: {
            query: {
              type: "object",
              properties: {
                page: { type: "string" },
              },
              required: ["page"],
            },
          },
        }),
      );
    });

    When("I request with query page {string}", async (_, page: string) => {
      response = await mock.handle("GET", "/items", {
        query: { page },
      });
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    When("I request without required query parameter", async () => {
      invalidQueryResponse = await mock.handle("GET", "/items");
    });

    Then("the invalid query status should be {int}", (_, status: number) => {
      expect(invalidQueryResponse.status).toBe(status);
    });

    And(
      "the invalid query response should have error code {string}",
      (_, code: string) => {
        expect(responseBodyRecord(invalidQueryResponse).code).toBe(code);
      },
    );
  });

  Scenario("Custom error status codes", ({ Given, When, Then }) => {
    Given(
      "I create a validated mock with custom error status {int}",
      (_, status: number) => {
        mock = schmock();
        mock("POST /users", ({ body }) => [201, body]).pipe(
          validationPlugin({
            request: {
              body: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
                required: ["name"],
              },
            },
            requestErrorStatus: status,
          }),
        );
      },
    );

    When("I send an invalid request body", async () => {
      response = await mock.handle("POST", "/users", {
        body: {},
      });
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });
  });

  const givenEmailFormatMock = () => {
    mock = schmock();
    mock("POST /users", ({ body }) => [201, body]).pipe(
      validationPlugin({
        request: {
          body: {
            type: "object",
            properties: {
              email: { type: "string", format: "email" },
            },
            required: ["email"],
          },
        },
      }),
    );
  };

  const whenPostingEmail = async (_: unknown, email: string) => {
    response = await mock.handle("POST", "/users", {
      body: { email },
    });
  };

  Scenario(
    "Email format validation rejects malformed strings",
    ({ Given, When, Then, And }) => {
      Given(
        "I create a mock validating email format on the email field",
        givenEmailFormatMock,
      );
      When("I send a POST with email {string}", whenPostingEmail);
      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });
      And(
        "the response body should have error code {string}",
        (_, code: string) => {
          expect(responseBodyRecord(response).code).toBe(code);
        },
      );
    },
  );

  Scenario(
    "Email format validation accepts well-formed addresses",
    ({ Given, When, Then }) => {
      Given(
        "I create a mock validating email format on the email field",
        givenEmailFormatMock,
      );
      When("I send a POST with email {string}", whenPostingEmail);
      Then("the status should be {int}", (_, status: number) => {
        expect(response.status).toBe(status);
      });
    },
  );
});
