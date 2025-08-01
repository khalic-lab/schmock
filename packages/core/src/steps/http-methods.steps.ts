import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { CallableMockInstance } from "../types";

const feature = await loadFeature("../../features/http-methods.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: any;
  let responses: any[] = [];
  let error: Error | null = null;

  Scenario("GET method with query parameters", ({ Given, When, Then }) => {
    Given("I create a mock with GET endpoint:", (_, docString: string) => {
      mock = schmock();
      mock('GET /search', ({ query }) => ({
        results: [],
        query: query.q,
        page: parseInt(query.page || '1'),
        limit: parseInt(query.limit || '10')
      }));
    });

    When("I make a GET request to {string}", async (_, path: string) => {
      const [pathname, queryString] = path.split("?");
      const query: Record<string, string> = {};
      if (queryString) {
        queryString.split("&").forEach((param) => {
          const [key, value] = param.split("=");
          query[key] = value;
        });
      }
      response = await mock.handle('GET', pathname, { query });
    });

    Then("I should receive GET method response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("POST method with JSON body", ({ Given, When, Then, And }) => {
    Given("I create a mock with POST endpoint:", (_, docString: string) => {
      mock = schmock();
      mock('POST /users', ({ body }) => [201, {
        id: 123,
        ...body,
        createdAt: '2023-01-01T00:00:00Z'
      }]);
    });

    When("I make a POST request to {string} with JSON body:", async (_, path: string, docString: string) => {
      const body = JSON.parse(docString);
      response = await mock.handle('POST', path, { body });
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("I should receive POST method response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("PUT method for resource updates", ({ Given, When, Then }) => {
    Given("I create a mock with PUT endpoint:", (_, docString: string) => {
      mock = schmock();
      mock('PUT /users/:id', ({ params, body }) => ({
        id: parseInt(params.id),
        ...body,
        updatedAt: '2023-01-01T00:00:00Z'
      }));
    });

    When("I make a PUT request to {string} with JSON body:", async (_, path: string, docString: string) => {
      const body = JSON.parse(docString);
      response = await mock.handle('PUT', path, { body });
    });

    Then("I should receive PUT method response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("DELETE method with confirmation", ({ Given, When, Then, And }) => {
    Given("I create a mock with DELETE endpoint:", (_, docString: string) => {
      mock = schmock();
      mock('DELETE /users/:id', ({ params }) => [204, null]);
    });

    When("I make a DELETE request to {string}", async (_, path: string) => {
      response = await mock.handle('DELETE', path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the DELETE response body should be empty", () => {
      expect(response.body).toBeUndefined();
    });
  });

  Scenario("PATCH method for partial updates", ({ Given, When, Then }) => {
    Given("I create a mock with PATCH endpoint:", (_, docString: string) => {
      mock = schmock();
      mock('PATCH /users/:id', ({ params, body }) => ({
        id: parseInt(params.id),
        email: 'existing@example.com',
        ...body,
        updatedAt: '2023-01-01T00:00:00Z'
      }));
    });

    When("I make a PATCH request to {string} with JSON body:", async (_, path: string, docString: string) => {
      const body = JSON.parse(docString);
      response = await mock.handle('PATCH', path, { body });
    });

    Then("I should receive PATCH method response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("HEAD method returns headers only", ({ Given, When, Then, And }) => {
    Given("I create a mock with HEAD endpoint:", (_, docString: string) => {
      mock = schmock();
      mock('HEAD /users/:id', ({ params }) => [200, null, {
        'Content-Type': 'application/json',
        'Last-Modified': 'Wed, 01 Jan 2023 00:00:00 GMT',
        'Content-Length': '156'
      }]);
    });

    When("I make a HEAD request to {string}", async (_, path: string) => {
      response = await mock.handle('HEAD', path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the HEAD response body should be empty", () => {
      expect(response.body).toBeUndefined();
    });

    And("the HEAD response should have proper headers set", () => {
      expect(response.headers?.['Content-Type']).toBe('application/json');
      expect(response.headers?.['Last-Modified']).toBe('Wed, 01 Jan 2023 00:00:00 GMT');
      expect(response.headers?.['Content-Length']).toBe('156');
    });
  });

  Scenario("OPTIONS method for CORS preflight", ({ Given, When, Then, And }) => {
    Given("I create a mock with OPTIONS endpoint:", (_, docString: string) => {
      mock = schmock();
      mock('OPTIONS /api/users', () => [200, null, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }]);
    });

    When("I make an OPTIONS request to {string}", async (_, path: string) => {
      response = await mock.handle('OPTIONS', path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the OPTIONS response body should be empty", () => {
      expect(response.body).toBeUndefined();
    });

    And("the OPTIONS response should have header {string} with value {string}", (_, headerName: string, headerValue: string) => {
      expect(response.headers?.[headerName]).toBe(headerValue);
    });
  });

  Scenario("Multiple methods on same path", ({ Given, When, Then, And }) => {
    Given("I create a mock with multiple methods on same path:", (_, docString: string) => {
      mock = schmock();
      mock('GET /resource', { action: 'read' });
      mock('POST /resource', { action: 'create' });
      mock('PUT /resource', { action: 'update' });
      mock('DELETE /resource', { action: 'delete' });
    });

    When("I test all methods on {string}", async (_, path: string) => {
      responses = [];
      responses.push(await mock.handle('GET', path));
      responses.push(await mock.handle('POST', path));
      responses.push(await mock.handle('PUT', path));
      responses.push(await mock.handle('DELETE', path));
    });

    Then("the GET method should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[0].body).toEqual(expected);
    });

    And("the POST method should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[1].body).toEqual(expected);
    });

    And("the PUT method should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[2].body).toEqual(expected);
    });

    And("the DELETE method should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[3].body).toEqual(expected);
    });
  });

  Scenario("Method-specific content types", ({ Given, When, Then, And }) => {
    Given("I create a mock with method-specific content types:", (_, docString: string) => {
      mock = schmock();
      mock('GET /data.json', { data: 'json' });
      mock('GET /data.xml', '<data>xml</data>', { contentType: 'application/xml' });
      mock('GET /data.txt', 'plain text data');
      mock('POST /upload', 'File uploaded successfully', { contentType: 'text/plain' });
    });

    When("I test method-specific content types", async () => {
      responses = [];
      responses.push(await mock.handle('GET', '/data.json'));
      responses.push(await mock.handle('GET', '/data.xml'));
      responses.push(await mock.handle('GET', '/data.txt'));
      responses.push(await mock.handle('POST', '/upload'));
    });

    Then("the JSON endpoint should have content-type {string}", (_, contentType: string) => {
      expect(responses[0].headers?.["content-type"]).toBe(contentType);
    });

    And("the XML endpoint should have content-type {string}", (_, contentType: string) => {
      expect(responses[1].headers?.["content-type"]).toBe(contentType);
    });

    And("the text endpoint should have content-type {string}", (_, contentType: string) => {
      expect(responses[2].headers?.["content-type"]).toBe(contentType);
    });

    And("the upload endpoint should have content-type {string}", (_, contentType: string) => {
      expect(responses[3].headers?.["content-type"]).toBe(contentType);
    });
  });

  Scenario("Method case sensitivity", ({ Given, When, Then }) => {
    error = null;

    Given("I create a mock with lowercase method:", (_, docString: string) => {
      mock = schmock();
    });

    When("I attempt to create a mock with lowercase method", () => {
      error = null;
      try {
        mock('get /test', { method: 'get' });
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw RouteParseError for invalid method case", () => {
      expect(error).not.toBeNull();
      expect(error!.constructor.name).toBe('RouteParseError');
      expect(error!.message).toContain('Invalid route key format');
    });
  });

  Scenario("Unsupported HTTP methods", ({ Given, When, Then }) => {
    error = null;

    Given("I create a mock with custom method:", (_, docString: string) => {
      mock = schmock();
    });

    When("I attempt to create a mock with unsupported method", () => {
      error = null;
      try {
        mock('CUSTOM /endpoint', { custom: true });
      } catch (e) {
        error = e as Error;
      }
    });

    Then("it should throw RouteParseError for unsupported method", () => {
      expect(error).not.toBeNull();
      expect(error!.constructor.name).toBe('RouteParseError');
      expect(error!.message).toContain('Invalid route key format');
    });
  });

  Scenario("Method with special characters in path", ({ Given, When, Then }) => {
    Given("I create a mock with special characters:", (_, docString: string) => {
      mock = schmock();
      mock('GET /api/v1/users/:id/posts/:post-id', ({ params }) => ({
        userId: params.id,
        postId: params['post-id']
      }));
    });

    When("I make a GET request to {string}", async (_, path: string) => {
      response = await mock.handle('GET', path);
    });

    Then("I should receive special characters response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("Method with request headers validation", ({ Given, When, Then, And }) => {
    Given("I create a mock with header validation:", (_, docString: string) => {
      mock = schmock();
      mock('POST /secure', ({ headers, body }) => {
        if (headers.authorization !== 'Bearer valid-token') {
          return [401, { error: 'Unauthorized' }];
        }
        return [200, { message: 'Success', data: body }];
      });
    });

    When("I make a POST request with valid headers", async () => {
      response = await mock.handle('POST', '/secure', {
        headers: { authorization: 'Bearer valid-token' },
        body: { test: true }
      });
    });

    Then("I should receive authorized response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });

    When("I make a POST request with invalid headers", async () => {
      response = await mock.handle('POST', '/secure', {
        headers: { authorization: 'Bearer invalid-token' },
        body: { test: true }
      });
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("I should receive unauthorized response:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("Method chaining with plugins", ({ Given, When, Then, And }) => {
    Given("I create a mock with method-specific plugins:", (_, docString: string) => {
      mock = schmock();
      const loggerPlugin = {
        name: 'method-logger',
        process: (ctx: any, response: any) => ({
          context: ctx,
          response: {
            ...response,
            method: ctx.method,
            logged: true
          }
        })
      };
      mock('GET /logged', { data: 'get' }).pipe(loggerPlugin);
      mock('POST /logged', { data: 'post' }).pipe(loggerPlugin);
    });

    When("I test method chaining with plugins", async () => {
      responses = [];
      responses.push(await mock.handle('GET', '/logged'));
      responses.push(await mock.handle('POST', '/logged'));
    });

    Then("the GET with plugin should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[0].body).toEqual(expected);
    });

    And("the POST with plugin should return:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(responses[1].body).toEqual(expected);
    });
  });
});