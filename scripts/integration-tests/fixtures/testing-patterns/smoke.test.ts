/**
 * E2E: Common testing patterns that users will reach for.
 *
 * These are the patterns from docs/testing.md that every user will try.
 * If any of these fail, people will give up and use MSW instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { schmock, notFound, created, noContent, paginate } from "@schmock/core";
import { fakerPlugin } from "@schmock/faker";

describe("Pattern: shared mock with beforeEach/afterEach", () => {
  let mock: ReturnType<typeof schmock>;
  let handle: ReturnType<ReturnType<typeof schmock>["intercept"]>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("fallback"));

    mock = schmock();
    mock("GET /api/users", [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    mock("POST /api/users", ({ body }) => created(body as object));
    mock("DELETE /api/users/:id", noContent());
    mock("GET /api/users/:id", ({ params }) => {
      if (params.id === "999") return notFound("User not found");
      return { id: Number(params.id), name: `User ${params.id}` };
    });
    handle = mock.intercept();
  });

  afterEach(() => {
    handle.restore();
    globalThis.fetch = originalFetch;
  });

  it("fetches user list", async () => {
    const res = await fetch("http://localhost/api/users");
    expect(await res.json()).toHaveLength(2);
  });

  it("creates a user", async () => {
    const res = await fetch("http://localhost/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 3, name: "Charlie" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 3, name: "Charlie" });
  });

  it("deletes a user", async () => {
    const res = await fetch("http://localhost/api/users/1", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("returns 404 for missing user", async () => {
    const res = await fetch("http://localhost/api/users/999");
    expect(res.status).toBe(404);
  });

  it("spy: verifies which endpoints were called", async () => {
    await fetch("http://localhost/api/users");
    await fetch("http://localhost/api/users/1");

    expect(mock.called("GET", "/api/users")).toBe(true);
    expect(mock.called("GET", "/api/users/1")).toBe(true);
    expect(mock.called("POST", "/api/users")).toBe(false);
    expect(mock.callCount()).toBe(2);
  });

  it("spy: inspects request body of last POST", async () => {
    await fetch("http://localhost/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Dave" }),
    });

    const last = mock.lastRequest("POST", "/api/users");
    expect(last).toBeDefined();
    expect(last?.body).toEqual({ name: "Dave" });
  });

  it("history: no bleed between tests", () => {
    // Each test starts fresh because mock is recreated in beforeEach
    expect(mock.callCount()).toBe(0);
  });
});

describe("Pattern: stateful mock (counter, DB simulation)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("fallback"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("simulates a mini database with state", async () => {
    const mock = schmock({
      state: {
        users: [{ id: 1, name: "Alice" }] as Array<{ id: number; name: string }>,
        nextId: 2,
      },
    });

    mock("GET /api/users", ({ state }) => state.users);
    mock("POST /api/users", ({ body, state }) => {
      const user = { id: (state as any).nextId++, ...(body as object) };
      (state as any).users.push(user);
      return [201, user];
    });
    mock("DELETE /api/users/:id", ({ params, state }) => {
      const users = (state as any).users as Array<{ id: number }>;
      const idx = users.findIndex((u) => u.id === Number(params.id));
      if (idx === -1) return notFound("User not found");
      users.splice(idx, 1);
      return [204, null];
    });

    const handle = mock.intercept();

    // Start with 1 user
    let res = await fetch("http://localhost/api/users");
    let users = await res.json();
    expect(users).toHaveLength(1);

    // Create 2 more
    await fetch("http://localhost/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bob" }),
    });
    await fetch("http://localhost/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Charlie" }),
    });

    res = await fetch("http://localhost/api/users");
    users = await res.json();
    expect(users).toHaveLength(3);
    expect(users[2].name).toBe("Charlie");
    expect(users[2].id).toBe(3);

    // Delete one
    await fetch("http://localhost/api/users/1", { method: "DELETE" });

    res = await fetch("http://localhost/api/users");
    users = await res.json();
    expect(users).toHaveLength(2);
    expect(users[0].name).toBe("Bob");

    handle.restore();
  });
});

describe("Pattern: faker plugin for realistic data", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("fallback"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("generates realistic user data from schema", async () => {
    const mock = schmock();
    mock("GET /api/users", null, { contentType: "application/json" }).pipe(
      fakerPlugin({
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
              email: { type: "string", format: "email" },
            },
            required: ["id", "name", "email"],
          },
        },
      }),
    );

    const handle = mock.intercept();
    const res = await fetch("http://localhost/api/users");
    const users = await res.json();

    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThan(0);
    expect(typeof users[0].id).toBe("number");
    expect(typeof users[0].name).toBe("string");
    expect(users[0].email).toContain("@");

    handle.restore();
  });
});

describe("Pattern: paginated API", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("fallback"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("simulates paginated endpoint with paginate helper", async () => {
    const allArticles = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      title: `Article ${i + 1}`,
    }));

    const mock = schmock();
    mock("GET /api/articles", ({ query }) =>
      paginate(allArticles, {
        page: Number(query.page || "1"),
        pageSize: Number(query.pageSize || "10"),
      }),
    );

    const handle = mock.intercept();

    // Page 1
    const r1 = await fetch("http://localhost/api/articles?page=1&pageSize=10");
    const p1 = await r1.json();
    expect(p1.data).toHaveLength(10);
    expect(p1.data[0].title).toBe("Article 1");
    expect(p1.total).toBe(50);
    expect(p1.totalPages).toBe(5);
    expect(p1.page).toBe(1);

    // Page 5 (last page)
    const r5 = await fetch("http://localhost/api/articles?page=5&pageSize=10");
    const p5 = await r5.json();
    expect(p5.data).toHaveLength(10);
    expect(p5.data[0].title).toBe("Article 41");

    // Page 6 (beyond range)
    const r6 = await fetch("http://localhost/api/articles?page=6&pageSize=10");
    const p6 = await r6.json();
    expect(p6.data).toHaveLength(0);
    expect(p6.total).toBe(50);

    // Custom page size
    const r = await fetch("http://localhost/api/articles?page=1&pageSize=25");
    const p = await r.json();
    expect(p.data).toHaveLength(25);
    expect(p.totalPages).toBe(2);

    handle.restore();
  });
});

describe("Pattern: multiple mocks for different test scenarios", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("fallback"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("happy path: all APIs succeed", async () => {
    const mock = schmock();
    mock("GET /api/config", { features: ["dark-mode", "beta"] });
    mock("GET /api/user", { id: 1, name: "Alice", plan: "pro" });
    mock("GET /api/notifications", [{ id: 1, text: "Welcome!" }]);

    const handle = mock.intercept();

    const [config, user, notifs] = await Promise.all([
      fetch("http://localhost/api/config").then((r) => r.json()),
      fetch("http://localhost/api/user").then((r) => r.json()),
      fetch("http://localhost/api/notifications").then((r) => r.json()),
    ]);

    expect(config.features).toContain("dark-mode");
    expect(user.plan).toBe("pro");
    expect(notifs).toHaveLength(1);

    handle.restore();
  });

  it("degraded: one API fails, others work", async () => {
    const mock = schmock();
    mock("GET /api/config", { features: [] });
    mock("GET /api/user", [500, { message: "DB timeout" }]);
    mock("GET /api/notifications", []);

    const handle = mock.intercept();

    const config = await fetch("http://localhost/api/config");
    expect(config.ok).toBe(true);

    const user = await fetch("http://localhost/api/user");
    expect(user.ok).toBe(false);
    expect(user.status).toBe(500);

    const notifs = await fetch("http://localhost/api/notifications");
    expect(notifs.ok).toBe(true);

    handle.restore();
  });
});
