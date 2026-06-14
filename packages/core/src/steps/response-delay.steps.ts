import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature("../../features/response-delay.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let elapsed: number;
  let elapsed2: number;

  Scenario("Route delay overrides global delay", ({ Given, And, When, Then }) => {
    Given("a mock with global delay of 200ms", () => {
      mock = schmock({ delay: 200, state: {} });
    });

    And('a route "GET /fast" with delay of 10ms', () => {
      mock("GET /fast", { ok: true }, { delay: 10 });
    });

    And('a route "GET /default" with no delay override', () => {
      mock("GET /default", { ok: true }, {});
    });

    When('I request "GET /fast"', async () => {
      const start = performance.now();
      await mock.handle("GET", "/fast");
      elapsed = performance.now() - start;
    });

    // Upper bound is intentionally generous: it only needs to prove the 10ms
    // route delay was used instead of the 200ms global. A tight bound here
    // flakes under CI load (a single timer can be delayed tens of ms).
    Then("the response took less than 150ms", () => {
      expect(elapsed).toBeLessThan(150);
    });

    When('I request "GET /default" with timing', async () => {
      const start = performance.now();
      await mock.handle("GET", "/default");
      elapsed2 = performance.now() - start;
    });

    Then("that response took at least 150ms", () => {
      expect(elapsed2).toBeGreaterThanOrEqual(150);
    });
  });

  Scenario("Route delay supports random range", ({ Given, And, When, Then }) => {
    Given("a mock with no global delay", () => {
      mock = schmock({ state: {} });
    });

    And('a route "GET /random" with delay range 10 to 30', () => {
      mock("GET /random", { ok: true }, { delay: [10, 30] });
    });

    When('I request "GET /random"', async () => {
      const start = performance.now();
      await mock.handle("GET", "/random");
      elapsed = performance.now() - start;
    });

    Then("the response took at least 8ms", () => {
      expect(elapsed).toBeGreaterThanOrEqual(8);
    });
  });

  Scenario("No route delay inherits global delay", ({ Given, And, When, Then }) => {
    Given("a mock with global delay of 50ms", () => {
      mock = schmock({ delay: 50, state: {} });
    });

    And('a route "GET /items" with no delay override', () => {
      mock("GET /items", { ok: true }, {});
    });

    When('I request "GET /items" with timing', async () => {
      const start = performance.now();
      await mock.handle("GET", "/items");
      elapsed = performance.now() - start;
    });

    Then("that response took at least 40ms", () => {
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });
});
