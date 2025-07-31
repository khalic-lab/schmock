import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { MockInstance } from "../types";

const feature = await loadFeature("../../features/builder-events.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: MockInstance<any>;
  let response: any;
  const eventData: Map<string, any[]> = new Map();
  const handlers: Map<string, Function> = new Map();
  let callOrder: string[] = [];

  Scenario("Listen to request events", ({ Given, And, When, Then }) => {
    eventData.clear();

    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    And(
      "I register handlers for {string} and {string} events",
      (_, event1: string, event2: string) => {
        [event1, event2].forEach((event) => {
          const handler = (data: any) => {
            if (!eventData.has(event)) {
              eventData.set(event, []);
            }
            eventData.get(event)!.push(data);
          };
          mock.on(event, handler);
        });
      },
    );

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then(
      "the {string} event should be fired with:",
      (_, event: string, docString: string) => {
        const expected = JSON.parse(docString);
        const events = eventData.get(event);
        expect(events).toBeDefined();
        expect(events!.length).toBeGreaterThan(0);
        expect(events![0]).toMatchObject(expected);
      },
    );

    And(
      "the {string} event should be fired with:",
      (_, event: string, docString: string) => {
        const expected = JSON.parse(docString);
        const events = eventData.get(event);
        expect(events).toBeDefined();
        expect(events!.length).toBeGreaterThan(0);
        expect(events![0]).toMatchObject(expected);
      },
    );
  });

  Scenario("Multiple event handlers", ({ Given, And, When, Then }) => {
    callOrder = [];
    handlers.clear();

    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    And(
      "I register handlers {string} and {string} for {string} event in order",
      (_, handler1: string, handler2: string, event: string) => {
        [handler1, handler2].forEach((handlerName) => {
          const handler = () => {
            callOrder.push(handlerName);
          };
          handlers.set(handlerName, handler);
          mock.on(event, handler);
        });
      },
    );

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      await mock.handle(method as any, path);
    });

    Then(
      "handler {string} should be called before handler {string}",
      (_, first: string, second: string) => {
        const firstIndex = callOrder.indexOf(first);
        const secondIndex = callOrder.indexOf(second);
        expect(firstIndex).toBeGreaterThanOrEqual(0);
        expect(secondIndex).toBeGreaterThanOrEqual(0);
        expect(firstIndex).toBeLessThan(secondIndex);
      },
    );
  });

  Scenario("Remove event handler", ({ Given, And, When, Then }) => {
    let handlerCalled = false;
    let handlerToRemove: Function;

    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    And("I register a handler for {string} event", (_, event: string) => {
      handlerToRemove = () => {
        handlerCalled = true;
      };
      mock.on(event, handlerToRemove);
    });

    And("I remove the handler from {string} event", (_, event: string) => {
      mock.off(event, handlerToRemove);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      handlerCalled = false;
      await mock.handle(method as any, path);
    });

    Then("the handler should not be called", () => {
      expect(handlerCalled).toBe(false);
    });
  });

  Scenario("Error event", ({ Given, And, When, Then }) => {
    let errorData: any = null;

    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", `return ${docString}`);
      mock = createMock(schmock).build();
    });

    And("I register a handler for {string} event", (_, event: string) => {
      if (event === "error") {
        mock.on(event, (data) => {
          errorData = data;
        });
      }
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      try {
        await mock.handle(method as any, path);
      } catch (e) {
        // Expected error
      }
    });

    Then(
      "the {string} event should be fired with error {string}",
      (_, event: string, expectedMessage: string) => {
        expect(errorData).toBeDefined();
        expect(errorData.error).toBeDefined();
        expect(errorData.error.message).toBe(expectedMessage);
      },
    );
  });
});
