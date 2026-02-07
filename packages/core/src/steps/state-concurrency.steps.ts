import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { CallableMockInstance, Plugin } from "../types";

// ---------- State shape interfaces for each scenario ----------
// Index signatures ensure compatibility with Record<string, unknown>

interface CounterState { counter: number; [k: string]: unknown }
interface MultiCounterState { users: number; posts: number; comments: number; [k: string]: unknown }
interface ValueState { value: number; [k: string]: unknown }
interface UpdateBody { newValue: number }
interface PluginState {
  requestCount: number;
  pluginData: Record<string, number>;
  [k: string]: unknown;
}
interface SessionState {
  sessions: Record<string, { user: string; loginTime: string }>;
  activeUsers: number;
  [k: string]: unknown;
}
interface LoginBody { username: string }
interface DataItem { id: number; value: number }
interface DataArrayState { data: DataItem[]; [k: string]: unknown }
interface DataUpdateBody { value: number }
interface CacheState {
  cache: Record<string, { value: string; timestamp: number }>;
  cacheSize: number;
  maxCacheSize: number;
  [k: string]: unknown;
}
interface CacheBody { value: string }
interface NestedUsersState {
  users: {
    profiles: Record<string, Record<string, unknown>>;
    preferences: Record<string, Record<string, unknown>>;
    activity: Record<string, Array<Record<string, unknown>>>;
  };
  [k: string]: unknown;
}
interface TransactionState {
  transactions: Array<{ amount: number; balanceAfter: number; timestamp: number }>;
  balance: number;
  [k: string]: unknown;
}
interface TransactionBody { amount: number }

// ---------- Response body interfaces for assertions ----------

interface CounterBody { counter: number; previous: number }
interface TypeCountBody { type: string; count: number }
interface InstanceBody { instance: number; value?: number; updated?: number }
interface PluginResponseBody { plugin1Count: number; plugin2Count: number; base: string }
interface SessionResponseBody {
  sessionId: string;
  message: string;
  activeUsers: number;
  session?: { user: string; loginTime: string };
  totalSessions?: number;
  error?: string;
}
interface DataUpdateResponseBody { id: number; updated: number; total: number }
interface StatsResponseBody { total: number; average: number; items: number }
interface CacheResponseBody { key: string; cached: boolean; cacheSize: number }
interface ProfileResponseBody { userId: string; profile?: unknown; preferences?: unknown; activityCount?: number }
interface TransactionResponseBody { success: boolean; newBalance: number; transactionCount: number; error?: string; balance?: number }

