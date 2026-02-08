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
        security: [{}],
        responses: { "200": { description: "OK" } },
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
});
