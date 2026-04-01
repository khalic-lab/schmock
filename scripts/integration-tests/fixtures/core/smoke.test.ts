import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  schmock,
  isRouteNotFound,
  notFound,
  badRequest,
  created,
  noContent,
  paginate,
} from "@schmock/core";

describe("mock.intercept() real-world patterns", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real backend"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("handles concurrent parallel fetches", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1 }]);
    mock("GET /api/posts", [{ id: 10, title: "Hello" }]);
    mock("GET /api/tags", ["a", "b", "c"]);
    const handle = mock.intercept();

    const [users, posts, tags] = await Promise.all([
      fetch("http://localhost/api/users").then((r) => r.json()),
      fetch("http://localhost/api/posts").then((r) => r.json()),
      fetch("http://localhost/api/tags").then((r) => r.json()),
    ]);

    expect(users).toEqual([{ id: 1 }]);
    expect(posts).toEqual([{ id: 10, title: "Hello" }]);
    expect(tags).toEqual(["a", "b", "c"]);
    expect(mock.callCount()).toBe(3);

    handle.restore();
  });

  it("isolates interceptors between tests — no leaking", async () => {
    const mock1 = schmock();
    mock1("GET /api/data", { source: "mock1" });
    const h1 = mock1.intercept();

    const r1 = await fetch("http://localhost/api/data");
    expect(await r1.json()).toEqual({ source: "mock1" });
    h1.restore();

    // Second interceptor with different data on the same route
    const mock2 = schmock();
    mock2("GET /api/data", { source: "mock2" });
    const h2 = mock2.intercept();

    const r2 = await fetch("http://localhost/api/data");
    expect(await r2.json()).toEqual({ source: "mock2" });
    h2.restore();
  });

  it("preserves query parameters through intercept", async () => {
    const mock = schmock();
    mock("GET /api/search", ({ query }) => ({
      q: query.q,
      page: query.page,
      sort: query.sort,
    }));
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/search?q=hello&page=2&sort=name");
    expect(await res.json()).toEqual({ q: "hello", page: "2", sort: "name" });

    handle.restore();
  });

  it("preserves custom headers through intercept", async () => {
    const mock = schmock();
    // When passing a plain object to fetch, header keys preserve original casing
    mock("GET /api/protected", ({ headers }) => ({
      auth: headers.Authorization ?? headers.authorization,
      custom: headers["X-Custom"] ?? headers["x-custom"],
    }));
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/protected", {
      headers: {
        Authorization: "Bearer token123",
        "X-Custom": "value",
      },
    });
    const body = await res.json();
    expect(body.auth).toBe("Bearer token123");
    expect(body.custom).toBe("value");

    handle.restore();
  });

  it("handles all HTTP methods", async () => {
    const mock = schmock();
    mock("GET /api/r", () => [200, { method: "GET" }]);
    mock("POST /api/r", () => [201, { method: "POST" }]);
    mock("PUT /api/r", () => [200, { method: "PUT" }]);
    mock("PATCH /api/r", () => [200, { method: "PATCH" }]);
    mock("DELETE /api/r", () => [204, null]);
    const handle = mock.intercept();

    for (const method of ["GET", "POST", "PUT", "PATCH"] as const) {
      const res = await fetch("http://localhost/api/r", { method });
      const body = await res.json();
      expect(body.method).toBe(method);
    }

    const del = await fetch("http://localhost/api/r", { method: "DELETE" });
    expect(del.status).toBe(204);

    expect(mock.callCount()).toBe(5);
    handle.restore();
  });

  it("handles error status codes correctly", async () => {
    const mock = schmock();
    mock("GET /api/not-found", notFound("gone"));
    mock("POST /api/invalid", badRequest("bad input"));
    mock("GET /api/item", created({ id: 1 }));
    mock("DELETE /api/item/1", noContent());
    const handle = mock.intercept();

    const r1 = await fetch("http://localhost/api/not-found");
    expect(r1.status).toBe(404);
    expect(await r1.json()).toEqual({ message: "gone" });

    const r2 = await fetch("http://localhost/api/invalid", { method: "POST" });
    expect(r2.status).toBe(400);

    const r3 = await fetch("http://localhost/api/item");
    expect(r3.status).toBe(201);

    const r4 = await fetch("http://localhost/api/item/1", { method: "DELETE" });
    expect(r4.status).toBe(204);

    handle.restore();
  });

  it("baseUrl only intercepts matching paths", async () => {
    const mock = schmock();
    mock("GET /api/data", { intercepted: true });
    const fakeFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const handle = mock.intercept({ baseUrl: "/api" });

    // Matching path — intercepted
    const r1 = await fetch("http://localhost/api/data");
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ intercepted: true });
    expect(fakeFetch).not.toHaveBeenCalled();

    // Non-matching path — passthrough
    await fetch("http://localhost/other/path");
    expect(fakeFetch).toHaveBeenCalledTimes(1);

    await fetch("http://localhost/apifake");
    expect(fakeFetch).toHaveBeenCalledTimes(2);

    handle.restore();
  });

  it("request/response hooks compose correctly", async () => {
    const mock = schmock();
    mock("GET /api/data", ({ headers }) => ({
      injectedBy: headers["x-injected"],
    }));
    const handle = mock.intercept({
      beforeRequest: (req) => ({
        ...req,
        headers: { ...req.headers, "x-injected": "hook" },
      }),
      beforeResponse: (res, req) => ({
        ...res,
        body: { ...(res.body as object), path: req.path },
        headers: { ...res.headers, "x-processed": "true" },
      }),
    });

    const res = await fetch("http://localhost/api/data");
    expect(res.headers.get("x-processed")).toBe("true");
    const body = await res.json();
    expect(body.injectedBy).toBe("hook");
    expect(body.path).toBe("/api/data");

    handle.restore();
  });

  it("spy API tracks requests accurately across routes", async () => {
    const mock = schmock();
    mock("GET /api/users", []);
    mock("GET /api/users/:id", ({ params }) => ({ id: params.id }));
    mock("POST /api/users", ({ body }) => [201, body]);
    const handle = mock.intercept();

    await fetch("http://localhost/api/users");
    await fetch("http://localhost/api/users");
    await fetch("http://localhost/api/users/5");
    await fetch("http://localhost/api/users", {
      method: "POST",
      body: JSON.stringify({ name: "A" }),
    });

    expect(mock.callCount()).toBe(4);
    expect(mock.callCount("GET", "/api/users")).toBe(2);
    expect(mock.callCount("GET", "/api/users/5")).toBe(1);
    expect(mock.callCount("POST", "/api/users")).toBe(1);
    expect(mock.called("DELETE", "/api/users")).toBe(false);

    const last = mock.lastRequest("POST", "/api/users");
    expect(last).toBeDefined();

    const history = mock.history("GET", "/api/users");
    expect(history).toHaveLength(2);

    handle.restore();
  });

  it("reset clears everything for fresh test state", async () => {
    const mock = schmock({ state: { counter: 0 } });
    mock("POST /api/inc", ({ state }) => {
      (state as Record<string, number>).counter++;
      return { counter: (state as Record<string, number>).counter };
    });
    const handle = mock.intercept();

    await fetch("http://localhost/api/inc", { method: "POST" });
    await fetch("http://localhost/api/inc", { method: "POST" });
    expect(mock.callCount()).toBe(2);

    handle.restore();
    mock.reset();

    expect(mock.callCount()).toBe(0);
    expect(mock.history()).toHaveLength(0);
    expect(mock.getRoutes()).toHaveLength(0);
  });

  it("paginate works as route generator", async () => {
    const allItems = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    const mock = schmock();
    mock("GET /api/items", ({ query }) =>
      paginate(allItems, {
        page: Number(query.page || "1"),
        pageSize: Number(query.pageSize || "10"),
      }),
    );
    const handle = mock.intercept();

    const r1 = await fetch("http://localhost/api/items?page=1&pageSize=10");
    const p1 = await r1.json();
    expect(p1.data).toHaveLength(10);
    expect(p1.total).toBe(25);
    expect(p1.totalPages).toBe(3);

    const r2 = await fetch("http://localhost/api/items?page=3&pageSize=10");
    const p2 = await r2.json();
    expect(p2.data).toHaveLength(5);

    handle.restore();
  });
});
