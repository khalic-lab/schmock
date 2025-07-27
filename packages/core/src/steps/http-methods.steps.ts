import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { Schmock } from "../schmock";
import type { SchmockConfig, SchmockResponse } from "../types";

const feature = await loadFeature('../../features/http-methods.feature')

describeFeature(feature, ({ Background, Scenario }) => {
  let schmock: Schmock;
  let response: SchmockResponse;
  let eventData: Map<string, any[]> = new Map();

  Background(({ Given }) => {
    Given("I have a Schmock instance with routes:", (_, docString: string) => {
      const config: SchmockConfig = JSON.parse(docString);
      schmock = new Schmock(config);
      eventData.clear();
      
      // Set up event listeners
      schmock.on("request:start", (data) => {
        if (!eventData.has("request:start")) {
          eventData.set("request:start", []);
        }
        eventData.get("request:start")!.push(data);
      });
      
      schmock.on("request:end", (data) => {
        if (!eventData.has("request:end")) {
          eventData.set("request:end", []);
        }
        eventData.get("request:end")!.push(data);
      });
    })
  })

  Scenario('POST request creates a new resource', ({ When, Then, And }) => {
    When("I make a POST request to {string} with body:", async (_, path: string, docString: string) => {
      const body = JSON.parse(docString);
      response = await schmock.post(path, body);
    })

    Then("the response status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    })

    And("the response should contain:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    })

    And("the {string} event should be fired with method {string}", (_, event: string, method: string) => {
      const events = eventData.get(event);
      expect(events).toBeDefined();
      expect(events!.length).toBeGreaterThan(0);
      expect(events![0].request.method).toBe(method);
    })

    And("the {string} event should be fired with status {int}", (_, event: string, status: number) => {
      const events = eventData.get(event);
      expect(events).toBeDefined();
      expect(events!.length).toBeGreaterThan(0);
      expect(events![0].response.status).toBe(status);
    })
  })

  Scenario('PUT request updates an existing resource', ({ When, Then, And }) => {
    When("I make a PUT request to {string} with body:", async (_, path: string, docString: string) => {
      const body = JSON.parse(docString);
      response = await schmock.put(path, body);
    })

    Then("the response status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    })

    And("the response should contain:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    })

    And("the {string} event should be fired with method {string}", (_, event: string, method: string) => {
      const events = eventData.get(event);
      expect(events).toBeDefined();
      expect(events!.length).toBeGreaterThan(0);
      expect(events![0].request.method).toBe(method);
    })

    And("the {string} event should be fired with status {int}", (_, event: string, status: number) => {
      const events = eventData.get(event);
      expect(events).toBeDefined();
      expect(events!.length).toBeGreaterThan(0);
      expect(events![0].response.status).toBe(status);
    })
  })

  Scenario('DELETE request removes a resource', ({ When, Then, And }) => {
    When("I make a DELETE request to {string}", async (_, path: string) => {
      response = await schmock.delete(path);
    })

    Then("the response status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    })

    And("the response body should be empty", (_) => {
      expect(response.body).toBeUndefined();
    })

    And("the {string} event should be fired with method {string}", (_, event: string, method: string) => {
      const events = eventData.get(event);
      expect(events).toBeDefined();
      expect(events!.length).toBeGreaterThan(0);
      expect(events![0].request.method).toBe(method);
    })

    And("the {string} event should be fired with status {int}", (_, event: string, status: number) => {
      const events = eventData.get(event);
      expect(events).toBeDefined();
      expect(events!.length).toBeGreaterThan(0);
      expect(events![0].response.status).toBe(status);
    })
  })

  Scenario('PATCH request partially updates a resource', ({ When, Then, And }) => {
    When("I make a PATCH request to {string} with body:", async (_, path: string, docString: string) => {
      const body = JSON.parse(docString);
      response = await schmock.patch(path, body);
    })

    Then("the response status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    })

    And("the response should contain:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    })

    And("the {string} event should be fired with method {string}", (_, event: string, method: string) => {
      const events = eventData.get(event);
      expect(events).toBeDefined();
      expect(events!.length).toBeGreaterThan(0);
      expect(events![0].request.method).toBe(method);
    })

    And("the {string} event should be fired with status {int}", (_, event: string, status: number) => {
      const events = eventData.get(event);
      expect(events).toBeDefined();
      expect(events!.length).toBeGreaterThan(0);
      expect(events![0].response.status).toBe(status);
    })
  })

  Scenario('POST to non-existent endpoint', ({ When, Then, And }) => {
    When("I make a POST request to {string} with body:", async (_, path: string, docString: string) => {
      const body = JSON.parse(docString);
      response = await schmock.post(path, body);
    })

    Then("the response status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    })

    And("the response should contain error {string}", (_, error: string) => {
      expect(response.body).toHaveProperty("error", error);
    })
  })

  Scenario('PUT to non-existent resource', ({ When, Then, And }) => {
    When("I make a PUT request to {string} with body:", async (_, path: string, docString: string) => {
      const body = JSON.parse(docString);
      response = await schmock.put(path, body);
    })

    Then("the response status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    })

    And("the response should contain error {string}", (_, error: string) => {
      expect(response.body).toHaveProperty("error", error);
    })
  })

  Scenario('DELETE non-existent resource', ({ When, Then, And }) => {
    When("I make a DELETE request to {string}", async (_, path: string) => {
      response = await schmock.delete(path);
    })

    Then("the response status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    })

    And("the response should contain error {string}", (_, error: string) => {
      expect(response.body).toHaveProperty("error", error);
    })
  })

  Scenario('Request method is included in request event', ({ Given, When, Then, And }) => {
    let requestEventData: any;

    Given("I register a handler for {string} event", (_, event: string) => {
      schmock.on(event as any, (data) => {
        requestEventData = data;
      });
    })

    When("I make a POST request to {string} with body:", async (_, path: string, docString: string) => {
      const body = JSON.parse(docString);
      await schmock.post(path, body);
    })

    Then("the event data should contain request with method {string}", (_, method: string) => {
      expect(requestEventData).toBeDefined();
      expect(requestEventData.request).toBeDefined();
      expect(requestEventData.request.method).toBe(method);
    })

    And("the event data should contain the request body", (_) => {
      expect(requestEventData.request.body).toBeDefined();
      expect(requestEventData.request.body).toHaveProperty("name", "Test User");
    })
  })
})