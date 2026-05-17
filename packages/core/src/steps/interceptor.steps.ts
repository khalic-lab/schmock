/// <reference path="../../schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import { schmock } from "../index.js";

const feature = await loadFeature("../../features/fetch-interceptor.feature");

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance;
  let handle: Schmock.InterceptHandle | undefined;
  let originalFetch: typeof globalThis.fetch;
  let savedFetch: ReturnType<typeof vi.fn>;
  let fetchResponse: Response | undefined;

  function setup() {
    originalFetch = globalThis.fetch;
    savedFetch = vi.fn().mockResolvedValue(new Response("real backend"));
    globalThis.fetch = savedFetch;
    mock = schmock();
    fetchResponse = undefined;
  }

  AfterEachScenario(() => {
    handle?.restore();
    handle = undefined;
    globalThis.fetch = originalFetch;
  });

  Scenario("Intercept a matched fetch request", ({ Given, When, Then, And }) => {
    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      setup();
      mock("GET /api/users", [{ id: 1, name: "Alice" }]);
    });

    And("fetch is intercepted", () => {
      handle = mock.intercept();
    });

    When("I fetch \"/api/users\"", async () => {
      fetchResponse = await fetch("http://localhost/api/users");
    });

    Then("the fetch response status should be 200", () => {
      expect(fetchResponse?.status).toBe(200);
    });

    And("the fetch response body should be the mocked users", async () => {
      const body = await fetchResponse?.json();
      expect(body).toEqual([{ id: 1, name: "Alice" }]);
    });
  });

  Scenario("Passthrough for unmatched routes", ({ Given, When, Then, And }) => {
    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      setup();
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted with passthrough enabled", () => {
      handle = mock.intercept({ passthrough: true });
    });

    When("I fetch \"/api/other\"", async () => {
      fetchResponse = await fetch("http://localhost/api/other");
    });

    Then("the original fetch should have been called", () => {
      expect(savedFetch).toHaveBeenCalled();
    });
  });

  Scenario("Passthrough disabled returns 404", ({ Given, When, Then, And }) => {
    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      setup();
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted with passthrough disabled", () => {
      handle = mock.intercept({ passthrough: false });
    });

    When("I fetch \"/api/other\"", async () => {
      fetchResponse = await fetch("http://localhost/api/other");
    });

    Then("the fetch response status should be 404", () => {
      expect(fetchResponse?.status).toBe(404);
    });
  });

  Scenario("Restore puts original fetch back", ({ Given, When, Then, And }) => {
    let savedRef: typeof globalThis.fetch;

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      setup();
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted", () => {
      savedRef = globalThis.fetch;
      handle = mock.intercept();
    });

    When("I restore the interceptor", () => {
      handle?.restore();
    });

    Then("globalThis.fetch should be the original function", () => {
      expect(globalThis.fetch).toBe(savedRef);
    });
  });

  Scenario("BaseUrl filters which requests are intercepted", ({ Given, When, Then, And }) => {
    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      setup();
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted with baseUrl \"/api\"", () => {
      handle = mock.intercept({ baseUrl: "/api" });
    });

    When("I fetch \"/other/endpoint\"", async () => {
      await fetch("http://localhost/other/endpoint");
    });

    Then("the original fetch should have been called", () => {
      expect(savedFetch).toHaveBeenCalled();
    });
  });

  Scenario("Origin-form baseUrl intercepts matching origin only", ({ Given, When, Then, And }) => {
    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      setup();
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted with baseUrl \"https://api.example.com\"", () => {
      handle = mock.intercept({ baseUrl: "https://api.example.com" });
    });

    When("I fetch \"https://api.example.com/api/users\"", async () => {
      fetchResponse = await fetch("https://api.example.com/api/users");
    });

    Then("the response status should be {int}", (_, status: number) => {
      expect(fetchResponse?.status).toBe(status);
    });

    When("I fetch \"https://other.example.com/api/users\"", async () => {
      await fetch("https://other.example.com/api/users");
    });

    Then("the original fetch should have been called", () => {
      expect(savedFetch).toHaveBeenCalled();
    });
  });

  Scenario("Origin-form baseUrl with a path prefix requires both to match", ({ Given, When, Then, And }) => {
    Given("a Schmock instance with route \"GET /v1/users\" returning users", () => {
      setup();
      mock("GET /v1/users", [{ id: 1 }]);
    });

    And("fetch is intercepted with baseUrl \"https://api.example.com/v1\"", () => {
      handle = mock.intercept({ baseUrl: "https://api.example.com/v1" });
    });

    When("I fetch \"https://api.example.com/v1/users\"", async () => {
      fetchResponse = await fetch("https://api.example.com/v1/users");
    });

    Then("the response status should be {int}", (_, status: number) => {
      expect(fetchResponse?.status).toBe(status);
    });

    When("I fetch \"https://api.example.com/users\"", async () => {
      await fetch("https://api.example.com/users");
    });

    Then("the original fetch should have been called", () => {
      expect(savedFetch).toHaveBeenCalled();
    });
  });

  Scenario("beforeRequest hook modifies the request", ({ Given, When, Then, And }) => {
    Given("a Schmock instance with route \"GET /api/users\" that reads headers", () => {
      setup();
      mock("GET /api/users", ({ headers }) => [200, { token: headers["x-token"] }]);
    });

    And("fetch is intercepted with a beforeRequest hook that adds a header", () => {
      handle = mock.intercept({
        beforeRequest: (req) => ({
          ...req,
          headers: { ...req.headers, "x-token": "injected" },
        }),
      });
    });

    When("I fetch \"/api/users\"", async () => {
      fetchResponse = await fetch("http://localhost/api/users");
    });

    Then("the response should contain the injected header value", async () => {
      const body = await fetchResponse?.json();
      expect(body).toEqual({ token: "injected" });
    });
  });

  Scenario("beforeResponse hook modifies the response", ({ Given, When, Then, And }) => {
    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      setup();
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted with a beforeResponse hook that adds a header", () => {
      handle = mock.intercept({
        beforeResponse: (res) => ({
          ...res,
          headers: { ...res.headers, "x-mock": "true" },
        }),
      });
    });

    When("I fetch \"/api/users\"", async () => {
      fetchResponse = await fetch("http://localhost/api/users");
    });

    Then("the fetch response should have the injected header", () => {
      expect(fetchResponse?.headers.get("x-mock")).toBe("true");
    });
  });

  Scenario("Double intercept throws an error", ({ Given, When, Then, And }) => {
    let error: Error | undefined;

    Given("a Schmock instance with route \"GET /api/users\" returning users", () => {
      setup();
      mock("GET /api/users", [{ id: 1 }]);
    });

    And("fetch is intercepted", () => {
      handle = mock.intercept();
    });

    When("I try to intercept again", () => {
      try {
        mock.intercept();
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw an error about already intercepting", () => {
      expect(error?.message).toMatch(/already intercepting/i);
    });
  });
});
