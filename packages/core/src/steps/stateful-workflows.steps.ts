import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { MockInstance } from "../types";

const feature = await loadFeature("../../features/stateful-workflows.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: MockInstance<any>;
  let response: any;
  let sessionToken: string;
  let addedItemIds: number[] = [];

  Scenario("Shopping cart workflow", ({ Given, When, Then, And }) => {
    addedItemIds = [];

    Given("I create a stateful shopping cart mock:", (_, docString: string) => {
      // Create stateful shopping cart mock with new callable API
      const sharedState = { items: [], total: 0 };
      mock = schmock({ state: sharedState });
      
      mock('GET /cart', ({ state }) => ({
        items: state.items,
        total: state.total,
        count: state.items.length
      }));
      
      mock('POST /cart/add', ({ state, body }) => {
        const item = { 
          id: Date.now(), 
          name: body.name, 
          price: body.price, 
          quantity: body.quantity || 1 
        };
        
        state.items.push(item);
        state.total += item.price * item.quantity;
        
        return {
          message: 'Item added to cart',
          added: item,
          cart: {
            items: state.items,
            total: state.total,
            count: state.items.length
          }
        };
      });
      
      mock('DELETE /cart/:id', ({ state, params }) => {
        const itemId = parseInt(params.id);
        const itemIndex = state.items.findIndex(item => item.id === itemId);
        
        if (itemIndex === -1) {
          return [404, { error: 'Item not found in cart' }];
        }
        
        const removedItem = state.items[itemIndex];
        state.total -= removedItem.price * removedItem.quantity;
        state.items.splice(itemIndex, 1);
        
        return {
          message: 'Item removed from cart',
          item: removedItem,
          cart: {
            items: state.items,
            total: state.total,
            count: state.items.length
          }
        };
      });
      
      mock('POST /cart/clear', ({ state }) => {
        state.items = [];
        state.total = 0;
        
        return {
          message: 'Cart cleared',
          cart: {
            items: state.items,
            total: state.total,
            count: state.items.length
          }
        };
      });
    });

    When("I request {string}", async (_, request: string) => {
      const [method, path] = request.split(" ");
      response = await mock.handle(method as any, path);
    });

    Then("the response should show an empty cart with count {int}", (_, expectedCount: number) => {
      expect(response.body.count).toBe(expectedCount);
      expect(response.body.items).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    When("I add item with name {string} and price {string}", async (_, itemName: string, priceStr: string) => {
      const price = parseFloat(priceStr);
      response = await mock.handle("POST", "/cart/add", {
        body: { name: itemName, price }
      });
      addedItemIds.push(response.body.added.id);
    });

    And("I add second item with name {string} and price {string}", async (_, itemName: string, priceStr: string) => {
      const price = parseFloat(priceStr);
      response = await mock.handle("POST", "/cart/add", {
        body: { name: itemName, price }
      });
      addedItemIds.push(response.body.added.id);
    });

    Then("the cart should contain {int} items", async (_, expectedCount: number) => {
      const cartResponse = await mock.handle("GET", "/cart");
      expect(cartResponse.body.count).toBe(expectedCount);
    });

    Then("the cart should contain {int} item", async (_, expectedCount: number) => {
      const cartResponse = await mock.handle("GET", "/cart");
      expect(cartResponse.body.count).toBe(expectedCount);
    });

    And("the initial cart total should be {string}", async (_, expectedTotalStr: string) => {
      const expectedTotal = parseFloat(expectedTotalStr);
      const cartResponse = await mock.handle("GET", "/cart");
      expect(cartResponse.body.total).toBe(expectedTotal);
    });

    And("the final cart total should be {string}", async (_, expectedTotalStr: string) => {
      const expectedTotal = parseFloat(expectedTotalStr);
      const cartResponse = await mock.handle("GET", "/cart");
      expect(cartResponse.body.total).toBe(expectedTotal);
    });

    When("I remove the first item from the cart", async () => {
      const cartResponse = await mock.handle("GET", "/cart");
      const firstItemId = cartResponse.body.items[0].id;
      response = await mock.handle("DELETE", `/cart/${firstItemId}`);
    });
  });

  Scenario("User session simulation", ({ Given, When, Then, And }) => {
    sessionToken = "";

    Given("I create a session-based mock:", (_, docString: string) => {
      // Create session-based mock with new callable API
      const sharedState = { 
        users: [
          { username: 'admin', password: 'secret', profile: { name: 'Admin User', role: 'administrator' } },
          { username: 'user1', password: 'pass123', profile: { name: 'Regular User', role: 'user' } }
        ],
        sessions: {} 
      };
      
      mock = schmock({ state: sharedState });
      
      mock('POST /auth/login', ({ state, body }) => {
        const user = state.users.find(u => u.username === body.username && u.password === body.password);
        
        if (!user) {
          return [401, { error: 'Invalid credentials' }];
        }
        
        const token = `token-${user.username}-${Date.now()}`;
        state.sessions[token] = {
          user: user.username,
          profile: user.profile,
          loginTime: new Date().toISOString()
        };
        
        return {
          message: 'Login successful',
          token: token,
          user: user.profile
        };
      });
      
      mock('GET /profile', ({ state, headers }) => {
        const token = headers.authorization?.replace('Bearer ', '');
        
        if (!token || !state.sessions[token]) {
          return [401, { error: 'Unauthorized' }];
        }
        
        const session = state.sessions[token];
        return {
          user: session.user,
          profile: session.profile,
          loginTime: session.loginTime,
          session: {
            active: true
          }
        };
      });
      
      mock('POST /auth/logout', ({ state, headers }) => {
        const token = headers.authorization?.replace('Bearer ', '');
        
        if (!token || !state.sessions[token]) {
          return [401, { error: 'Unauthorized' }];
        }
        
        delete state.sessions[token];
        return { message: 'Logged out successfully' };
      });
    });

    When("I login with username {string} and password {string}", async (_, username: string, password: string) => {
      response = await mock.handle("POST", "/auth/login", {
        body: { username, password }
      });
      if (response.body.token) {
        sessionToken = response.body.token;
      }
    });

    Then("I should receive a session token", () => {
      expect(response.body.token).toBeDefined();
      expect(typeof response.body.token).toBe('string');
      expect(response.body.token.length).toBeGreaterThan(0);
    });

    And("the response should contain user info with role {string}", (_, expectedRole: string) => {
      expect(response.body.user).toBeDefined();
      expect(response.body.user.role).toBe(expectedRole);
    });

    When("I request {string} with the session token", async (_, path: string) => {
      response = await mock.handle("GET", path, {
        headers: { authorization: `Bearer ${sessionToken}` }
      });
    });

    Then("I should get my profile information", () => {
      expect(response.body.user).toBeDefined();
      expect(response.body.session).toBeDefined();
    });

    And("the session should be marked as active", () => {
      expect(response.body.session.active).toBe(true);
    });

    When("I logout with the session token", async () => {
      response = await mock.handle("POST", "/auth/logout", {
        headers: { authorization: `Bearer ${sessionToken}` }
      });
    });

    Then("the logout should be successful", () => {
      expect(response.body.message).toContain("Logged out successfully");
    });

    When("I request {string} with the same token", async (_, path: string) => {
      response = await mock.handle("GET", path, {
        headers: { authorization: `Bearer ${sessionToken}` }
      });
    });

    Then("I should get a {int} unauthorized response", (_, expectedStatus: number) => {
      expect(response.status).toBe(expectedStatus);
    });
  });

  Scenario("Multi-user state isolation", ({ Given, When, Then, And }) => {
    Given("I create a multi-user counter mock:", (_, docString: string) => {
      // Create multi-user counter mock with new callable API
      const sharedState = { counters: {} };
      mock = schmock({ state: sharedState });
      
      mock('POST /counter/:userId/increment', ({ state, params }) => {
        const userId = params.userId;
        
        if (!state.counters[userId]) {
          state.counters[userId] = 0;
        }
        
        state.counters[userId]++;
        
        return {
          userId: userId,
          count: state.counters[userId],
          message: `Counter incremented for user ${userId}`
        };
      });
      
      mock('GET /counter/:userId', ({ state, params }) => {
        const userId = params.userId;
        const count = state.counters[userId] || 0;
        
        return {
          userId: userId,
          count: count
        };
      });
      
      mock('GET /counters/summary', ({ state }) => {
        const totalCount = Object.values(state.counters).reduce((sum: number, count: number) => sum + count, 0);
        const userCount = Object.keys(state.counters).length;
        
        return {
          totalCounts: totalCount,
          totalUsers: userCount,
          counters: state.counters
        };
      });
    });

    When("user {string} increments their counter {int} times", async (_, userId: string, times: number) => {
      for (let i = 0; i < times; i++) {
        await mock.handle("POST", `/counter/${userId}/increment`);
      }
    });

    And("user {string} increments their counter {int} times", async (_, userId: string, times: number) => {
      for (let i = 0; i < times; i++) {
        await mock.handle("POST", `/counter/${userId}/increment`);
      }
    });

    Then("{string}'s counter should be {int}", async (_, userId: string, expectedCount: number) => {
      const response = await mock.handle("GET", `/counter/${userId}`);
      expect(response.body.count).toBe(expectedCount);
    });

    And("{string}'s counter should be {int}", async (_, userId: string, expectedCount: number) => {
      const response = await mock.handle("GET", `/counter/${userId}`);
      expect(response.body.count).toBe(expectedCount);
    });

    And("the summary should show {int} total users", async (_, expectedUsers: number) => {
      const response = await mock.handle("GET", "/counters/summary");
      expect(response.body.totalUsers).toBe(expectedUsers);
    });

    And("the summary should show total counts of {int}", async (_, expectedTotal: number) => {
      const response = await mock.handle("GET", "/counters/summary");
      expect(response.body.totalCounts).toBe(expectedTotal);
    });

    And("each user's state should be independent", async () => {
      const aliceResponse = await mock.handle("GET", "/counter/alice");
      const bobResponse = await mock.handle("GET", "/counter/bob");
      
      expect(aliceResponse.body.count).toBe(3);
      expect(bobResponse.body.count).toBe(2);
      expect(aliceResponse.body.count).not.toBe(bobResponse.body.count);
    });
  });
});