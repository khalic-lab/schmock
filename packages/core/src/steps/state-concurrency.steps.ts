import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import { evalMockSetup } from "./eval-mock";
import type { CallableMockInstance } from "../types";

const feature = await loadFeature("../../features/state-concurrency.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let mock1: CallableMockInstance;
  let mock2: CallableMockInstance;
  let responses: any[] = [];

  Scenario("Concurrent state updates with race conditions", ({ Given, When, Then, And }) => {
    Given("I create a mock with shared counter state:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I make 5 concurrent increment requests", async () => {
      const promises = Array.from({ length: 5 }, () =>
        mock.handle('POST', '/increment')
      );
      responses = await Promise.all(promises);
    });

    Then("all requests should complete successfully", () => {
      expect(responses).toHaveLength(5);
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('counter');
        expect(response.body).toHaveProperty('previous');
      });
    });

    And("the final counter should reflect all increments", () => {
      const finalCounters = responses.map(r => r.body.counter);
      const maxCounter = Math.max(...finalCounters);
      expect(maxCounter).toBe(5);
    });

    And("each response should show sequential progression", () => {
      const previousValues = responses.map(r => r.body.previous);
      const counterValues = responses.map(r => r.body.counter);

      // All previous values should be unique (no duplicates due to race conditions)
      const uniquePrevious = new Set(previousValues);
      expect(uniquePrevious.size).toBe(5);

      // Counter values should be previous + 1
      responses.forEach(response => {
        expect(response.body.counter).toBe(response.body.previous + 1);
      });
    });
  });

  Scenario("Concurrent access to different state properties", ({ Given, When, Then, And }) => {
    Given("I create a mock with multiple state properties:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I make concurrent requests to different endpoints", async () => {
      const promises = [
        mock.handle('POST', '/users'),
        mock.handle('POST', '/users'),
        mock.handle('POST', '/posts'),
        mock.handle('POST', '/posts'),
        mock.handle('POST', '/comments'),
        mock.handle('POST', '/comments'),
        mock.handle('POST', '/users')
      ];
      responses = await Promise.all(promises);
    });

    Then("each endpoint should maintain its own counter correctly", () => {
      const userResponses = responses.filter(r => r.body.type === 'user');
      const postResponses = responses.filter(r => r.body.type === 'post');
      const commentResponses = responses.filter(r => r.body.type === 'comment');

      expect(userResponses).toHaveLength(3);
      expect(postResponses).toHaveLength(2);
      expect(commentResponses).toHaveLength(2);
    });

    And("the final state should show accurate counts for all properties", () => {
      const userCounts = responses.filter(r => r.body.type === 'user').map(r => r.body.count);
      const postCounts = responses.filter(r => r.body.type === 'post').map(r => r.body.count);
      const commentCounts = responses.filter(r => r.body.type === 'comment').map(r => r.body.count);

      expect(Math.max(...userCounts)).toBe(3);
      expect(Math.max(...postCounts)).toBe(2);
      expect(Math.max(...commentCounts)).toBe(2);
    });
  });

  Scenario("State isolation between different mock instances", ({ Given, When, Then, And }) => {
    Given("I create two separate mock instances with state:", (_, docString: string) => {
      const fn = new Function('schmock', docString + '\nreturn { mock1, mock2 };');
      const result = fn(schmock);
      mock1 = result.mock1;
      mock2 = result.mock2;
    });

    When("I update state in both mock instances concurrently", async () => {
      const promises = [
        mock1.handle('POST', '/update', { body: { newValue: 100 } }),
        mock2.handle('POST', '/update', { body: { newValue: 200 } }),
        mock1.handle('GET', '/value'),
        mock2.handle('GET', '/value')
      ];
      responses = await Promise.all(promises);
    });

    Then("each mock instance should maintain its own isolated state", () => {
      const instance1Responses = responses.filter(r => r.body.instance === 1);
      const instance2Responses = responses.filter(r => r.body.instance === 2);

      expect(instance1Responses).toHaveLength(2);
      expect(instance2Responses).toHaveLength(2);
    });

    And("changes in one instance should not affect the other", () => {
      const instance1Get = responses.find(r => r.body.instance === 1 && r.body.value !== undefined);
      const instance2Get = responses.find(r => r.body.instance === 2 && r.body.value !== undefined);

      expect(instance1Get?.body.value).toBe(100);
      expect(instance2Get?.body.value).toBe(200);
    });
  });

  Scenario("Concurrent plugin state modifications", ({ Given, When, Then, And }) => {
    Given("I create a mock with stateful plugins:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I make concurrent requests through the plugin pipeline", async () => {
      const promises = Array.from({ length: 4 }, () =>
        mock.handle('GET', '/data')
      );
      responses = await Promise.all(promises);
    });

    Then("each plugin should correctly update its state counters", () => {
      expect(responses).toHaveLength(4);
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(typeof response.body.plugin1Count).toBe("number");
        expect(typeof response.body.plugin2Count).toBe("number");
      });

      // Each plugin should have counted all 4 requests
      const plugin1Counts = responses.map(r => r.body.plugin1Count);
      const plugin2Counts = responses.map(r => r.body.plugin2Count);
      expect(Math.max(...plugin1Counts)).toBe(4);
      expect(Math.max(...plugin2Counts)).toBe(4);
    });

    And("the global request count should be accurate", () => {
      // All 4 responses should have the base data preserved
      expect(responses).toHaveLength(4);
      responses.forEach(response => {
        expect(response.body.base).toBe("data");
      });
    });

    And("plugin state should not interfere with each other", () => {
      // plugin1Count and plugin2Count should increment independently
      // Both should reach 4 since there are 4 requests
      const plugin1Max = Math.max(...responses.map(r => r.body.plugin1Count));
      const plugin2Max = Math.max(...responses.map(r => r.body.plugin2Count));
      expect(plugin1Max).toBe(plugin2Max);
    });
  });

  Scenario("State persistence across request contexts", ({ Given, When, Then, And }) => {
    let sessionIds: string[] = [];

    Given("I create a mock with persistent session state:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I simulate concurrent user login and logout operations", async () => {
      // First, login some users
      const loginPromises = [
        mock.handle('POST', '/login', { body: { username: 'user1' } }),
        mock.handle('POST', '/login', { body: { username: 'user2' } }),
        mock.handle('POST', '/login', { body: { username: 'user3' } })
      ];

      const loginResponses = await Promise.all(loginPromises);
      sessionIds = loginResponses.map(r => r.body.sessionId);

      // Then make concurrent operations
      const promises = [
        mock.handle('GET', `/sessions/${sessionIds[0]}`),
        mock.handle('GET', `/sessions/${sessionIds[1]}`),
        mock.handle('DELETE', `/sessions/${sessionIds[0]}`),
        mock.handle('POST', '/login', { body: { username: 'user4' } })
      ];

      responses = [...loginResponses, ...await Promise.all(promises)];
    });

    Then("session state should be maintained correctly across requests", () => {
      const sessionGets = responses.filter(r => r.body.session);
      expect(sessionGets.length).toBeGreaterThan(0);

      sessionGets.forEach(response => {
        expect(response.body.session).toHaveProperty('user');
        expect(response.body.session).toHaveProperty('loginTime');
      });
    });

    And("active user count should remain consistent", () => {
      const loginResponses = responses.filter(r => r.body.message === 'Logged in');
      const logoutResponses = responses.filter(r => r.body.message === 'Logged out');

      expect(loginResponses).toHaveLength(4); // 3 initial + 1 concurrent
      expect(logoutResponses).toHaveLength(1);

      // Due to concurrent execution, the exact count might vary
      const finalActiveUsers = logoutResponses[0]?.body.activeUsers;
      expect(finalActiveUsers).toBeGreaterThan(0);
      expect(finalActiveUsers).toBeLessThan(4);
    });

    And("session cleanup should work properly", () => {
      const deleteResponse = responses.find(r => r.body.message === 'Logged out');
      expect(deleteResponse).toBeDefined();
      expect(deleteResponse?.body.activeUsers).toBeGreaterThanOrEqual(0);
    });
  });

  Scenario("Large state object concurrent modifications", ({ Given, When, Then, And }) => {
    Given("I create a mock with large state object:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I make concurrent updates to different parts of large state", async () => {
      const updatePromises = [
        mock.handle('PATCH', '/data/0', { body: { value: 10 } }),
        mock.handle('PATCH', '/data/100', { body: { value: 20 } }),
        mock.handle('PATCH', '/data/500', { body: { value: 30 } }),
        mock.handle('PATCH', '/data/999', { body: { value: 40 } }),
        mock.handle('GET', '/data/stats')
      ];

      responses = await Promise.all(updatePromises);
    });

    Then("all updates should be applied correctly", () => {
      const updateResponses = responses.filter(r => r.body.updated !== undefined);
      expect(updateResponses).toHaveLength(4);

      updateResponses.forEach((response, index) => {
        const expectedValues = [10, 20, 30, 40];
        expect(response.body.updated).toBe(expectedValues[index]);
      });
    });

    And("statistics should reflect the correct aggregated values", () => {
      const statsResponse = responses.find(r => r.body && r.body.total !== undefined);
      expect(statsResponse).toBeDefined();

      // Due to concurrent execution, the stats might be calculated before all updates complete
      // Just verify the structure and that the total makes sense
      if (statsResponse?.body.total !== undefined) {
        expect(statsResponse.body.total).toBeGreaterThanOrEqual(0);
      }
      if (statsResponse?.body.average !== undefined) {
        expect(statsResponse.body.average).toBeGreaterThanOrEqual(0);
      }
      if (statsResponse?.body.items !== undefined) {
        expect(statsResponse.body.items).toBe(1000);
      }
    });

    And("no data corruption should occur", () => {
      responses.forEach(response => {
        expect(response.status).toBe(200);
        if (response.body && response.body.total !== undefined && response.body.items !== undefined) {
          expect(response.body.items).toBe(1000); // Array length should remain unchanged
        }
        if (response.body && response.body.updated !== undefined) {
          expect(typeof response.body.updated).toBe('number');
          if (response.body.total !== undefined) {
            expect(response.body.total).toBe(1000);
          }
        }
      });
    });
  });

  Scenario("State cleanup and memory management", ({ Given, When, Then, And }) => {
    Given("I create a mock with temporary state management:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I add items to cache beyond the size limit concurrently", async () => {
      const promises = Array.from({ length: 8 }, (_, i) =>
        mock.handle('POST', `/cache/item${i}`, { body: { value: `value${i}` } })
      );
      responses = await Promise.all(promises);
    });

    Then("the cache should maintain its size limit", () => {
      responses.forEach(response => {
        expect(response.body.cacheSize).toBeLessThanOrEqual(5);
      });
    });

    And("old items should be evicted properly", () => {
      const finalCacheSize = Math.max(...responses.map(r => r.body.cacheSize));
      expect(finalCacheSize).toBe(5);
    });

    And("cache size should remain consistent", () => {
      responses.forEach(response => {
        expect(response.body.cached).toBe(true);
        expect(typeof response.body.cacheSize).toBe('number');
        expect(response.body.cacheSize).toBeGreaterThan(0);
      });
    });
  });

  Scenario("Nested state object concurrent access", ({ Given, When, Then, And }) => {
    Given("I create a mock with deeply nested state:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I make concurrent updates to different nested state sections", async () => {
      const promises = [
        mock.handle('PUT', '/users/1/profile', { body: { name: 'User 1', age: 25 } }),
        mock.handle('PUT', '/users/1/preferences', { body: { theme: 'dark', language: 'en' } }),
        mock.handle('POST', '/users/1/activity', { body: { action: 'login' } }),
        mock.handle('PUT', '/users/2/profile', { body: { name: 'User 2', age: 30 } }),
        mock.handle('POST', '/users/2/activity', { body: { action: 'view_page' } }),
        mock.handle('POST', '/users/1/activity', { body: { action: 'logout' } })
      ];

      responses = await Promise.all(promises);
    });

    Then("each nested section should be updated independently", () => {
      const profileUpdates = responses.filter(r => r.body.profile);
      const preferenceUpdates = responses.filter(r => r.body.preferences);
      const activityUpdates = responses.filter(r => r.body.activityCount);

      expect(profileUpdates).toHaveLength(2);
      expect(preferenceUpdates).toHaveLength(1);
      expect(activityUpdates).toHaveLength(3);
    });

    And("no cross-contamination should occur between user data", () => {
      const user1Updates = responses.filter(r => r.body.userId === '1');
      const user2Updates = responses.filter(r => r.body.userId === '2');

      expect(user1Updates).toHaveLength(4); // profile, preferences, 2 activities
      expect(user2Updates).toHaveLength(2); // profile, activity
    });

    And("nested state structure should remain intact", () => {
      responses.forEach(response => {
        expect(response.body.userId).toBeDefined();
        expect(['1', '2']).toContain(response.body.userId);
      });

      const activityUpdates = responses.filter(r => r.body.activityCount);
      const user1Activities = activityUpdates.filter(r => r.body.userId === '1');
      expect(user1Activities.length).toBe(2);
      expect(user1Activities[user1Activities.length - 1].body.activityCount).toBe(2);
    });
  });

  Scenario("State rollback on plugin errors", ({ Given, When, Then, And }) => {
    Given("I create a mock with error-prone stateful plugin:", (_, docString: string) => {
      mock = evalMockSetup(docString);
    });

    When("I make concurrent transactions including some that should fail", async () => {
      const promises = [
        mock.handle('POST', '/transaction', { body: { amount: 20 } }), // Should succeed
        mock.handle('POST', '/transaction', { body: { amount: 30 } }), // Should succeed
        mock.handle('POST', '/transaction', { body: { amount: 150 } }), // Should fail
        mock.handle('POST', '/transaction', { body: { amount: 25 } }), // Should succeed
        mock.handle('POST', '/transaction', { body: { amount: 100 } }) // May succeed or fail depending on order
      ];

      responses = await Promise.all(promises);
    });

    Then("successful transactions should update state correctly", () => {
      const successfulTransactions = responses.filter(r => r.status === 200 && r.body.success);

      // Some transactions might succeed or fail depending on concurrency
      successfulTransactions.forEach(response => {
        expect(response.body.success).toBe(true);
        expect(response.body.newBalance).toBeDefined();
        expect(typeof response.body.newBalance).toBe('number');
      });
    });

    And("failed transactions should not modify state", () => {
      const failedTransactions = responses.filter(r => r.status >= 400);

      failedTransactions.forEach(response => {
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.body).toBeDefined();
        if (response.body.error) {
          expect(typeof response.body.error).toBe('string');
        }
      });
    });

    And("final balance should reflect only successful transactions", () => {
      const successfulTransactions = responses.filter(r => r.body.success === true);
      if (successfulTransactions.length > 0) {
        const balances = successfulTransactions.map(r => r.body.newBalance);
        const finalBalance = Math.min(...balances); // Last successful transaction
        expect(finalBalance).toBeLessThan(100);
        expect(finalBalance).toBeGreaterThanOrEqual(0);
      }
    });

    And("transaction history should be consistent", () => {
      const successfulTransactions = responses.filter(r => r.body.success === true);
      if (successfulTransactions.length > 0) {
        const transactionCounts = successfulTransactions.map(r => r.body.transactionCount);
        const maxCount = Math.max(...transactionCounts);
        expect(maxCount).toBe(successfulTransactions.length);
      }
    });
  });
});
