/// <reference path="../../packages/core/schmock.d.ts" />

/**
 * Integration tests for mock.intercept() — the fetch-interception primitive
 * that React (SchmockProvider) and Vue (schmockPlugin) adapters wrap.
 *
 * Tests run in Node environment (no jsdom needed) since globalThis.fetch
 * is available in modern Node/Bun and intercept() patches it directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schmock, notFound } from "@schmock/core";

describe("Fetch Intercept — adapter primitive (React/Vue code path)", () => {
  let originalFetch: typeof globalThis.fetch;
  let mock: Schmock.CallableMockInstance;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Replace real fetch with a spy so we can detect passthrough calls
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ source: "real" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    mock = schmock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ——— 1. Matched URL returns mock response ———

  it("intercept() patches globalThis.fetch — matched URL returns mock response", async () => {
    mock("GET /api/users", [{ id: 1, name: "Alice" }]);
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/users");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual([{ id: 1, name: "Alice" }]);

    handle.restore();
  });

  // ——— 2. Passthrough=true — unmatched URLs call original fetch ———

  it("intercept({ passthrough: true }) forwards unmatched URLs to original fetch", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const spyFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const handle = mock.intercept({ passthrough: true });

    const res = await fetch("http://localhost/api/unknown");
    expect(spyFetch).toHaveBeenCalled();

    const body = await res.json();
    expect(body).toEqual({ source: "real" });

    handle.restore();
  });

  // ——— 3. Passthrough=false — unmatched URLs return 404 ———

  it("intercept({ passthrough: false }) returns 404 for unmatched URLs", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept({ passthrough: false });

    const res = await fetch("http://localhost/api/unknown");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body).toHaveProperty("code", "ROUTE_NOT_FOUND");

    handle.restore();
  });

  // ——— 4. baseUrl — only intercepts matching prefix ———

  it("intercept({ baseUrl }) only intercepts URLs matching the prefix", async () => {
    mock("GET /api/items", [{ id: 42 }]);
    const spyFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const handle = mock.intercept({ baseUrl: "/api" });

    // Matching prefix — should return mock data
    const matched = await fetch("http://localhost/api/items");
    expect(matched.status).toBe(200);
    expect(await matched.json()).toEqual([{ id: 42 }]);

    // Non-matching prefix — should passthrough to original fetch
    await fetch("http://localhost/other/path");
    expect(spyFetch).toHaveBeenCalled();

    handle.restore();
  });

  it("baseUrl enforces segment boundary — /api does not match /apiv2", async () => {
    mock("GET /apiv2/data", [{ v2: true }]);
    const spyFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const handle = mock.intercept({ baseUrl: "/api" });

    await fetch("http://localhost/apiv2/data");
    // /apiv2 is not under /api segment boundary, so it passthroughs
    expect(spyFetch).toHaveBeenCalled();

    handle.restore();
  });

  // ——— 5. handle.restore() restores original fetch ———

  it("handle.restore() restores original fetch", () => {
    const fetchBeforeIntercept = globalThis.fetch;
    const handle = mock.intercept();

    // fetch was patched
    expect(globalThis.fetch).not.toBe(fetchBeforeIntercept);
    expect(handle.active).toBe(true);

    handle.restore();

    // fetch is back to what it was before intercept
    expect(globalThis.fetch).toBe(fetchBeforeIntercept);
    expect(handle.active).toBe(false);
  });

  it("restore() is idempotent — calling twice does not throw", () => {
    const handle = mock.intercept();
    handle.restore();
    expect(() => handle.restore()).not.toThrow();
    expect(handle.active).toBe(false);
  });

  // ——— 6. POST with JSON body through intercepted fetch ———

  it("POST with JSON body flows through intercepted fetch correctly", async () => {
    mock("POST /api/users", ({ body }) => [201, body]);
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bob", email: "bob@test.com" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toEqual({ name: "Bob", email: "bob@test.com" });

    // Verify spy recorded the request
    expect(mock.called("POST", "/api/users")).toBe(true);
    expect(mock.lastRequest("POST", "/api/users")?.body).toEqual({
      name: "Bob",
      email: "bob@test.com",
    });

    handle.restore();
  });

  it("POST echoes nested objects and arrays correctly", async () => {
    mock("POST /api/data", ({ body }) => [200, body]);
    const handle = mock.intercept();

    const payload = {
      items: [{ id: 1 }, { id: 2 }],
      meta: { page: 1, total: 2 },
    };

    const res = await fetch("http://localhost/api/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(await res.json()).toEqual(payload);

    handle.restore();
  });

  // ——— 7. Error status codes flow through intercepted fetch ———

  it("error status codes flow through intercepted fetch correctly", async () => {
    mock("GET /api/forbidden", [403, { error: "Forbidden" }]);
    mock("GET /api/error", [500, { error: "Internal Server Error" }]);
    mock("DELETE /api/items/99", () => notFound("Item not found"));

    const handle = mock.intercept();

    const res403 = await fetch("http://localhost/api/forbidden");
    expect(res403.status).toBe(403);
    expect(await res403.json()).toEqual({ error: "Forbidden" });

    const res500 = await fetch("http://localhost/api/error");
    expect(res500.status).toBe(500);
    expect(await res500.json()).toEqual({ error: "Internal Server Error" });

    const res404 = await fetch("http://localhost/api/items/99", {
      method: "DELETE",
    });
    expect(res404.status).toBe(404);

    handle.restore();
  });

  it("custom headers in error responses are preserved", async () => {
    mock("GET /api/rate-limited", [
      429,
      { error: "Too Many Requests" },
      { "retry-after": "60" },
    ]);
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/rate-limited");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");

    handle.restore();
  });

  // ——— 8. Multiple sequential intercept/restore cycles ———

  it("multiple sequential intercept/restore cycles work correctly", async () => {
    // Cycle 1
    mock("GET /api/cycle", { cycle: 1 });
    const handle1 = mock.intercept();

    const res1 = await fetch("http://localhost/api/cycle");
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ cycle: 1 });

    handle1.restore();
    expect(handle1.active).toBe(false);

    // Between cycles: original fetch is restored
    const spyFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    await fetch("http://localhost/api/cycle");
    expect(spyFetch).toHaveBeenCalled();

    // Cycle 2 — re-register a different response
    mock.reset();
    mock("GET /api/cycle", { cycle: 2 });
    const handle2 = mock.intercept();

    const res2 = await fetch("http://localhost/api/cycle");
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ cycle: 2 });

    handle2.restore();

    // Cycle 3 — yet another cycle with different method
    mock.reset();
    mock("POST /api/cycle", ({ body }) => [201, body]);
    const handle3 = mock.intercept();

    const res3 = await fetch("http://localhost/api/cycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycle: 3 }),
    });
    expect(res3.status).toBe(201);
    expect(await res3.json()).toEqual({ cycle: 3 });

    handle3.restore();
  });

  // ——— Additional: stateful mock through intercept (simulates real app) ———

  it("stateful CRUD through intercepted fetch (real-world adapter pattern)", async () => {
    interface Todo {
      id: number;
      title: string;
      done: boolean;
    }

    const statefulMock = schmock({
      state: {
        todos: [
          { id: 1, title: "Buy milk", done: false },
          { id: 2, title: "Write tests", done: true },
        ] as Todo[],
        nextId: 3,
      },
    });

    statefulMock("GET /api/todos", ({ state }) => state.todos);

    statefulMock("POST /api/todos", ({ body, state }) => {
      const b = body as { title: string; done: boolean };
      const todo = {
        id: (state as any).nextId++,
        title: b.title,
        done: b.done,
      };
      (state as any).todos.push(todo);
      return [201, todo];
    });

    statefulMock("PATCH /api/todos/:id", ({ params, body, state }) => {
      const todos = (state as any).todos as Todo[];
      const todo = todos.find((t) => t.id === Number(params.id));
      if (!todo) return notFound("Todo not found");
      Object.assign(todo, body);
      return todo;
    });

    statefulMock("DELETE /api/todos/:id", ({ params, state }) => {
      const todos = (state as any).todos as Todo[];
      const idx = todos.findIndex((t) => t.id === Number(params.id));
      if (idx === -1) return notFound("Todo not found");
      todos.splice(idx, 1);
      return [204, null];
    });

    const handle = statefulMock.intercept();

    // GET — initial list
    const listRes = await fetch("http://localhost/api/todos");
    expect(listRes.status).toBe(200);
    const initialTodos = await listRes.json();
    expect(initialTodos).toHaveLength(2);

    // POST — create todo
    const createRes = await fetch("http://localhost/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Ship it", done: false }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created).toEqual({ id: 3, title: "Ship it", done: false });

    // GET — list now has 3 items
    const updatedList = await (
      await fetch("http://localhost/api/todos")
    ).json();
    expect(updatedList).toHaveLength(3);

    // PATCH — toggle done
    const patchRes = await fetch("http://localhost/api/todos/3", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toMatchObject({ id: 3, done: true });

    // DELETE — remove todo
    const deleteRes = await fetch("http://localhost/api/todos/3", {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(204);

    // GET — back to 2
    const finalList = await (
      await fetch("http://localhost/api/todos")
    ).json();
    expect(finalList).toHaveLength(2);

    // Spy: all operations tracked
    expect(statefulMock.callCount("GET", "/api/todos")).toBe(3);
    expect(statefulMock.callCount("POST", "/api/todos")).toBe(1);
    expect(statefulMock.callCount("PATCH", "/api/todos/3")).toBe(1);
    expect(statefulMock.callCount("DELETE", "/api/todos/3")).toBe(1);

    handle.restore();
  });

  // ——— Intercept hooks (used by adapter options) ———

  it("beforeRequest hook modifies request before routing", async () => {
    mock("GET /api/users", ({ headers }) => [
      200,
      { token: headers["x-token"] },
    ]);
    const handle = mock.intercept({
      beforeRequest: (req) => ({
        ...req,
        headers: { ...req.headers, "x-token": "injected-by-adapter" },
      }),
    });

    const res = await fetch("http://localhost/api/users");
    expect(await res.json()).toEqual({ token: "injected-by-adapter" });

    handle.restore();
  });

  it("beforeResponse hook modifies response before returning", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept({
      beforeResponse: (resp) => ({
        ...resp,
        headers: { ...resp.headers, "x-adapter": "schmock" },
      }),
    });

    const res = await fetch("http://localhost/api/users");
    expect(res.headers.get("x-adapter")).toBe("schmock");

    handle.restore();
  });

  it("errorFormatter catches interceptor-layer errors (e.g. beforeRequest throws)", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept({
      beforeRequest: () => {
        throw new Error("hook exploded");
      },
      errorFormatter: (err) => ({
        message: err.message,
        type: "ADAPTER_ERROR",
      }),
    });

    const res = await fetch("http://localhost/api/users");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      message: "hook exploded",
      type: "ADAPTER_ERROR",
    });

    handle.restore();
  });

  it("generator errors surface as 500 with internal error format", async () => {
    mock("GET /api/users", () => {
      throw new Error("generator exploded");
    });
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/users");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error", "generator exploded");
    expect(body).toHaveProperty("code", "INTERNAL_ERROR");

    handle.restore();
  });

  // ——— Duplicate intercept guard ———

  it("calling intercept() twice throws without restoring first", () => {
    const handle = mock.intercept();
    expect(() => mock.intercept()).toThrow(/already intercepting/i);
    handle.restore();
  });

  // ——— Request object support (used by some frameworks) ———

  it("intercept works with Request objects", async () => {
    mock("GET /api/data", { value: 42 });
    const handle = mock.intercept();

    const req = new Request("http://localhost/api/data");
    const res = await fetch(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 42 });

    handle.restore();
  });

  // ——— Query parameters through intercept ———

  it("query parameters are passed through to route handlers", async () => {
    mock("GET /api/search", ({ query }) => [
      200,
      { q: query.q, page: query.page },
    ]);
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/search?q=hello&page=2");
    expect(await res.json()).toEqual({ q: "hello", page: "2" });

    handle.restore();
  });
});