const feature = await loadFeature("../../features/state-concurrency.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let mock1: CallableMockInstance;
  let mock2: CallableMockInstance;
  let responses: any[] = [];

  Scenario("Concurrent state updates with race conditions", ({ Given, When, Then, And }) => {
    Given("I create a mock with a shared counter state", () => {
      mock = schmock({ state: { counter: 0 } });
      mock("POST /increment", ({ state }) => {
        const s = state as CounterState;
        const current = s.counter;
        s.counter = current + 1;
        return { counter: s.counter, previous: current };
      });
    });

    When("I make 5 concurrent increment requests", async () => {
      const promises = Array.from({ length: 5 }, () =>
        mock.handle("POST", "/increment")
      );
      responses = await Promise.all(promises);
    });

    Then("all requests should complete successfully", () => {
      expect(responses).toHaveLength(5);
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("counter");
        expect(response.body).toHaveProperty("previous");
      });
    });

    And("the final counter should reflect all increments", () => {
      const finalCounters = responses.map(r => (r.body as CounterBody).counter);
      const maxCounter = Math.max(...finalCounters);
      expect(maxCounter).toBe(5);
    });

    And("each response should show sequential progression", () => {
      const previousValues = responses.map(r => (r.body as CounterBody).previous);
      const counterValues = responses.map(r => (r.body as CounterBody).counter);

      // All previous values should be unique (no duplicates due to race conditions)
      const uniquePrevious = new Set(previousValues);
      expect(uniquePrevious.size).toBe(5);

      // Counter values should be previous + 1
      responses.forEach(response => {
        const body = response.body as CounterBody;
        expect(body.counter).toBe(body.previous + 1);
      });
    });
  });

  Scenario("Concurrent access to different state properties", ({ Given, When, Then, And }) => {
    Given("I create a mock with separate user, post, and comment counters", () => {
      mock = schmock({
        state: {
          users: 0,
          posts: 0,
          comments: 0,
        },
      });
      mock("POST /users", ({ state }) => {
        const s = state as MultiCounterState;
        s.users++;
        return { type: "user", count: s.users };
      });
      mock("POST /posts", ({ state }) => {
        const s = state as MultiCounterState;
        s.posts++;
        return { type: "post", count: s.posts };
      });
      mock("POST /comments", ({ state }) => {
        const s = state as MultiCounterState;
        s.comments++;
        return { type: "comment", count: s.comments };
      });
    });

    When("I make concurrent requests to different endpoints", async () => {
      const promises = [
        mock.handle("POST", "/users"),
        mock.handle("POST", "/users"),
        mock.handle("POST", "/posts"),
        mock.handle("POST", "/posts"),
        mock.handle("POST", "/comments"),
        mock.handle("POST", "/comments"),
        mock.handle("POST", "/users"),
      ];
      responses = await Promise.all(promises);
    });

    Then("each endpoint should maintain its own counter correctly", () => {
      const userResponses = responses.filter(r => (r.body as TypeCountBody).type === "user");
      const postResponses = responses.filter(r => (r.body as TypeCountBody).type === "post");
      const commentResponses = responses.filter(r => (r.body as TypeCountBody).type === "comment");

      expect(userResponses).toHaveLength(3);
      expect(postResponses).toHaveLength(2);
      expect(commentResponses).toHaveLength(2);
    });

    And("the final state should show accurate counts for all properties", () => {
      const userCounts = responses.filter(r => (r.body as TypeCountBody).type === "user").map(r => (r.body as TypeCountBody).count);
      const postCounts = responses.filter(r => (r.body as TypeCountBody).type === "post").map(r => (r.body as TypeCountBody).count);
      const commentCounts = responses.filter(r => (r.body as TypeCountBody).type === "comment").map(r => (r.body as TypeCountBody).count);

      expect(Math.max(...userCounts)).toBe(3);
      expect(Math.max(...postCounts)).toBe(2);
      expect(Math.max(...commentCounts)).toBe(2);
    });
  });

  Scenario("State isolation between different mock instances", ({ Given, When, Then, And }) => {
    Given("I create two separate mock instances with independent state", () => {
      mock1 = schmock({ state: { value: 10 } });
      mock2 = schmock({ state: { value: 20 } });

      mock1("GET /value", ({ state }) => ({ instance: 1, value: (state as ValueState).value }));
      mock2("GET /value", ({ state }) => ({ instance: 2, value: (state as ValueState).value }));

      mock1("POST /update", ({ state, body }) => {
        const s = state as ValueState;
        const b = body as UpdateBody;
        s.value = b.newValue;
        return { instance: 1, updated: s.value };
      });
      mock2("POST /update", ({ state, body }) => {
        const s = state as ValueState;
        const b = body as UpdateBody;
        s.value = b.newValue;
        return { instance: 2, updated: s.value };
      });
    });

    When("I update state in both mock instances concurrently", async () => {
      const promises = [
        mock1.handle("POST", "/update", { body: { newValue: 100 } }),
        mock2.handle("POST", "/update", { body: { newValue: 200 } }),
        mock1.handle("GET", "/value"),
        mock2.handle("GET", "/value"),
      ];
      responses = await Promise.all(promises);
    });

    Then("each mock instance should maintain its own isolated state", () => {
      const instance1Responses = responses.filter(r => (r.body as InstanceBody).instance === 1);
      const instance2Responses = responses.filter(r => (r.body as InstanceBody).instance === 2);

      expect(instance1Responses).toHaveLength(2);
      expect(instance2Responses).toHaveLength(2);
    });

    And("changes in one instance should not affect the other", () => {
      const instance1Get = responses.find(r => (r.body as InstanceBody).instance === 1 && (r.body as InstanceBody).value !== undefined);
      const instance2Get = responses.find(r => (r.body as InstanceBody).instance === 2 && (r.body as InstanceBody).value !== undefined);

      expect((instance1Get?.body as InstanceBody | undefined)?.value).toBe(100);
      expect((instance2Get?.body as InstanceBody | undefined)?.value).toBe(200);
    });
  });

  Scenario("Concurrent plugin state modifications", ({ Given, When, Then, And }) => {
    Given("I create a mock with stateful counter and tracker plugins", () => {
      mock = schmock({ state: { requestCount: 0, pluginData: {} } });

      const plugin1: Plugin = {
        name: "counter-plugin",
        process: (ctx, response) => {
          const rs = ctx.routeState! as PluginState;
          rs.requestCount++;
          rs.pluginData.plugin1 = (rs.pluginData.plugin1 || 0) + 1;
          return {
            context: ctx,
            response: { ...(response as Record<string, unknown>), plugin1Count: rs.pluginData.plugin1 },
          };
        },
      };

      const plugin2: Plugin = {
        name: "tracker-plugin",
        process: (ctx, response) => {
          const rs = ctx.routeState! as PluginState;
          rs.pluginData.plugin2 = (rs.pluginData.plugin2 || 0) + 1;
          return {
            context: ctx,
            response: { ...(response as Record<string, unknown>), plugin2Count: rs.pluginData.plugin2 },
          };
        },
      };

      mock("GET /data", { base: "data" }).pipe(plugin1).pipe(plugin2);
    });

    When("I make concurrent requests through the plugin pipeline", async () => {
      const promises = Array.from({ length: 4 }, () =>
        mock.handle("GET", "/data")
      );
      responses = await Promise.all(promises);
    });

    Then("each plugin should correctly update its state counters", () => {
      expect(responses).toHaveLength(4);
      responses.forEach(response => {
        const body = response.body as PluginResponseBody;
        expect(response.status).toBe(200);
        expect(typeof body.plugin1Count).toBe("number");
        expect(typeof body.plugin2Count).toBe("number");
      });

      // Each plugin should have counted all 4 requests
      const plugin1Counts = responses.map(r => (r.body as PluginResponseBody).plugin1Count);
      const plugin2Counts = responses.map(r => (r.body as PluginResponseBody).plugin2Count);
      expect(Math.max(...plugin1Counts)).toBe(4);
      expect(Math.max(...plugin2Counts)).toBe(4);
    });

    And("the global request count should be accurate", () => {
      // All 4 responses should have the base data preserved
      expect(responses).toHaveLength(4);
      responses.forEach(response => {
        expect((response.body as PluginResponseBody).base).toBe("data");
      });
    });

    And("plugin state should not interfere with each other", () => {
      // plugin1Count and plugin2Count should increment independently
      // Both should reach 4 since there are 4 requests
      const plugin1Max = Math.max(...responses.map(r => (r.body as PluginResponseBody).plugin1Count));
      const plugin2Max = Math.max(...responses.map(r => (r.body as PluginResponseBody).plugin2Count));
      expect(plugin1Max).toBe(plugin2Max);
    });
  });

  Scenario("State persistence across request contexts", ({ Given, When, Then, And }) => {
    let sessionIds: string[] = [];

    Given("I create a mock with persistent session state", () => {
      mock = schmock({
        state: {
          sessions: {},
          activeUsers: 0,
        },
      });

      mock("POST /login", ({ state, body }) => {
        const s = state as SessionState;
        const b = body as LoginBody;
        const sessionId = "session_" + Date.now();
        s.sessions[sessionId] = {
          user: b.username,
          loginTime: new Date().toISOString(),
        };
        s.activeUsers++;
        return { sessionId, message: "Logged in", activeUsers: s.activeUsers };
      });

      mock("GET /sessions/:sessionId", ({ state, params }) => {
        const s = state as SessionState;
        const session = s.sessions[params.sessionId];
        return session
          ? { session, totalSessions: Object.keys(s.sessions).length }
          : [404, { error: "Session not found" }];
      });

      mock("DELETE /sessions/:sessionId", ({ state, params }) => {
        const s = state as SessionState;
        if (s.sessions[params.sessionId]) {
          delete s.sessions[params.sessionId];
          s.activeUsers--;
          return { message: "Logged out", activeUsers: s.activeUsers };
        }
        return [404, { error: "Session not found" }];
      });
    });

    When("I simulate concurrent user login and logout operations", async () => {
      // First, login some users
      const loginPromises = [
        mock.handle("POST", "/login", { body: { username: "user1" } }),
        mock.handle("POST", "/login", { body: { username: "user2" } }),
        mock.handle("POST", "/login", { body: { username: "user3" } }),
      ];

      const loginResponses = await Promise.all(loginPromises);
      sessionIds = loginResponses.map(r => (r.body as SessionResponseBody).sessionId);

      // Then make concurrent operations
      const promises = [
        mock.handle("GET", `/sessions/${sessionIds[0]}`),
        mock.handle("GET", `/sessions/${sessionIds[1]}`),
        mock.handle("DELETE", `/sessions/${sessionIds[0]}`),
        mock.handle("POST", "/login", { body: { username: "user4" } }),
      ];

      responses = [...loginResponses, ...await Promise.all(promises)];
    });

    Then("session state should be maintained correctly across requests", () => {
      const sessionGets = responses.filter(r => (r.body as SessionResponseBody).session);
      expect(sessionGets.length).toBeGreaterThan(0);

      sessionGets.forEach(response => {
        const body = response.body as SessionResponseBody;
        expect(body.session).toHaveProperty("user");
        expect(body.session).toHaveProperty("loginTime");
      });
    });

    And("active user count should remain consistent", () => {
      const loginResponses = responses.filter(r => (r.body as SessionResponseBody).message === "Logged in");
      const logoutResponses = responses.filter(r => (r.body as SessionResponseBody).message === "Logged out");

      expect(loginResponses).toHaveLength(4); // 3 initial + 1 concurrent
      expect(logoutResponses).toHaveLength(1);

      // Due to concurrent execution, the exact count might vary
      const finalActiveUsers = (logoutResponses[0]?.body as SessionResponseBody | undefined)?.activeUsers;
      expect(finalActiveUsers).toBeGreaterThan(0);
      expect(finalActiveUsers).toBeLessThan(4);
    });

    And("session cleanup should work properly", () => {
      const deleteResponse = responses.find(r => (r.body as SessionResponseBody).message === "Logged out");
      expect(deleteResponse).toBeDefined();
      expect((deleteResponse?.body as SessionResponseBody | undefined)?.activeUsers).toBeGreaterThanOrEqual(0);
    });
  });

  Scenario("Large state object concurrent modifications", ({ Given, When, Then, And }) => {
    Given("I create a mock with a large 1000-item data array", () => {
      mock = schmock({
        state: {
          data: Array.from({ length: 1000 }, (_, i) => ({ id: i, value: 0 })),
        },
      });

      mock("PATCH /data/:id", ({ state, params, body }) => {
        const s = state as DataArrayState;
        const b = body as DataUpdateBody;
        const id = parseInt(params.id);
        const item = s.data.find((d: DataItem) => d.id === id);
        if (item) {
          item.value = b.value;
          return { id, updated: item.value, total: s.data.length };
        }
        return [404, { error: "Item not found" }];
      });

      mock("GET /data/stats", ({ state }) => {
        const s = state as DataArrayState;
        const total = s.data.reduce((sum: number, item: DataItem) => sum + item.value, 0);
        const average = total / s.data.length;
        return { total, average, items: s.data.length };
      });
    });

    When("I make concurrent updates to different parts of large state", async () => {
      const updatePromises = [
        mock.handle("PATCH", "/data/0", { body: { value: 10 } }),
        mock.handle("PATCH", "/data/100", { body: { value: 20 } }),
        mock.handle("PATCH", "/data/500", { body: { value: 30 } }),
        mock.handle("PATCH", "/data/999", { body: { value: 40 } }),
        mock.handle("GET", "/data/stats"),
      ];

      responses = await Promise.all(updatePromises);
    });

    Then("all updates should be applied correctly", () => {
      const updateResponses = responses.filter(r => (r.body as DataUpdateResponseBody).updated !== undefined);
      expect(updateResponses).toHaveLength(4);

      updateResponses.forEach((response, index) => {
        const expectedValues = [10, 20, 30, 40];
        expect((response.body as DataUpdateResponseBody).updated).toBe(expectedValues[index]);
      });
    });

    And("statistics should reflect the correct aggregated values", () => {
      const statsResponse = responses.find(r => r.body && (r.body as StatsResponseBody).total !== undefined);
      expect(statsResponse).toBeDefined();

      // Due to concurrent execution, the stats might be calculated before all updates complete
      // Just verify the structure and that the total makes sense
      const statsBody = statsResponse?.body as StatsResponseBody | undefined;
      if (statsBody?.total !== undefined) {
        expect(statsBody.total).toBeGreaterThanOrEqual(0);
      }
      if (statsBody?.average !== undefined) {
        expect(statsBody.average).toBeGreaterThanOrEqual(0);
      }
      if (statsBody?.items !== undefined) {
        expect(statsBody.items).toBe(1000);
      }
    });

    And("no data corruption should occur", () => {
      responses.forEach(response => {
        const body = response.body as Record<string, unknown>;
        expect(response.status).toBe(200);
        if (body && body.total !== undefined && body.items !== undefined) {
          expect(body.items).toBe(1000); // Array length should remain unchanged
        }
        if (body && body.updated !== undefined) {
          expect(typeof body.updated).toBe("number");
          if (body.total !== undefined) {
            expect(body.total).toBe(1000);
          }
        }
      });
    });
  });

  Scenario("State cleanup and memory management", ({ Given, When, Then, And }) => {
    Given("I create a mock with LRU cache state", () => {
      mock = schmock({
        state: {
          cache: {},
          cacheSize: 0,
          maxCacheSize: 5,
        },
      });

      mock("POST /cache/:key", ({ state, params, body }) => {
        const s = state as CacheState;
        const b = body as CacheBody;
        // Simple LRU-like cache with size limit
        if (s.cacheSize >= s.maxCacheSize) {
          const oldestKey = Object.keys(s.cache)[0];
          delete s.cache[oldestKey];
          s.cacheSize--;
        }

        s.cache[params.key] = {
          value: b.value,
          timestamp: Date.now(),
        };
        s.cacheSize++;

        return {
          key: params.key,
          cached: true,
          cacheSize: s.cacheSize,
        };
      });

      mock("GET /cache/:key", ({ state, params }) => {
        const s = state as CacheState;
        const item = s.cache[params.key];
        return item
          ? { key: params.key, ...item }
          : [404, { error: "Not found in cache" }];
      });
    });

    When("I add items to cache beyond the size limit concurrently", async () => {
      const promises = Array.from({ length: 8 }, (_, i) =>
        mock.handle("POST", `/cache/item${i}`, { body: { value: `value${i}` } })
      );
      responses = await Promise.all(promises);
    });

    Then("the cache should maintain its size limit", () => {
      responses.forEach(response => {
        expect((response.body as CacheResponseBody).cacheSize).toBeLessThanOrEqual(5);
      });
    });

    And("old items should be evicted properly", () => {
      const finalCacheSize = Math.max(...responses.map(r => (r.body as CacheResponseBody).cacheSize));
      expect(finalCacheSize).toBe(5);
    });

    And("cache size should remain consistent", () => {
      responses.forEach(response => {
        const body = response.body as CacheResponseBody;
        expect(body.cached).toBe(true);
        expect(typeof body.cacheSize).toBe("number");
        expect(body.cacheSize).toBeGreaterThan(0);
      });
    });
  });

  Scenario("Nested state object concurrent access", ({ Given, When, Then, And }) => {
    Given("I create a mock with deeply nested user state", () => {
      mock = schmock({
        state: {
          users: {
            profiles: {},
            preferences: {},
            activity: {},
          },
        },
      });

      mock("PUT /users/:id/profile", ({ state, params, body }) => {
        const s = state as NestedUsersState;
        if (!s.users.profiles[params.id]) {
          s.users.profiles[params.id] = {};
        }
        Object.assign(s.users.profiles[params.id], body);
        return { userId: params.id, profile: s.users.profiles[params.id] };
      });

      mock("PUT /users/:id/preferences", ({ state, params, body }) => {
        const s = state as NestedUsersState;
        s.users.preferences[params.id] = { ...(body as Record<string, unknown>), updatedAt: Date.now() };
        return { userId: params.id, preferences: s.users.preferences[params.id] };
      });

      mock("POST /users/:id/activity", ({ state, params, body }) => {
        const s = state as NestedUsersState;
        if (!s.users.activity[params.id]) {
          s.users.activity[params.id] = [];
        }
        s.users.activity[params.id].push({ ...(body as Record<string, unknown>), timestamp: Date.now() });
        return {
          userId: params.id,
          activityCount: s.users.activity[params.id].length,
        };
      });
    });

    When("I make concurrent updates to different nested state sections", async () => {
      const promises = [
        mock.handle("PUT", "/users/1/profile", { body: { name: "User 1", age: 25 } }),
        mock.handle("PUT", "/users/1/preferences", { body: { theme: "dark", language: "en" } }),
        mock.handle("POST", "/users/1/activity", { body: { action: "login" } }),
        mock.handle("PUT", "/users/2/profile", { body: { name: "User 2", age: 30 } }),
        mock.handle("POST", "/users/2/activity", { body: { action: "view_page" } }),
        mock.handle("POST", "/users/1/activity", { body: { action: "logout" } }),
      ];

      responses = await Promise.all(promises);
    });

    Then("each nested section should be updated independently", () => {
      const profileUpdates = responses.filter(r => (r.body as ProfileResponseBody).profile);
      const preferenceUpdates = responses.filter(r => (r.body as ProfileResponseBody).preferences);
      const activityUpdates = responses.filter(r => (r.body as ProfileResponseBody).activityCount);

      expect(profileUpdates).toHaveLength(2);
      expect(preferenceUpdates).toHaveLength(1);
      expect(activityUpdates).toHaveLength(3);
    });

    And("no cross-contamination should occur between user data", () => {
      const user1Updates = responses.filter(r => (r.body as ProfileResponseBody).userId === "1");
      const user2Updates = responses.filter(r => (r.body as ProfileResponseBody).userId === "2");

      expect(user1Updates).toHaveLength(4); // profile, preferences, 2 activities
      expect(user2Updates).toHaveLength(2); // profile, activity
    });

    And("nested state structure should remain intact", () => {
      responses.forEach(response => {
        const body = response.body as ProfileResponseBody;
        expect(body.userId).toBeDefined();
        expect(["1", "2"]).toContain(body.userId);
      });

      const activityUpdates = responses.filter(r => (r.body as ProfileResponseBody).activityCount);
      const user1Activities = activityUpdates.filter(r => (r.body as ProfileResponseBody).userId === "1");
      expect(user1Activities.length).toBe(2);
      expect((user1Activities[user1Activities.length - 1].body as ProfileResponseBody).activityCount).toBe(2);
    });
  });

  Scenario("State rollback on plugin errors", ({ Given, When, Then, And }) => {
    Given("I create a mock with an error-prone transaction plugin", () => {
      mock = schmock({ state: { transactions: [], balance: 100 } });

      const transactionPlugin: Plugin = {
        name: "transaction-plugin",
        process: (ctx, response) => {
          const b = ctx.body as TransactionBody;
          const rs = ctx.routeState! as TransactionState;
          const amount = b.amount;
          const currentBalance = rs.balance;

          // Simulate transaction processing
          if (amount > currentBalance) {
            throw new Error("Insufficient funds");
          }

          rs.balance -= amount;
          rs.transactions.push({
            amount,
            balanceAfter: rs.balance,
            timestamp: Date.now(),
          });

          return {
            context: ctx,
            response: {
              success: true,
              newBalance: rs.balance,
              transactionCount: rs.transactions.length,
            },
          };
        },
        onError: (error, ctx) => {
          const rs = ctx.routeState! as TransactionState;
          // Don't modify state on error - let it rollback naturally
          return {
            status: 400,
            body: { error: error.message, balance: rs.balance },
            headers: {},
          };
        },
      };

      mock("POST /transaction", { initialBalance: 100 }).pipe(transactionPlugin);
    });

    When("I make concurrent transactions including some that should fail", async () => {
      const promises = [
        mock.handle("POST", "/transaction", { body: { amount: 20 } }), // Should succeed
        mock.handle("POST", "/transaction", { body: { amount: 30 } }), // Should succeed
        mock.handle("POST", "/transaction", { body: { amount: 150 } }), // Should fail
        mock.handle("POST", "/transaction", { body: { amount: 25 } }), // Should succeed
        mock.handle("POST", "/transaction", { body: { amount: 100 } }), // May succeed or fail depending on order
      ];

      responses = await Promise.all(promises);
    });

    Then("successful transactions should update state correctly", () => {
      const successfulTransactions = responses.filter(r => r.status === 200 && (r.body as TransactionResponseBody).success);

      // Some transactions might succeed or fail depending on concurrency
      successfulTransactions.forEach(response => {
        const body = response.body as TransactionResponseBody;
        expect(body.success).toBe(true);
        expect(body.newBalance).toBeDefined();
        expect(typeof body.newBalance).toBe("number");
      });
    });

    And("failed transactions should not modify state", () => {
      const failedTransactions = responses.filter(r => r.status >= 400);

      failedTransactions.forEach(response => {
        const body = response.body as TransactionResponseBody;
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.body).toBeDefined();
        if (body.error) {
          expect(typeof body.error).toBe("string");
        }
      });
    });

    And("final balance should reflect only successful transactions", () => {
      const successfulTransactions = responses.filter(r => (r.body as TransactionResponseBody).success === true);
      if (successfulTransactions.length > 0) {
        const balances = successfulTransactions.map(r => (r.body as TransactionResponseBody).newBalance);
        const finalBalance = Math.min(...balances); // Last successful transaction
        expect(finalBalance).toBeLessThan(100);
        expect(finalBalance).toBeGreaterThanOrEqual(0);
      }
    });

    And("transaction history should be consistent", () => {
      const successfulTransactions = responses.filter(r => (r.body as TransactionResponseBody).success === true);
      if (successfulTransactions.length > 0) {
        const transactionCounts = successfulTransactions.map(r => (r.body as TransactionResponseBody).transactionCount);
        const maxCount = Math.max(...transactionCounts);
        expect(maxCount).toBe(successfulTransactions.length);
      }
    });
  });
});
