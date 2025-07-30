import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import { schemaPlugin } from "@schmock/schema";
import type { MockInstance } from "../types";

const feature = await loadFeature("../../features/schema-generation.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: MockInstance<any>;
  let response: any;
  let responses: any[] = [];

  Scenario("Basic object generation from JSON schema", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", "schemaPlugin", `return ${docString}`);
      mock = createMock(schmock, schemaPlugin).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should have:", () => {
      // Check basic object structure
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('name');
      expect(response.body).toHaveProperty('email');
      
      // Check types
      expect(typeof response.body.id).toBe('number');
      expect(typeof response.body.name).toBe('string');
      expect(typeof response.body.email).toBe('string');
      
      // Check email format
      expect(response.body.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    });
  });

  Scenario("Array generation with automatic count detection", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", "schemaPlugin", `return ${docString}`);
      mock = createMock(schmock, schemaPlugin).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should be an array with {int}-{int} items", (_, min: number, max: number) => {
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(min);
      expect(response.body.length).toBeLessThanOrEqual(max);
    });

    And("each item should have:", () => {
      for (const item of response.body) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('name');
        expect(typeof item.id).toBe('number');
        expect(typeof item.name).toBe('string');
      }
    });
  });

  Scenario("Smart field name inference", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", "schemaPlugin", `return ${docString}`);
      mock = createMock(schmock, schemaPlugin).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should contain realistic data:", () => {
      expect(response.body).toHaveProperty('firstName');
      expect(response.body).toHaveProperty('lastName');
      expect(response.body).toHaveProperty('phoneNumber');
      expect(response.body).toHaveProperty('createdAt');
      expect(response.body).toHaveProperty('uuid');
      
      expect(typeof response.body.firstName).toBe('string');
      expect(response.body.firstName.length).toBeGreaterThan(0);
      
      expect(typeof response.body.lastName).toBe('string');
      expect(response.body.lastName.length).toBeGreaterThan(0);
      
      expect(typeof response.body.createdAt).toBe('string');
      expect(() => new Date(response.body.createdAt)).not.toThrow();
      
      expect(typeof response.body.uuid).toBe('string');
      expect(response.body.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  Scenario("Override specific fields", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", "schemaPlugin", `return ${docString}`);
      mock = createMock(schmock, schemaPlugin).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should have:", () => {
      expect(response.body.role).toBe('admin');
      expect(response.body.email).toBe('admin@company.com');
    });

    And("the id should be a generated integer", () => {
      expect(typeof response.body.id).toBe('number');
      expect(Number.isInteger(response.body.id)).toBe(true);
    });
  });

  Scenario("Template-based overrides with state integration", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", "schemaPlugin", `return ${docString}`);
      mock = createMock(schmock, schemaPlugin).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should be an array with {int} items", (_, count: number) => {
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(count);
    });

    And("each item should have authorId as {int}", (_, authorId: number) => {
      for (const item of response.body) {
        expect(item.authorId).toBe(authorId);
      }
    });
  });

  Scenario("Array count override", ({ Given, When, Then }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", "schemaPlugin", `return ${docString}`);
      mock = createMock(schmock, schemaPlugin).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should be an array with exactly {int} items", (_, count: number) => {
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(count);
    });
  });

  Scenario("Integration with existing response function", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", "schemaPlugin", `return ${docString}`);
      mock = createMock(schmock, schemaPlugin).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should have generated user data", () => {
      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('name');
      expect(response.body.user).toHaveProperty('email');
      expect(typeof response.body.user.name).toBe('string');
      expect(typeof response.body.user.email).toBe('string');
    });

    And("the response should have customField as {string}", (_, value: string) => {
      expect(response.body.customField).toBe(value);
    });
  });

  Scenario("Error handling for invalid schema", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", "schemaPlugin", `return ${docString}`);
      mock = createMock(schmock, schemaPlugin).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the status should be {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error information", () => {
      expect(response.body).toHaveProperty('error');
    });
  });

  Scenario("Nested object generation", ({ Given, When, Then, And }) => {
    Given("I create a mock with:", (_, docString: string) => {
      const createMock = new Function("schmock", "schemaPlugin", `return ${docString}`);
      mock = createMock(schmock, schemaPlugin).build();
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should have nested address object", () => {
      expect(response.body).toHaveProperty('address');
      expect(typeof response.body.address).toBe('object');
      expect(response.body.address).toHaveProperty('street');
      expect(response.body.address).toHaveProperty('city');
      expect(response.body.address).toHaveProperty('zipCode');
    });

    And("the response should have employees array with up to {int} items", (_, maxItems: number) => {
      expect(response.body).toHaveProperty('employees');
      expect(Array.isArray(response.body.employees)).toBe(true);
      expect(response.body.employees.length).toBeLessThanOrEqual(maxItems);
      
      for (const employee of response.body.employees) {
        expect(employee).toHaveProperty('name');
        expect(employee).toHaveProperty('position');
      }
    });
  });
});