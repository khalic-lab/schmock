import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { schmock } from "../index";
import type { CallableMockInstance } from "../types";

interface CartItem {
  id: number;
  name: string;
  price: number;
  quantity: number;
}

interface UserRecord {
  username: string;
  password: string;
  profile: { name: string; role: string };
}

interface SessionRecord {
  user: string;
  profile: { name: string; role: string };
  loginTime: string;
}

const feature = await loadFeature("../../features/stateful-workflows.feature");

describeFeature(feature, ({ Scenario }) => {
  let mock: CallableMockInstance;
  let response: any;
  let sessionToken: string;
  let addedItemIds: number[] = [];

  Scenario("Shopping cart workflow", ({ Given, When, Then, And }) => {
    addedItemIds = [];

    Given("I create a stateful shopping cart mock", () => {
      const items: CartItem[] = [];
      let total = 0;

      mock = schmock();
      mock("GET /cart", () => ({
        items,
        total,
        count: items.length,
      }));
      mock("POST /cart/add", ({ body }) => {
        const b = body as Record<string, unknown>;
        const item: CartItem = {
          id: Date.now(),
          name: b.name as string,
          price: b.price as number,
          quantity: (b.quantity as number) || 1,
        };
        items.push(item);
        total += item.price * item.quantity;
        return {
          message: "Item added to cart",
          added: item,
          cart: {
            items,
            total,
            count: items.length,
          },
        };
      });
      mock("DELETE /cart/:id", ({ params }) => {
        const itemId = parseInt(params.id);
        const itemIndex = items.findIndex((item) => item.id === itemId);
        if (itemIndex === -1) {
          return [404, { error: "Item not found in cart" }];
        }
        const removedItem = items[itemIndex];
        total -= removedItem.price * removedItem.quantity;
        items.splice(itemIndex, 1);
        return {
          message: "Item removed from cart",
          item: removedItem,
          cart: {
            items,
            total,
            count: items.length,
          },
        };
      });
      mock("POST /cart/clear", () => {
        items.length = 0;
        total = 0;
        return {
          message: "Cart cleared",
          cart: {
            items,
            total,
            count: items.length,
          },
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
      const body = cartResponse.body as { items: CartItem[]; total: number; count: number };
      expect(body.count).toBe(expectedCount);
    });

    Then("the cart should contain {int} item", async (_, expectedCount: number) => {
      const cartResponse = await mock.handle("GET", "/cart");
      const body = cartResponse.body as { items: CartItem[]; total: number; count: number };
      expect(body.count).toBe(expectedCount);
    });

    And("the initial cart total should be {string}", async (_, expectedTotalStr: string) => {
      const expectedTotal = parseFloat(expectedTotalStr);
      const cartResponse = await mock.handle("GET", "/cart");
      const body = cartResponse.body as { items: CartItem[]; total: number; count: number };
      expect(body.total).toBe(expectedTotal);
    });

    And("the final cart total should be {string}", async (_, expectedTotalStr: string) => {
      const expectedTotal = parseFloat(expectedTotalStr);
      const cartResponse = await mock.handle("GET", "/cart");
      const body = cartResponse.body as { items: CartItem[]; total: number; count: number };
      expect(body.total).toBe(expectedTotal);
    });

    When("I remove the first item from the cart", async () => {
      const cartResponse = await mock.handle("GET", "/cart");
      const body = cartResponse.body as { items: CartItem[]; total: number; count: number };
      const firstItemId = body.items[0].id;
      response = await mock.handle("DELETE", `/cart/${firstItemId}`);
    });
  });

  Scenario("User session simulation", ({ Given, When, Then, And }) => {
    sessionToken = "";

    Given("I create a session-based authentication mock", () => {
      const users: UserRecord[] = [
        { username: "admin", password: "secret", profile: { name: "Admin User", role: "administrator" } },
        { username: "user1", password: "pass123", profile: { name: "Regular User", role: "user" } },
      ];
      const sessions: Record<string, SessionRecord> = {};

      mock = schmock();
      mock("POST /auth/login", ({ body }) => {
        const b = body as Record<string, unknown>;
        const user = users.find((u) => u.username === b.username && u.password === b.password);
        if (!user) {
          return [401, { error: "Invalid credentials" }];
        }
        const token = "token-" + user.username + "-" + Date.now();
        sessions[token] = {
          user: user.username,
          profile: user.profile,
          loginTime: new Date().toISOString(),
        };
        return {
          message: "Login successful",
          token,
          user: user.profile,
        };
      });
      mock("GET /profile", ({ headers }) => {
        const token = headers.authorization ? headers.authorization.replace("Bearer ", "") : "";
        if (!token || !sessions[token]) {
          return [401, { error: "Unauthorized" }];
        }
        const session = sessions[token];
        return {
          user: session.user,
          profile: session.profile,
          loginTime: session.loginTime,
          session: {
            active: true,
          },
        };
      });
      mock("POST /auth/logout", ({ headers }) => {
        const token = headers.authorization ? headers.authorization.replace("Bearer ", "") : "";
        if (!token || !sessions[token]) {
          return [401, { error: "Unauthorized" }];
        }
        delete sessions[token];
        return { message: "Logged out successfully" };
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
    Given("I create a multi-user counter mock", () => {
      const counters: Record<string, number> = {};

      mock = schmock();
      mock("POST /counter/:userId/increment", ({ params }) => {
        const userId = params.userId;
        if (!counters[userId]) {
          counters[userId] = 0;
        }
        counters[userId]++;
        return {
          userId,
          count: counters[userId],
          message: "Counter incremented for user " + userId,
        };
      });
      mock("GET /counter/:userId", ({ params }) => {
        const userId = params.userId;
        const count = counters[userId] || 0;
        return {
          userId,
          count,
        };
      });
      mock("GET /counters/summary", () => {
        const totalCount = Object.values(counters).reduce((sum, count) => sum + count, 0);
        const userCount = Object.keys(counters).length;
        return {
          totalCounts: totalCount,
          totalUsers: userCount,
          counters,
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
      const body = response.body as { userId: string; count: number };
      expect(body.count).toBe(expectedCount);
    });

    And("{string}'s counter should be {int}", async (_, userId: string, expectedCount: number) => {
      const response = await mock.handle("GET", `/counter/${userId}`);
      const body = response.body as { userId: string; count: number };
      expect(body.count).toBe(expectedCount);
    });

    And("the summary should show {int} total users", async (_, expectedUsers: number) => {
      const response = await mock.handle("GET", "/counters/summary");
      const body = response.body as { totalCounts: number; totalUsers: number; counters: Record<string, number> };
      expect(body.totalUsers).toBe(expectedUsers);
    });

    And("the summary should show total counts of {int}", async (_, expectedTotal: number) => {
      const response = await mock.handle("GET", "/counters/summary");
      const body = response.body as { totalCounts: number; totalUsers: number; counters: Record<string, number> };
      expect(body.totalCounts).toBe(expectedTotal);
    });

    And("each user's state should be independent", async () => {
      const aliceResponse = await mock.handle("GET", "/counter/alice");
      const bobResponse = await mock.handle("GET", "/counter/bob");
      const aliceBody = aliceResponse.body as { userId: string; count: number };
      const bobBody = bobResponse.body as { userId: string; count: number };

      expect(aliceBody.count).toBe(3);
      expect(bobBody.count).toBe(2);
      expect(aliceBody.count).not.toBe(bobBody.count);
    });
  });
});
