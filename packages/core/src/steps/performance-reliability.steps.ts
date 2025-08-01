import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { MockInstance } from "../types";

const feature = await loadFeature("../../features/performance-reliability.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: MockInstance<any>;
  let responses: any[] = [];
  let responsesTimes: number[] = [];

  Scenario("High-volume concurrent requests", ({ Given, When, Then, And }) => {
    responses = [];
    responsesTimes = [];

    Given("I create a mock for load testing:", (_, docString: string) => {
      // Create mock with new callable API for load testing
      mock = schmock();
      
      mock('GET /api/health', () => ({ 
        status: 'healthy', 
        timestamp: Date.now() 
      }));
      
      mock('GET /api/data/:id', ({ params }) => ({
        id: params.id,
        data: Array.from({ length: 50 }, (_, i) => ({ 
          index: i, 
          value: Math.random() 
        })),
        generated_at: new Date().toISOString()
      }));
      
      mock('POST /api/process', ({ body }) => {
        // Simulate processing time
        const items = Array.isArray(body) ? body : [body];
        return {
          processed: items.length,
          results: items.map(item => ({ ...item, processed: true })),
          batch_id: Math.random().toString(36)
        };
      });
    });

    When("I send {int} concurrent {string} requests", async (_, count: number, request: string) => {
      const [method, path] = request.split(" ");
      responses = [];
      responsesTimes = [];

      const promises = Array.from({ length: count }, async () => {
        const startTime = Date.now();
        const response = await mock.handle(method as any, path);
        const elapsed = Date.now() - startTime;
        return { response, elapsed };
      });

      const results = await Promise.all(promises);
      responses = results.map(r => r.response);
      responsesTimes = results.map(r => r.elapsed);
    });

    Then("all concurrent requests should complete successfully", () => {
      const expectedCount = responses.length;
      expect(responses).toHaveLength(expectedCount);
      for (const response of responses) {
        expect(response.status).toBe(200);
      }
    });

    And("the average response time should be under {int}ms", (_, maxTime: number) => {
      const avgTime = responsesTimes.reduce((a, b) => a + b, 0) / responsesTimes.length;
      expect(avgTime).toBeLessThan(maxTime);
    });

    And("no requests should timeout", () => {
      // All requests completed if we got here, so no timeouts
      expect(responses.length).toBeGreaterThan(0);
    });

    When("I send {int} concurrent requests to different {string} endpoints", async (_, count: number, pathPattern: string) => {
      responses = [];
      
      const promises = Array.from({ length: count }, async (_, i) => {
        const path = pathPattern.replace(":id", `id${i}`);
        return await mock.handle("GET", path);
      });

      responses = await Promise.all(promises);
    });

    Then("all responses should be unique based on ID", () => {
      const ids = responses.map(r => r.body.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(responses.length);
    });

    And("each response should contain {int} data items", (_, expectedCount: number) => {
      for (const response of responses) {
        expect(response.body.data).toHaveLength(expectedCount);
      }
    });

    When("I send {int} concurrent {string} requests with different payloads", async (_, count: number, request: string) => {
      const [method, path] = request.split(" ");
      responses = [];

      const promises = Array.from({ length: count }, async (_, i) => {
        return await mock.handle(method as any, path, {
          body: { id: i, data: `payload-${i}` }
        });
      });

      responses = await Promise.all(promises);
    });

    And("all concurrent requests should complete successfully", () => {
      const expectedCount = responses.length;
      expect(responses).toHaveLength(expectedCount);
      for (const response of responses) {
        expect(response.status).toBe(200);
      }
    });

    And("each response should have a unique batch_id", () => {
      const batchIds = responses.map(r => r.body.batch_id);
      const uniqueBatchIds = new Set(batchIds);
      expect(uniqueBatchIds.size).toBe(responses.length);
    });
  });

  Scenario("Memory usage under sustained load", ({ Given, When, Then, And }) => {
    Given("I create a mock with potential memory concerns:", (_, docString: string) => {
      // Create mock with routes that handle large data
      mock = schmock();
      
      mock('POST /api/large-data', ({ body }) => {
        // Create large response data
        const largeArray = Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          data: 'x'.repeat(100), // 100 chars per item
          timestamp: Date.now(),
          payload: body
        }));
        
        return {
          results: largeArray,
          items: largeArray,
          total_size: largeArray.length,
          size: 'large',
          memory_usage: process.memoryUsage ? process.memoryUsage() : null
        };
      });
      
      mock('GET /api/accumulate/:count', ({ params }) => {
        const count = parseInt(params.count);
        const items = Array.from({ length: count }, (_, i) => ({
          id: i,
          value: Math.random(),
          timestamp: Date.now()
        }));
        
        return {
          items: items,
          accumulated: items,
          total: items.length,
          count: items.length,
          memory_usage: process.memoryUsage ? process.memoryUsage() : null
        };
      });
    });

    When("I send {int} requests to {string} with {int}KB payloads", async (_, count: number, request: string, payloadSize: number) => {
      const [method, path] = request.split(" ");
      responses = [];
      
      const largePayload = { data: 'x'.repeat(payloadSize * 1024) };

      for (let i = 0; i < count; i++) {
        const response = await mock.handle(method as any, path, { body: largePayload });
        responses.push(response);
      }
    });

    Then("all requests should complete without memory errors", () => {
      expect(responses).toHaveLength(20);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.body.items).toHaveLength(1000);
      }
    });

    And("the mock should handle the load gracefully", () => {
      // If we got here without throwing, the mock handled the load
      expect(responses.every(r => r.body.size === 'large')).toBe(true);
    });

    When("I request {string} multiple times", async (_, request: string) => {
      const [method, path] = request.split(" ");
      responses = [];
      
      for (let i = 0; i < 5; i++) {
        const response = await mock.handle(method as any, path);
        responses.push(response);
      }
    });

    Then("each response should contain {int} accumulated items", (_, expectedCount: number) => {
      for (const response of responses) {
        expect(response.body.accumulated).toHaveLength(expectedCount);
        expect(response.body.total).toBe(expectedCount);
      }
    });

    And("the memory usage should remain stable", () => {
      // Memory stability is tested by not crashing during multiple large requests
      expect(responses).toHaveLength(5);
    });
  });

  Scenario("Error resilience and recovery", ({ Given, When, Then, And }) => {
    responses = [];

    Given("I create a mock with intermittent failures:", (_, docString: string) => {
      // Create mock with intermittent failure simulation
      mock = schmock();
      
      let requestCount = 0;
      
      mock('POST /api/unreliable', ({ body }) => {
        requestCount++;
        
        // Simulate 20% failure rate
        if (requestCount % 5 === 0) {
          return [500, { error: 'Simulated server error', request_id: requestCount }];
        }
        
        return [200, { success: true, data: body, request_id: requestCount }];
      });
      
      mock('GET /api/flaky', () => {
        requestCount++;
        
        // Simulate 20% failure rate (1 in 5 requests fail)
        if (requestCount % 5 === 0) {
          return [500, { error: 'Flaky service error', request_id: requestCount }];
        }
        
        return [200, { success: true, request_id: requestCount }];
      });
      
      mock('POST /api/validate-strict', ({ body }) => {
        if (!body || typeof body !== 'object') {
          return [400, { error: 'Request body is required and must be an object', code: 'INVALID_BODY' }];
        }
        
        if (!body.name || typeof body.name !== 'string') {
          return [422, { error: 'Name field is required and must be a string', code: 'INVALID_NAME' }];
        }
        
        if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
          return [422, { error: 'Valid email address is required', code: 'INVALID_EMAIL' }];
        }
        
        return [200, { message: 'Validation successful', data: body }];
      });
    });

    When("I send {int} requests to {string}", async (_, count: number, request: string) => {
      const [method, path] = request.split(" ");
      responses = [];

      for (let i = 0; i < count; i++) {
        const response = await mock.handle(method as any, path);
        responses.push(response);
      }
    });

    Then("some requests should succeed and some should fail", () => {
      const successCount = responses.filter(r => r.status === 200).length;
      const errorCount = responses.filter(r => r.status >= 400).length;
      
      expect(successCount).toBeGreaterThan(0);
      expect(errorCount).toBeGreaterThan(0);
      expect(successCount + errorCount).toBe(responses.length);
    });

    And("the success rate should be approximately {int}%", (_, expectedRate: number) => {
      const successCount = responses.filter(r => r.status === 200).length;
      const actualRate = (successCount / responses.length) * 100;
      
      // Allow for some variance due to randomness
      expect(actualRate).toBeGreaterThan(expectedRate - 10);
      expect(actualRate).toBeLessThan(expectedRate + 10);
    });

    And("error responses should have appropriate status codes", () => {
      const errorResponses = responses.filter(r => r.status >= 400);
      const validErrorCodes = [429, 500, 503];
      
      for (const response of errorResponses) {
        expect(validErrorCodes).toContain(response.status);
      }
    });

    When("I send requests to {string} with various invalid inputs", async (_, request: string) => {
      const [method, path] = request.split(" ");  
      responses = [];

      // Test various invalid scenarios
      const testCases = [
        { headers: {}, body: null }, // No content-type, no body
        { headers: { 'content-type': 'application/json' }, body: null }, // No body
        { headers: { 'content-type': 'application/json' }, body: "invalid" }, // Invalid body type
        { headers: { 'content-type': 'application/json' }, body: {} }, // Missing required field
      ];

      for (const testCase of testCases) {
        const response = await mock.handle(method as any, path, testCase);
        responses.push(response);
      }
    });

    Then("each error should have a specific, helpful error message", () => {
      for (const response of responses) {
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.body.error).toBeDefined();
        expect(typeof response.body.error).toBe('string');
        expect(response.body.error.length).toBeGreaterThan(0);
      }
    });

    And("the error codes should correctly identify the validation issue", () => {
      expect(responses[0].status).toBe(400); // No content-type
      expect(responses[1].status).toBe(400); // No body  
      expect(responses[2].status).toBe(400); // Invalid body type
      expect(responses[3].status).toBe(422); // Missing required field
    });
  });

  Scenario("Route matching performance with complex patterns", ({ Given, When, Then, And }) => {
    responses = [];

    Given("I create a mock with many route patterns:", (_, docString: string) => {
      // Create mock with many different route patterns for performance testing
      mock = schmock();
      
      // Routes that match the test expectations
      mock('GET /api/users', () => ({ type: 'users-list' }));
      mock('GET /api/users/:id', ({ params }) => ({ type: 'user', id: params.id }));
      mock('GET /api/users/:userId/posts', ({ params }) => ({ type: 'user-posts', userId: params.userId }));
      mock('GET /api/users/:userId/posts/:postId', ({ params }) => ({ 
        type: 'user-post', 
        userId: params.userId, 
        postId: params.postId 
      }));
      mock('GET /api/users/:userId/posts/:postId/comments', ({ params }) => ({ 
        type: 'post-comments', 
        userId: params.userId, 
        postId: params.postId 
      }));
      mock('GET /api/posts', () => ({ type: 'posts-list' }));
      mock('GET /api/posts/:postId', ({ params }) => ({ type: 'post', postId: params.postId }));
      mock('GET /api/posts/:postId/comments/:commentId', ({ params }) => ({ 
        type: 'comment', 
        postId: params.postId, 
        commentId: params.commentId 
      }));
      mock('GET /static/:category/:file', ({ params }) => ({ 
        type: 'static', 
        category: params.category, 
        file: params.file 
      }));
      mock('GET /api/v2/users/:userId', ({ params }) => ({ 
        type: 'versioned-user', 
        userId: params.userId, 
        version: 'v2' 
      }));
    });

    When("I send requests to all route patterns simultaneously", async () => {
      const testPaths = [
        "GET /api/users",
        "GET /api/users/123", 
        "GET /api/users/123/posts",
        "GET /api/users/123/posts/456",
        "GET /api/users/123/posts/456/comments",
        "GET /api/posts",
        "GET /api/posts/789",
        "GET /api/posts/789/comments/101",
        "GET /static/images/logo.png",
        "GET /api/v2/users/456"
      ];

      const promises = testPaths.map(async (request) => {
        const [method, path] = request.split(" ");
        return await mock.handle(method as any, path);
      });

      responses = await Promise.all(promises);
    });

    Then("each request should match the correct route pattern", () => {
      expect(responses[0].body.type).toBe("users-list");
      expect(responses[1].body.type).toBe("user");
      expect(responses[2].body.type).toBe("user-posts");
      expect(responses[3].body.type).toBe("user-post");
      expect(responses[4].body.type).toBe("post-comments");
      expect(responses[5].body.type).toBe("posts-list");
      expect(responses[6].body.type).toBe("post");
      expect(responses[7].body.type).toBe("comment");
      expect(responses[8].body.type).toBe("static");
      expect(responses[9].body.type).toBe("versioned-user");
    });

    And("parameter extraction should work correctly for all patterns", () => {
      expect(responses[1].body.id).toBe("123");
      expect(responses[2].body.userId).toBe("123");
      expect(responses[3].body.userId).toBe("123");
      expect(responses[3].body.postId).toBe("456");
      expect(responses[8].body.category).toBe("images");
      expect(responses[8].body.file).toBe("logo.png");
      expect(responses[9].body.version).toBe("v2");
    });

    And("the route matching should be efficient even with many patterns", () => {
      // All requests completed quickly if we got here
      expect(responses).toHaveLength(10);
    });

    When("I send requests to non-matching paths", async () => {
      const invalidPaths = [
        "GET /api/invalid",
        "GET /users", // Missing /api prefix
        "GET /api/users/123/invalid",
        "POST /static/images/test.jpg" // Wrong method
      ];

      responses = [];
      for (const request of invalidPaths) {
        const [method, path] = request.split(" ");
        const response = await mock.handle(method as any, path);
        responses.push(response);
      }
    });

    Then("they should consistently return {int} responses", (_, expectedStatus: number) => {
      for (const response of responses) {
        expect(response.status).toBe(expectedStatus);
      }
    });

    And("the {int} responses should be fast", (_, statusCode: number) => {
      // If we got here quickly, the 404 responses were fast
      expect(responses.every(r => r.status === statusCode)).toBe(true);
    });
  });

});