import { resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/openapi-compliance.feature");
const fixturesDir = resolve(import.meta.dirname, "../__fixtures__");

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  Scenario(
    "Wrapped list response with allOf composition",
    ({ Given, When, Then, And }) => {
      Given("a mock with the Scalar Galaxy spec loaded", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({
            spec: `${fixturesDir}/scalar-galaxy.yaml`,
            seed: {
              planets: [{ planetId: 1, name: "Earth", type: "terrestrial" }],
            },
          }),
        );
      });

      When("I list all planets", async () => {
        response = await mock.handle("GET", "/planets");
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And('the list body has a "data" property with an array', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.data).toBeDefined();
        expect(Array.isArray(body.data)).toBe(true);
      });

      And('the list body has a "meta" property', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.meta).toBeDefined();
      });
    },
  );

  Scenario(
    "Wrapped list response with inline object",
    ({ Given, When, Then, And }) => {
      Given("a mock with a Stripe-style spec loaded", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({
            spec: {
              openapi: "3.0.3",
              info: { title: "StripeStyle", version: "1.0.0" },
              paths: {
                "/v1/customers": {
                  get: {
                    responses: {
                      "200": {
                        description: "List",
                        content: {
                          "application/json": {
                            schema: {
                              type: "object",
                              properties: {
                                data: {
                                  type: "array",
                                  items: {
                                    type: "object",
                                    properties: {
                                      id: { type: "integer" },
                                      email: { type: "string" },
                                    },
                                  },
                                },
                                has_more: { type: "boolean" },
                                object: {
                                  type: "string",
                                  enum: ["list"],
                                },
                                url: { type: "string" },
                              },
                              required: ["data", "has_more", "object", "url"],
                            },
                          },
                        },
                      },
                    },
                  },
                  post: {
                    responses: { "201": { description: "Created" } },
                  },
                },
                "/v1/customers/{customer}": {
                  get: {
                    parameters: [
                      {
                        name: "customer",
                        in: "path",
                        required: true,
                      },
                    ],
                    responses: { "200": { description: "Customer" } },
                  },
                  delete: {
                    parameters: [
                      {
                        name: "customer",
                        in: "path",
                        required: true,
                      },
                    ],
                    responses: { "204": { description: "Deleted" } },
                  },
                },
              },
            },
            seed: {
              customers: [{ customer: 1, email: "alice@test.com" }],
            },
          }),
        );
      });

      When("I list all customers", async () => {
        response = await mock.handle("GET", "/v1/customers");
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And('the list body has a "data" property with an array', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.data).toBeDefined();
        expect(Array.isArray(body.data)).toBe(true);
      });

      And('the list body has an "object" property equal to "list"', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.object).toBe("list");
      });
    },
  );

  Scenario(
    "Flat list response for plain array spec",
    ({ Given, When, Then, And }) => {
      Given("a mock with the Petstore spec loaded", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({
            spec: `${fixturesDir}/petstore-swagger2.json`,
            seed: { pets: [{ petId: 1, name: "Buddy" }] },
          }),
        );
      });

      When("I list all pets", async () => {
        response = await mock.handle("GET", "/pets");
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the list body is a flat array", () => {
        expect(Array.isArray(response.body)).toBe(true);
      });
    },
  );

  Scenario(
    "Spec-defined error response schema",
    ({ Given, When, Then, And }) => {
      Given("a mock with the Scalar Galaxy spec loaded", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: `${fixturesDir}/scalar-galaxy.yaml` }));
      });

      When("I read planet with id 999", async () => {
        response = await mock.handle("GET", "/planets/999");
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });

      And('the error body has a "title" property', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.title).toBeDefined();
      });

      And('the error body has a "status" property', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.status).toBeDefined();
      });
    },
  );

  Scenario(
    "Default error format when no error schema defined",
    ({ Given, When, Then, And }) => {
      Given("a mock with the Petstore spec loaded", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({
            spec: `${fixturesDir}/petstore-swagger2.json`,
          }),
        );
      });

      When("I read pet with id 999", async () => {
        response = await mock.handle("GET", "/pets/999");
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });

      And('the error body has property "error" equal to "Not found"', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.error).toBe("Not found");
      });

      And('the error body has property "code" equal to "NOT_FOUND"', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.code).toBe("NOT_FOUND");
      });
    },
  );

  Scenario(
    "Response headers from spec definitions",
    ({ Given, When, Then, And }) => {
      Given("a mock with the Scalar Galaxy spec and seed data", async () => {
        mock = schmock({ state: {} });
        mock.pipe(
          await openapi({
            spec: `${fixturesDir}/scalar-galaxy.yaml`,
            seed: {
              planets: [{ planetId: 1, name: "Earth", type: "terrestrial" }],
            },
          }),
        );
      });

      When("I list all planets", async () => {
        response = await mock.handle("GET", "/planets");
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And('the response has header "X-Request-ID"', () => {
        expect(response.headers["X-Request-ID"]).toBeDefined();
      });

      And('the response has header "X-Pagination-Total"', () => {
        expect(response.headers["X-Pagination-Total"]).toBeDefined();
      });
    },
  );

  Scenario(
    "Response headers from spec definitions on a non-CRUD route",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a spec whose non-CRUD GET declares response headers",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: {
                openapi: "3.0.3",
                info: { title: "Health", version: "1.0.0" },
                paths: {
                  "/health": {
                    get: {
                      responses: {
                        "200": {
                          description: "OK",
                          headers: {
                            "X-Request-ID": {
                              description: "Correlation id",
                              schema: { type: "string", format: "uuid" },
                            },
                            "X-Rate-Limit": {
                              description: "Remaining calls",
                              schema: { type: "integer" },
                            },
                          },
                          content: {
                            "application/json": {
                              schema: {
                                type: "object",
                                properties: { status: { type: "string" } },
                                required: ["status"],
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            }),
          );
        },
      );

      When("I check service health", async () => {
        response = await mock.handle("GET", "/health");
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And('the response has header "X-Request-ID"', () => {
        expect(response.headers["X-Request-ID"]).toBeDefined();
      });

      And('the response has header "X-Rate-Limit"', () => {
        expect(response.headers["X-Rate-Limit"]).toBeDefined();
      });
    },
  );

  Scenario(
    "Manual override forces wrapping on a flat-array spec",
    ({ Given, When, Then, And }) => {
      Given(
        'a mock with the Petstore spec and listWrapProperty "items" override',
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: `${fixturesDir}/petstore-swagger2.json`,
              seed: { pets: [{ petId: 1, name: "Buddy" }] },
              resources: {
                pets: { listWrapProperty: "items" },
              },
            }),
          );
        },
      );

      When("I list all pets", async () => {
        response = await mock.handle("GET", "/pets");
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And('the list body has a "items" property with an array', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.items).toBeDefined();
        expect(Array.isArray(body.items)).toBe(true);
        const items = body.items as unknown[];
        expect(items).toHaveLength(1);
      });
    },
  );

  Scenario(
    "Manual override forces flat on a wrapped spec",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with the Scalar Galaxy spec and listFlat override",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: `${fixturesDir}/scalar-galaxy.yaml`,
              seed: {
                planets: [{ planetId: 1, name: "Earth", type: "terrestrial" }],
              },
              resources: {
                planets: { listFlat: true },
              },
            }),
          );
        },
      );

      When("I list all planets", async () => {
        response = await mock.handle("GET", "/planets");
      });

      Then("the response status is 200", () => {
        expect(response.status).toBe(200);
      });

      And("the list body is a flat array", () => {
        expect(Array.isArray(response.body)).toBe(true);
      });
    },
  );

  Scenario(
    "Manual errorSchema override replaces auto-detected error format",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with the Petstore spec and custom error schema override",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: `${fixturesDir}/petstore-swagger2.json`,
              resources: {
                pets: {
                  errorSchema: {
                    type: "object",
                    properties: {
                      message: {
                        type: "string",
                        default: "Resource not found",
                      },
                      statusCode: {
                        type: "integer",
                        default: 404,
                      },
                    },
                    required: ["message", "statusCode"],
                  },
                },
              },
            }),
          );
        },
      );

      When("I read pet with id 999", async () => {
        response = await mock.handle("GET", "/pets/999");
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });

      And('the error body has a "message" property', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.message).toBeDefined();
      });

      And('the error body has a "statusCode" property', () => {
        const body = response.body as Record<string, unknown>;
        expect(body.statusCode).toBeDefined();
      });
    },
  );

  Scenario(
    "Operation declaring no 2xx response answers with its lowest declared status",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a spec whose only responses are 404 and 503",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: {
                openapi: "3.0.3",
                info: { title: "Archive", version: "1.0.0" },
                paths: {
                  "/archive": {
                    get: {
                      responses: {
                        "404": {
                          description: "Gone for good",
                          headers: {
                            "X-Error-Code": {
                              description: "Machine readable code",
                              schema: { type: "string", enum: ["ARCHIVED"] },
                            },
                          },
                          content: {
                            "application/json": {
                              schema: {
                                type: "object",
                                properties: {
                                  reason: {
                                    type: "string",
                                    enum: ["archived"],
                                  },
                                },
                                required: ["reason"],
                              },
                            },
                          },
                        },
                        "503": {
                          description: "Try later",
                          content: {
                            "application/json": {
                              schema: {
                                type: "object",
                                properties: {
                                  retryAfter: { type: "integer" },
                                },
                                required: ["retryAfter"],
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            }),
          );
        },
      );

      When("I check the archive endpoint", async () => {
        response = await mock.handle("GET", "/archive");
      });

      Then("the response status is 404", () => {
        expect(response.status).toBe(404);
      });

      And("the body was generated from the 404 schema", () => {
        const body = response.body as Record<string, unknown>;
        expect(body.reason).toBe("archived");
        expect(body.retryAfter).toBeUndefined();
      });

      // The headers come from the same entry the status does, so a 404-only
      // operation emits the 404 entry's declared headers at status 404.
      And('the response has header "X-Error-Code"', () => {
        expect(response.headers["X-Error-Code"]).toBe("ARCHIVED");
      });
    },
  );

  Scenario(
    "Response schema generation failure returns a structured 500",
    ({ Given, When, Then, And }) => {
      Given(
        "a mock with a spec whose response schema cannot be generated",
        async () => {
          mock = schmock({ state: {} });
          mock.pipe(
            await openapi({
              spec: {
                openapi: "3.0.3",
                info: { title: "Broken", version: "1.0.0" },
                paths: {
                  "/broken": {
                    get: {
                      responses: {
                        "200": {
                          description: "OK",
                          content: {
                            "application/json": {
                              // No branch to choose from: generation blows up
                              // where it used to be laundered into `200 {}`.
                              schema: { anyOf: [] },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            }),
          );
        },
      );

      When("I check the broken endpoint", async () => {
        response = await mock.handle("GET", "/broken");
      });

      Then("the response status is 500", () => {
        expect(response.status).toBe(500);
      });

      // The specific code depends on where generation gave up (a SchmockError
      // from faker is rethrown with its own code), so the contract pinned here
      // is that there IS a stable, non-empty code.
      And('the error body has a non-empty "code"', () => {
        const body = response.body as Record<string, unknown>;
        expect(typeof body.code).toBe("string");
        expect(body.code).not.toBe("");
      });

      And("the error body message names the route", () => {
        const body = response.body as Record<string, unknown>;
        expect(String(body.error)).toContain("GET /broken");
      });
    },
  );
});
