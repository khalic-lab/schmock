import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { expect } from "vitest";
import { openapi } from "../plugin";

const feature = await loadFeature("../../features/security-validation.feature");

const bearerSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/items": {
      get: { responses: { "200": { description: "OK" } } },
    },
  },
};

const apiKeySpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    "/items": {
      get: { responses: { "200": { description: "OK" } } },
    },
  },
};

const queryApiKeySpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", in: "query", name: "api_key" },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    "/items": {
      get: { responses: { "200": { description: "OK" } } },
    },
  },
};

const cookieApiKeySpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", in: "cookie", name: "session_key" },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    "/items": {
      get: { responses: { "200": { description: "OK" } } },
    },
  },
};

const basicSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  components: {
    securitySchemes: {
      basicAuth: { type: "http", scheme: "basic" },
    },
  },
  security: [{ basicAuth: [] }],
  paths: {
    "/items": {
      get: { responses: { "200": { description: "OK" } } },
    },
  },
};

const mixedSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/items": {
      get: { responses: { "200": { description: "OK" } } },
    },
    "/health": {
      get: {
        security: [],
        responses: { "200": { description: "OK" } },
      },
    },
  },
};

const protectedCrudSpec = {
  openapi: "3.0.3",
  info: { title: "Test", version: "1.0.0" },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "List",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      itemId: { type: "integer" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
    },
  },
};

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let response: Schmock.Response;

  Scenario("Missing Bearer token returns 401", ({ Given, When, Then, And }) => {
    Given("a mock with a spec requiring Bearer auth", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: bearerSpec, security: true }));
    });

    When("I request without an Authorization header", async () => {
      response = await mock.handle("GET", "/items", { headers: {} });
    });

    Then("the response status is 401", () => {
      expect(response.status).toBe(401);
    });

    And('the response has a WWW-Authenticate header with "Bearer"', () => {
      expect(response.headers["www-authenticate"]).toContain("Bearer");
    });
  });

  Scenario("Valid Bearer token returns 200", ({ Given, When, Then }) => {
    Given("a mock with a spec requiring Bearer auth", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: bearerSpec, security: true }));
    });

    When('I request with Authorization header "Bearer my-token"', async () => {
      response = await mock.handle("GET", "/items", {
        headers: { authorization: "Bearer my-token" },
      });
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });
  });

  Scenario("Empty Bearer token returns 401", ({ Given, When, Then }) => {
    Given("a mock with a spec requiring Bearer auth", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: bearerSpec, security: true }));
    });

    When('I request with Authorization header "Bearer "', async () => {
      response = await mock.handle("GET", "/items", {
        headers: { authorization: "Bearer " },
      });
    });

    Then("the response status is 401", () => {
      expect(response.status).toBe(401);
    });
  });

  Scenario("API key in header is validated", ({ Given, When, Then }) => {
    Given("a mock with a spec requiring an API key header", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: apiKeySpec, security: true }));
    });

    When("I request without the API key header", async () => {
      response = await mock.handle("GET", "/items", { headers: {} });
    });

    Then("the response status is 401", () => {
      expect(response.status).toBe(401);
    });
  });

  Scenario("Valid API key passes through", ({ Given, When, Then }) => {
    Given("a mock with a spec requiring an API key header", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: apiKeySpec, security: true }));
    });

    When("I request with the API key header present", async () => {
      response = await mock.handle("GET", "/items", {
        headers: { "x-api-key": "my-key-123" },
      });
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });
  });

  Scenario("API key in query is validated", ({ Given, When, Then }) => {
    Given(
      "a mock with a spec requiring an API key query parameter",
      async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: queryApiKeySpec, security: true }));
      },
    );

    When("I request without the API key query parameter", async () => {
      response = await mock.handle("GET", "/items", { query: {} });
    });

    Then("the response status is 401", () => {
      expect(response.status).toBe(401);
    });
  });

  Scenario("Valid API key query passes through", ({ Given, When, Then }) => {
    Given(
      "a mock with a spec requiring an API key query parameter",
      async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: queryApiKeySpec, security: true }));
      },
    );

    When("I request with the API key query parameter present", async () => {
      response = await mock.handle("GET", "/items", {
        query: { api_key: "secret" },
      });
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });
  });

  Scenario("API key in a cookie is validated", ({ Given, When, Then }) => {
    Given("a mock with a spec requiring an API key cookie", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: cookieApiKeySpec, security: true }));
    });

    When("I request without the API key cookie", async () => {
      response = await mock.handle("GET", "/items", { headers: {} });
    });

    Then("the response status is 401", () => {
      expect(response.status).toBe(401);
    });
  });

  Scenario("Valid API key cookie passes through", ({ Given, When, Then }) => {
    Given("a mock with a spec requiring an API key cookie", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: cookieApiKeySpec, security: true }));
    });

    When("I request with the API key cookie present", async () => {
      response = await mock.handle("GET", "/items", {
        headers: { cookie: "theme=dark; session_key=secret" },
      });
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });
  });

  Scenario("Basic auth is validated", ({ Given, When, Then, And }) => {
    Given("a mock with a spec requiring Basic auth", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: basicSpec, security: true }));
    });

    When("I request without an Authorization header", async () => {
      response = await mock.handle("GET", "/items", { headers: {} });
    });

    Then("the response status is 401", () => {
      expect(response.status).toBe(401);
    });

    And('the response has a WWW-Authenticate header with "Basic"', () => {
      expect(response.headers["www-authenticate"]).toContain("Basic");
    });
  });

  Scenario("Empty Basic credentials return 401", ({ Given, When, Then }) => {
    Given("a mock with a spec requiring Basic auth", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: basicSpec, security: true }));
    });

    When('I request with Authorization header "Basic "', async () => {
      response = await mock.handle("GET", "/items", {
        headers: { authorization: "Basic " },
      });
    });

    Then("the response status is 401", () => {
      expect(response.status).toBe(401);
    });
  });

  Scenario("Public endpoint skips validation", ({ Given, When, Then }) => {
    Given("a mock with a spec where one endpoint is public", async () => {
      mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: mixedSpec, security: true }));
    });

    When("I request the public endpoint without auth", async () => {
      response = await mock.handle("GET", "/health", { headers: {} });
    });

    Then("the response status is 200", () => {
      expect(response.status).toBe(200);
    });
  });

  Scenario(
    "Unauthorized creation does not mutate the collection",
    ({ Given, When, Then, And }) => {
      let createResponse: Schmock.Response;
      let listResponse: Schmock.Response;

      Given("a mock with a protected CRUD spec", async () => {
        mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: protectedCrudSpec, security: true }));
      });

      When("I create an item without auth", async () => {
        createResponse = await mock.handle("POST", "/items", {
          body: { name: "blocked" },
        });
      });

      And("I list the items with valid auth", async () => {
        listResponse = await mock.handle("GET", "/items", {
          headers: { authorization: "Bearer secret" },
        });
      });

      Then("the create response status is 401", () => {
        expect(createResponse.status).toBe(401);
      });

      And("the protected collection is empty", () => {
        expect(listResponse.body).toEqual([]);
      });
    },
  );

  Scenario(
    "An earlier request guard cannot be rewritten as success",
    ({ Given, When, Then }) => {
      Given("an external guard before an OpenAPI plugin", async () => {
        mock = schmock({ state: {} });
        const guard: Schmock.Plugin = {
          name: "external-guard",
          beforeRequest(context) {
            return {
              context,
              response: [403, { code: "FORBIDDEN" }],
            };
          },
          process(context, incomingResponse) {
            return { context, response: incomingResponse };
          },
        };
        mock.pipe(guard);
        mock.pipe(await openapi({ spec: bearerSpec }));
      });

      When(
        "I request the guarded OpenAPI route preferring status 200",
        async () => {
          response = await mock.handle("GET", "/items", {
            headers: { prefer: "code=200" },
          });
        },
      );

      Then("the guarded OpenAPI response status is 403", () => {
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ code: "FORBIDDEN" });
      });
    },
  );
});
