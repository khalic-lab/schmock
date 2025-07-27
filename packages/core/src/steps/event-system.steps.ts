import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { Schmock } from "../schmock";
import type { SchmockConfig } from "../types";

const feature = await loadFeature('../../features/event-system.feature')

describeFeature(feature, ({ Background, Scenario }) => {
  let schmock: Schmock;
  let eventHandlers: Map<string, Function[]> = new Map();
  let eventFired: Map<string, any[]> = new Map();
  let handlerCallOrder: string[] = [];

  Background(({ Given }) => {
    Given("I have a Schmock instance with routes:", (_, docString: string) => {
      const config: SchmockConfig = JSON.parse(docString);
      schmock = new Schmock(config);
      eventHandlers.clear();
      eventFired.clear();
      handlerCallOrder.length = 0;
    })
  })

  Scenario('Register and trigger request:start event', ({ Given, When, Then, And }) => {
    Given("I register a handler for \"request:start\" event", () => {
      const handler = (data: any) => {
        if (!eventFired.has("request:start")) {
          eventFired.set("request:start", []);
        }
        eventFired.get("request:start")!.push(data);
        handlerCallOrder.push("request:start-handler-1");
      };
      
      if (!eventHandlers.has("request:start")) {
        eventHandlers.set("request:start", []);
      }
      eventHandlers.get("request:start")!.push(handler);
      
      schmock.on("request:start", handler);
    })

    When("I make a GET request to \"/api/users\"", async () => {
      await schmock.get("/api/users");
    })

    Then("the \"request:start\" event should be fired", () => {
      expect(eventFired.has("request:start")).toBe(true);
      expect(eventFired.get("request:start")!.length).toBeGreaterThan(0);
    })

    And("the event data should contain request and route information", () => {
      const requestStartData = eventFired.get("request:start");
      expect(requestStartData).toBeDefined();
      expect(requestStartData![0]).toHaveProperty("request");
      expect(requestStartData![0]).toHaveProperty("route");
    })
  })

  Scenario('Register and trigger request:end event', ({ Given, When, Then, And }) => {
    Given("I register a handler for \"request:end\" event", () => {
      const handler = (data: any) => {
        if (!eventFired.has("request:end")) {
          eventFired.set("request:end", []);
        }
        eventFired.get("request:end")!.push(data);
        handlerCallOrder.push("request:end-handler-1");
      };
      
      if (!eventHandlers.has("request:end")) {
        eventHandlers.set("request:end", []);
      }
      eventHandlers.get("request:end")!.push(handler);
      
      schmock.on("request:end", handler);
    })

    When("I make a GET request to \"/api/users\"", async () => {
      await schmock.get("/api/users");
    })

    Then("the \"request:end\" event should be fired", () => {
      expect(eventFired.has("request:end")).toBe(true);
      expect(eventFired.get("request:end")!.length).toBeGreaterThan(0);
    })

    And("the event data should contain request and response information", () => {
      const requestEndData = eventFired.get("request:end");
      expect(requestEndData).toBeDefined();
      expect(requestEndData![0]).toHaveProperty("request");
      expect(requestEndData![0]).toHaveProperty("response");
    })
  })

  Scenario('Multiple handlers for the same event', ({ Given, When, Then }) => {
    Given("I register two handlers for \"request:start\" event", () => {
      const handler1 = (data: any) => {
        if (!eventFired.has("request:start")) {
          eventFired.set("request:start", []);
        }
        eventFired.get("request:start")!.push({ handler: 1, data });
        handlerCallOrder.push("request:start-handler-1");
      };
      
      const handler2 = (data: any) => {
        if (!eventFired.has("request:start")) {
          eventFired.set("request:start", []);
        }
        eventFired.get("request:start")!.push({ handler: 2, data });
        handlerCallOrder.push("request:start-handler-2");
      };
      
      // Initialize Schmock instance for this scenario
      const config: SchmockConfig = {
        routes: {
          "/api/users": { data: [{ id: 1, name: "John" }] },
          "/api/posts": { data: [{ id: 1, title: "Hello World" }] }
        }
      };
      schmock = new Schmock(config);
      eventHandlers.clear();
      eventFired.clear();
      handlerCallOrder.length = 0;
      
      schmock.on("request:start", handler1);
      schmock.on("request:start", handler2);
    })

    When("I make a GET request to \"/api/users\"", async () => {
      await schmock.get("/api/users");
    })

    Then("both handlers should receive the event in registration order", () => {
      const requestStartData = eventFired.get("request:start");
      expect(requestStartData).toBeDefined();
      expect(requestStartData!.length).toBe(2);
      expect(requestStartData![0]).toHaveProperty("handler", 1);
      expect(requestStartData![1]).toHaveProperty("handler", 2);
    })
  })

  Scenario('Remove event handler', ({ Given, When, Then, And }) => {
    let handlerToRemove: Function;

    Given("I register a handler for \"request:start\" event", () => {
      handlerToRemove = (data: any) => {
        if (!eventFired.has("request:start")) {
          eventFired.set("request:start", []);
        }
        eventFired.get("request:start")!.push(data);
        handlerCallOrder.push("request:start-handler-1");
      };
      
      // Initialize Schmock instance for this scenario
      const config: SchmockConfig = {
        routes: {
          "/api/users": { data: [{ id: 1, name: "John" }] },
          "/api/posts": { data: [{ id: 1, title: "Hello World" }] }
        }
      };
      schmock = new Schmock(config);
      eventHandlers.clear();
      eventFired.clear();
      handlerCallOrder.length = 0;
      
      schmock.on("request:start", handlerToRemove);
    })

    And("I remove the handler from \"request:start\" event", () => {
      schmock.off("request:start", handlerToRemove);
    })

    When("I make a GET request to \"/api/users\"", async () => {
      await schmock.get("/api/users");
    })

    Then("the removed handler should not be called", () => {
      expect(eventFired.has("request:start")).toBe(false);
    })
  })

  Scenario('Plugin registration event', ({ Given, When, Then, And }) => {
    Given("I register a handler for \"plugin:registered\" event", () => {
      const handler = (data: any) => {
        if (!eventFired.has("plugin:registered")) {
          eventFired.set("plugin:registered", []);
        }
        eventFired.get("plugin:registered")!.push(data);
        handlerCallOrder.push("plugin:registered-handler-1");
      };
      
      // Initialize Schmock instance for this scenario
      const config: SchmockConfig = {
        routes: {
          "/api/users": { data: [{ id: 1, name: "John" }] },
          "/api/posts": { data: [{ id: 1, title: "Hello World" }] }
        }
      };
      schmock = new Schmock(config);
      eventHandlers.clear();
      eventFired.clear();
      handlerCallOrder.length = 0;
      
      schmock.on("plugin:registered", handler);
    })

    When("I register a plugin with name \"test-plugin\"", () => {
      const plugin = {
        name: "test-plugin",
        version: "1.0.0"
      };
      schmock.use(plugin);
    })

    Then("the \"plugin:registered\" event should be fired", () => {
      expect(eventFired.has("plugin:registered")).toBe(true);
      expect(eventFired.get("plugin:registered")!.length).toBeGreaterThan(0);
    })

    And("the event data should contain the plugin information", () => {
      const pluginData = eventFired.get("plugin:registered");
      expect(pluginData).toBeDefined();
      expect(pluginData![0]).toHaveProperty("plugin");
      expect(pluginData![0].plugin).toHaveProperty("name", "test-plugin");
    })
  })

  Scenario('Error event handling', ({ Given, When, Then, And }) => {
    Given("I register a handler for \"error\" event", () => {
      const handler = (data: any) => {
        if (!eventFired.has("error")) {
          eventFired.set("error", []);
        }
        eventFired.get("error")!.push(data);
        handlerCallOrder.push("error-handler-1");
      };
      
      // Initialize Schmock instance for this scenario
      const config: SchmockConfig = {
        routes: {
          "/api/users": { data: [{ id: 1, name: "John" }] },
          "/api/posts": { data: [{ id: 1, title: "Hello World" }] }
        }
      };
      schmock = new Schmock(config);
      eventHandlers.clear();
      eventFired.clear();
      handlerCallOrder.length = 0;
      
      schmock.on("error", handler);
    })

    When("an error occurs during request processing", () => {
      schmock.emit("error", { error: new Error("Test error") });
    })

    Then("the \"error\" event should be fired", () => {
      expect(eventFired.has("error")).toBe(true);
      expect(eventFired.get("error")!.length).toBeGreaterThan(0);
    })

    And("the event data should contain the error details", () => {
      const errorData = eventFired.get("error");
      expect(errorData).toBeDefined();
      expect(errorData![0]).toHaveProperty("error");
      expect(errorData![0].error).toBeInstanceOf(Error);
    })
  })

  Scenario('Event handler execution order', ({ Given, When, Then, And }) => {
    Given("I register handlers for \"request:start\" and \"request:end\" events", () => {
      const handler1 = (data: any) => {
        if (!eventFired.has("request:start")) {
          eventFired.set("request:start", []);
        }
        eventFired.get("request:start")!.push(data);
        handlerCallOrder.push("request:start");
      };
      
      const handler2 = (data: any) => {
        if (!eventFired.has("request:end")) {
          eventFired.set("request:end", []);
        }
        eventFired.get("request:end")!.push(data);
        handlerCallOrder.push("request:end");
      };
      
      // Initialize Schmock instance for this scenario
      const config: SchmockConfig = {
        routes: {
          "/api/users": { data: [{ id: 1, name: "John" }] },
          "/api/posts": { data: [{ id: 1, title: "Hello World" }] }
        }
      };
      schmock = new Schmock(config);
      eventHandlers.clear();
      eventFired.clear();
      handlerCallOrder.length = 0;
      
      schmock.on("request:start", handler1);
      schmock.on("request:end", handler2);
    })

    When("I make a GET request to \"/api/users\"", async () => {
      await schmock.get("/api/users");
    })

    Then("\"request:start\" should fire before \"request:end\"", () => {
      const startIndex = handlerCallOrder.indexOf("request:start");
      const endIndex = handlerCallOrder.indexOf("request:end");
      expect(startIndex).toBeLessThan(endIndex);
    })

    And("both events should contain the same request object", () => {
      const requestStartData = eventFired.get("request:start");
      const requestEndData = eventFired.get("request:end");
      
      expect(requestStartData).toBeDefined();
      expect(requestEndData).toBeDefined();
      
      expect(requestStartData![0].request).toEqual(requestEndData![0].request);
    })
  })
})