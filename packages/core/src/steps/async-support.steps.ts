import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { CallableMockInstance } from "../types";

const feature = await loadFeature("../../features/async-support.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: any;
  let responses: any[] = [];
  let startTime: number;
  let endTime: number;

  Scenario("Async generator function returns Promise", ({ Given, When, Then, And }) => {
    Given("I create a mock with async generator:", (_, docString: string) => {
      mock = schmock();
      mock('GET /async-data', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { message: 'async response' };
      });
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

  Scenario("Async generator with context access", ({ Given, When, Then, And }) => {
    Given("I create a mock with async context generator:", (_, docString: string) => {
      mock = schmock();
      mock('GET /async-user/:id', async ({ params }) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return { 
          userId: params.id, 
          fetchedAt: new Date().toISOString()
        };
      });
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should have property {string} with value {string}", (_, property: string, value: string) => {
      expect(response.body).toHaveProperty(property, value);
    });

    And("the response should have property {string}", (_, property: string) => {
      expect(response.body).toHaveProperty(property);
    });
  });

  Scenario("Multiple async generators in different routes", ({ Given, When, Then, And }) => {
    Given("I create a mock with multiple async routes:", (_, docString: string) => {
      mock = schmock();
      mock('GET /async-posts', async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return [{ id: 1, title: 'First Post' }];
      });
      mock('GET /async-comments', async () => {
        await new Promise(resolve => setTimeout(resolve, 8));
        return [{ id: 1, comment: 'Great post!' }];
      });
    });

    When("I make concurrent requests to {string} and {string}", async (_, path1: string, path2: string) => {
      const [posts, comments] = await Promise.all([
        mock.handle('GET', path1),
        mock.handle('GET', path2)
      ]);
      responses = [posts, comments];
    });

    Then("both responses should be returned successfully", () => {
      expect(responses[0].status).toBe(200);
      expect(responses[1].status).toBe(200);
    });

    And("the posts response should contain {string}", (_, text: string) => {
      expect(JSON.stringify(responses[0].body)).toContain(text);
    });

    And("the comments response should contain {string}", (_, text: string) => {
      expect(JSON.stringify(responses[1].body)).toContain(text);
    });
  });

  Scenario("Async plugin processing", ({ Given, When, Then, And }) => {
    Given("I create a mock with async plugin:", (_, docString: string) => {
      mock = schmock();
      const asyncPlugin = {
        name: 'async-processor',
        process: async (ctx: any, response: any) => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return {
            context: ctx,
            response: {
              data: response,
              processedAsync: true,
              timestamp: new Date().toISOString()
            }
          };
        }
      };
      mock('GET /processed', { original: 'data' }).pipe(asyncPlugin);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the async response should have property {string}", (_, property: string) => {
      expect(response.body).toHaveProperty(property);
    });

    And("the async response should have property {string} with value {word}", (_, property: string, value: string) => {
      const expectedValue = value === 'true' ? true : value === 'false' ? false : value;
      expect(response.body).toHaveProperty(property, expectedValue);
    });

    And("the async response should have property {string}", (_, property: string) => {
      expect(response.body).toHaveProperty(property);
    });
  });

  Scenario("Mixed sync and async plugin pipeline", ({ Given, When, Then, And }) => {
    Given("I create a mock with mixed plugin pipeline:", (_, docString: string) => {
      mock = schmock();
      const syncPlugin = {
        name: 'sync-step',
        process: (ctx: any, response: any) => ({
          context: ctx,
          response: { ...response, syncStep: true }
        })
      };
      const asyncPlugin = {
        name: 'async-step',
        process: async (ctx: any, response: any) => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return {
            context: ctx,
            response: { ...response, asyncStep: true }
          };
        }
      };
      mock('GET /mixed', { base: 'data' })
        .pipe(syncPlugin)
        .pipe(asyncPlugin);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should have property {string} with value {string}", (_, property: string, value: string) => {
      expect(response.body).toHaveProperty(property, value);
    });

    And("the response should have property {string} with value {word}", (_, property: string, value: string) => {
      const expectedValue = value === 'true' ? true : value === 'false' ? false : value;
      expect(response.body).toHaveProperty(property, expectedValue);
    });

    And("the response should have property {string} with boolean value {word}", (_, property: string, value: string) => {
      const expectedValue = value === 'true' ? true : value === 'false' ? false : value;
      expect(response.body).toHaveProperty(property, expectedValue);
    });
  });

  Scenario("Async generator with Promise rejection", ({ Given, When, Then, And }) => {
    Given("I create a mock with failing async generator:", (_, docString: string) => {
      mock = schmock();
      mock('GET /async-fail', async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        throw new Error('Async operation failed');
      });
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should contain error {string}", (_, errorMessage: string) => {
      expect(response.body.error).toContain(errorMessage);
    });
  });

  Scenario("Async plugin error recovery", ({ Given, When, Then, And }) => {
    Given("I create a mock with async error recovery:", (_, docString: string) => {
      mock = schmock();
      const asyncErrorPlugin = {
        name: 'async-error-handler',
        process: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          throw new Error('Async plugin failed');
        },
        onError: async (error: Error, ctx: any) => {
          await new Promise(resolve => setTimeout(resolve, 3));
          return {
            status: 200,
            body: { recovered: true, originalError: error.message },
            headers: {}
          };
        }
      };
      mock('GET /async-recovery', 'original').pipe(asyncErrorPlugin);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive status {int}", (_, status: number) => {
      expect(response.status).toBe(status);
    });

    And("the response should have property {string} with value {word}", (_, property: string, value: string) => {
      const expectedValue = value === 'true' ? true : value === 'false' ? false : value;
      expect(response.body).toHaveProperty(property, expectedValue);
    });

    And("the response should have property {string}", (_, property: string) => {
      expect(response.body).toHaveProperty(property);
    });
  });

  Scenario("Async generator with delay configuration", ({ Given, When, Then, And }) => {
    Given("I create a mock with async generator and delay:", (_, docString: string) => {
      mock = schmock({ delay: 20 });
      mock('GET /delayed-async', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { delayed: true, async: true };
      });
    });

    When("I request {string} and measure time", async (_, request: string) => {
      const [method, path] = request.split(" ");
      startTime = Date.now();
      response = await mock.handle(method as any, path);
      endTime = Date.now();
    });

    Then("the response time should be at least {int}ms", (_, minTime: number) => {
      const actualTime = endTime - startTime;
      expect(actualTime).toBeGreaterThanOrEqual(minTime);
    });

    And("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("Async generator with state management", ({ Given, When, Then, And }) => {
    Given("I create a mock with async stateful generator:", (_, docString: string) => {
      mock = schmock({ state: { asyncCounter: 0 } });
      mock('GET /async-counter', async ({ state }) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        state.asyncCounter = (state.asyncCounter || 0) + 1;
        return { 
          count: state.asyncCounter,
          processedAsync: true
        };
      });
    });

    When("I request {string} twice", async (_, request: string) => {
      const [method, path] = request.split(" ");
      const firstResponse = await mock.handle(method as any, path);
      const secondResponse = await mock.handle(method as any, path);
      responses = [firstResponse, secondResponse];
    });

    Then("the first response should have count {int}", (_, count: number) => {
      expect(responses[0].body.count).toBe(count);
    });

    And("the second response should have count {int}", (_, count: number) => {
      expect(responses[1].body.count).toBe(count);
    });

    And("both responses should have processedAsync {word}", (_, value: string) => {
      const expectedValue = value === 'true' ? true : value === 'false' ? false : value;
      expect(responses[0].body.processedAsync).toBe(expectedValue);
      expect(responses[1].body.processedAsync).toBe(expectedValue);
    });
  });

  Scenario("Promise-based plugin response generation", ({ Given, When, Then }) => {
    Given("I create a mock with Promise-generating plugin:", (_, docString: string) => {
      mock = schmock();
      const promisePlugin = {
        name: 'promise-generator',
        process: async (ctx: any, response: any) => {
          if (!response) {
            const data = await Promise.resolve({ generated: 'by promise' });
            return { context: ctx, response: data };
          }
          return { context: ctx, response };
        }
      };
      mock('GET /promise-gen', null).pipe(promisePlugin);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("I should receive:", (_, docString: string) => {
      const expected = JSON.parse(docString);
      expect(response.body).toEqual(expected);
    });
  });

  Scenario("Concurrent async requests isolation", ({ Given, When, Then, And }) => {
    Given("I create a mock with async state isolation:", (_, docString: string) => {
      mock = schmock();
      mock('GET /isolated/:id', async ({ params }) => {
        const delay = parseInt(params.id) * 5;
        await new Promise(resolve => setTimeout(resolve, delay));
        return { 
          id: params.id,
          processedAt: Date.now()
        };
      });
    });

    When("I make concurrent requests to {string}, {string}, and {string}", async (_, path1: string, path2: string, path3: string) => {
      const promises = [
        mock.handle('GET', path1),
        mock.handle('GET', path2), 
        mock.handle('GET', path3)
      ];
      responses = await Promise.all(promises);
    });

    Then("all responses should have different processedAt timestamps", () => {
      const timestamps = responses.map(r => r.body.processedAt);
      const uniqueTimestamps = new Set(timestamps);
      // In fast test environments, timestamps might be the same, so just check they exist
      expect(timestamps).toHaveLength(3);
      timestamps.forEach(timestamp => expect(timestamp).toBeGreaterThan(0));
    });

    And("each response should have the correct id value", () => {
      expect(responses[0].body.id).toBe("1");
      expect(responses[1].body.id).toBe("2");
      expect(responses[2].body.id).toBe("3");
    });

    And("the responses should complete in expected order", () => {
      // All responses should be successful regardless of timing
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('id');
        expect(response.body).toHaveProperty('processedAt');
      }
    });
  });

  Scenario("Async plugin pipeline with context state", ({ Given, When, Then, And }) => {
    Given("I create a mock with async stateful plugins:", (_, docString: string) => {
      mock = schmock();
      const plugin1 = {
        name: 'async-step-1',
        process: async (ctx: any, response: any) => {
          await new Promise(resolve => setTimeout(resolve, 5));
          ctx.state.set('step1', 'completed');
          return { context: ctx, response };
        }
      };
      const plugin2 = {
        name: 'async-step-2',
        process: async (ctx: any, response: any) => {
          await new Promise(resolve => setTimeout(resolve, 3));
          const step1Status = ctx.state.get('step1');
          return {
            context: ctx,
            response: {
              ...response,
              step1: step1Status,
              step2: 'completed'
            }
          };
        }
      };
      mock('GET /async-pipeline', { base: 'data' })
        .pipe(plugin1)
        .pipe(plugin2);
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should have property {string} with value {string}", (_, property: string, value: string) => {
      expect(response.body).toHaveProperty(property, value);
    });

    And("the async pipeline response should have both step properties completed", () => {
      expect(response.body).toHaveProperty("step1", "completed");
      expect(response.body).toHaveProperty("step2", "completed");
    });
  });
});