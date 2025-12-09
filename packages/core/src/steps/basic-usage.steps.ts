import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { CallableMockInstance } from "../types";

const feature = await loadFeature("../../features/basic-usage.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: any;

  Scenario("Simplest possible mock - plain text", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /', 'Hello World');
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive text {string}", (_, expectedText: string) => {
      expect(response.body).toBe(expectedText);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("Return JSON without specifying contentType", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /users', [{ id: 1, name: 'John' }]);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("Return object without contentType", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /user', { id: 1, name: 'John' });
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("Empty mock instance", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });
  });

  Scenario("Null response", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /null', null);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive empty response", () => {
      expect(response.body).toBeUndefined();
    });

    And("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });
  });

  Scenario("Undefined response", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /undefined', undefined);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive empty response", () => {
      expect(response.body).toBeUndefined();
    });

    And("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });
  });

  Scenario("Empty string response", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /empty', '');
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive text {string}", (_, expectedText: string) => {
      expect(response.body).toBe(expectedText);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("Number response", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /count', 42);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive text {string}", (_, expectedText: string) => {
      expect(response.body).toBe(expectedText);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("Boolean response", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /active', true);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive text {string}", (_, expectedText: string) => {
      expect(response.body).toBe(expectedText);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("Function returning string", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /dynamic', () => 'Dynamic response');
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive text {string}", (_, expectedText: string) => {
      expect(response.body).toBe(expectedText);
    });
  });

  Scenario("Function returning object", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /dynamic-json', () => ({ timestamp: Date.now() }));
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should be valid JSON", () => {
      expect(() => JSON.parse(JSON.stringify(response.body))).not.toThrow();
    });

    And("the response should have property {string}", (_, property: string) => {
      expect(response.body).toHaveProperty(property);
    });
  });

  Scenario("Multiple routes", ({ Given, When, Then, And }) => {
    let homeResponse: any;
    let aboutResponse: any;
    let contactResponse: any;

    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /', 'Home');
      mock('GET /about', 'About Us');
      mock('GET /contact', { email: 'test@example.com' });
    });

    When("I make three requests to different routes", async () => {
      homeResponse = await mock.handle('GET', '/');
      aboutResponse = await mock.handle('GET', '/about');
      contactResponse = await mock.handle('GET', '/contact');
    });

    Then("the home route should return {string}", (_, expectedText: string) => {
      expect(homeResponse.body).toBe(expectedText);
    });

    And("the about route should return {string}", (_, expectedText: string) => {
      expect(aboutResponse.body).toBe(expectedText);
    });

    And("the contact route should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(contactResponse.body).toEqual(expected);
    });
  });

  Scenario("Override contentType detection", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /data', { foo: 'bar' }, { contentType: 'text/plain' });
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive text {string}", (_, expectedText: string) => {
      expect(response.body).toBe(expectedText);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("HTML response", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /page', '<h1>Hello</h1>', { contentType: 'text/html' });
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive text {string}", (_, expectedText: string) => {
      expect(response.body).toBe(expectedText);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("Binary/buffer response detection", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      mock = schmock();
      mock('GET /binary', Buffer.from('binary data'));
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive buffer data", () => {
      expect(Buffer.isBuffer(response.body)).toBe(true);
    });

    And("the content-type should be {string}", (_, contentType: string) => {
      expect(response.headers?.["content-type"]).toBe(contentType);
    });
  });
});