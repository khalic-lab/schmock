import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";

const feature = await loadFeature("../../features/lifecycle-events.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let events: Array<{ type: string; data: unknown }>;
  let removedFired: boolean;

  function collectEvent(type: string) {
    return (data: unknown) => {
      events.push({ type, data });
    };
  }

  Scenario("Events fire at correct times", ({ Given, And, When, Then }) => {
    Given('a mock with a route "GET /items"', () => {
      mock = schmock({ state: {} });
      mock("GET /items", [{ id: 1 }], {});
    });

    And("I register listeners for all events", () => {
      events = [];
      mock.on("request:start", collectEvent("request:start"));
      mock.on("request:match", collectEvent("request:match"));
      mock.on("request:notfound", collectEvent("request:notfound"));
      mock.on("request:end", collectEvent("request:end"));
    });

    When('I request "GET /items"', async () => {
      await mock.handle("GET", "/items");
    });

    Then('the "request:start" event fired', () => {
      expect(events.some((e) => e.type === "request:start")).toBe(true);
    });

    And('the "request:match" event fired with routePath "/items"', () => {
      const match = events.find((e) => e.type === "request:match");
      expect(match).toBeDefined();
      const data = match?.data as Record<string, unknown>;
      expect(data.routePath).toBe("/items");
    });

    And('the "request:end" event fired with status 200', () => {
      const end = events.find((e) => e.type === "request:end");
      expect(end).toBeDefined();
      const data = end?.data as Record<string, unknown>;
      expect(data.status).toBe(200);
    });
  });

  Scenario("Not found event fires for unmatched routes", ({ Given, And, When, Then }) => {
    Given('a mock with a route "GET /items"', () => {
      mock = schmock({ state: {} });
      mock("GET /items", [{ id: 1 }], {});
    });

    And("I register listeners for all events", () => {
      events = [];
      mock.on("request:start", collectEvent("request:start"));
      mock.on("request:match", collectEvent("request:match"));
      mock.on("request:notfound", collectEvent("request:notfound"));
      mock.on("request:end", collectEvent("request:end"));
    });

    When('I request "GET /missing"', async () => {
      await mock.handle("GET", "/missing");
    });

    Then('the "request:start" event fired', () => {
      expect(events.some((e) => e.type === "request:start")).toBe(true);
    });

    And('the "request:notfound" event fired', () => {
      expect(events.some((e) => e.type === "request:notfound")).toBe(true);
    });

    And('the "request:end" event fired with status 404', () => {
      const end = events.find((e) => e.type === "request:end");
      expect(end).toBeDefined();
      const data = end?.data as Record<string, unknown>;
      expect(data.status).toBe(404);
    });
  });

  Scenario("Off removes listener", ({ Given, And, When, Then }) => {
    Given('a mock with a route "GET /items"', () => {
      mock = schmock({ state: {} });
      mock("GET /items", [{ id: 1 }], {});
    });

    And("I register and remove a listener", () => {
      removedFired = false;
      const listener = () => {
        removedFired = true;
      };
      mock.on("request:start", listener);
      mock.off("request:start", listener);
    });

    When('I request "GET /items"', async () => {
      await mock.handle("GET", "/items");
    });

    Then("the removed listener did not fire", () => {
      expect(removedFired).toBe(false);
    });
  });

  Scenario("Reset clears all listeners", ({ Given, And, When, Then }) => {
    Given('a mock with a route "GET /items"', () => {
      mock = schmock({ state: {} });
      mock("GET /items", [{ id: 1 }], {});
    });

    And("I register listeners for all events", () => {
      events = [];
      mock.on("request:start", collectEvent("request:start"));
      mock.on("request:end", collectEvent("request:end"));
    });

    When("I reset the mock", () => {
      mock.reset();
      events = [];
    });

    And('I add a route "GET /items" again', () => {
      mock("GET /items", [{ id: 1 }], {});
    });

    And('I request "GET /items" after reset', async () => {
      await mock.handle("GET", "/items");
    });

    Then("no events were collected after reset", () => {
      expect(events).toHaveLength(0);
    });
  });
});
