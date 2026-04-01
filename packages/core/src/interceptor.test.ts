import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schmock } from "./index.js";

describe("mock.intercept()", () => {
  let originalFetch: typeof globalThis.fetch;
  let mock: Schmock.CallableMockInstance;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real backend"));
    mock = schmock();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("intercepts a matched fetch request and returns mocked response", async () => {
    mock("GET /api/users", [{ id: 1, name: "Alice" }]);
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/users");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1, name: "Alice" }]);

    handle.restore();
  });

  it("passes through unmatched routes when passthrough is true", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    // Save reference to the vi.fn() mock that the interceptor will call on passthrough
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const handle = mock.intercept({ passthrough: true });

    await fetch("http://localhost/api/other");
    // The interceptor saves the vi.fn() as its original and calls it on passthrough
    expect(mockFetch).toHaveBeenCalled();
    handle.restore();
  });

  it("returns 404 when passthrough is disabled and route not found", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept({ passthrough: false });

    const res = await fetch("http://localhost/api/other");
    expect(res.status).toBe(404);

    handle.restore();
  });

  it("restores original fetch", () => {
    const savedFetch = globalThis.fetch;
    const handle = mock.intercept();

    expect(globalThis.fetch).not.toBe(savedFetch);
    handle.restore();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("reports active status", () => {
    const handle = mock.intercept();
    expect(handle.active).toBe(true);

    handle.restore();
    expect(handle.active).toBe(false);
  });

  it("filters by baseUrl", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const savedFetch = globalThis.fetch;
    const handle = mock.intercept({ baseUrl: "/api" });

    await fetch("http://localhost/other/path");
    // Should have called the saved fetch (passthrough for non-matching baseUrl)
    expect(savedFetch).toHaveBeenCalled();

    handle.restore();
  });

  it("throws when intercepting twice", () => {
    const handle = mock.intercept();
    expect(() => mock.intercept()).toThrow(/already intercepting/i);
    handle.restore();
  });

  it("applies beforeRequest hook", async () => {
    mock("GET /api/users", ({ headers }) => [200, { token: headers["x-token"] }]);
    const handle = mock.intercept({
      beforeRequest: (req) => ({
        ...req,
        headers: { ...req.headers, "x-token": "injected" },
      }),
    });

    const res = await fetch("http://localhost/api/users");
    expect(await res.json()).toEqual({ token: "injected" });

    handle.restore();
  });

  it("applies beforeResponse hook", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept({
      beforeResponse: (res) => ({
        ...res,
        headers: { ...res.headers, "x-mock": "true" },
      }),
    });

    const res = await fetch("http://localhost/api/users");
    expect(res.headers.get("x-mock")).toBe("true");

    handle.restore();
  });

  it("handles relative URLs", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept();

    const res = await fetch("/api/users");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1 }]);

    handle.restore();
  });

  it("applies errorFormatter when beforeRequest throws", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept({
      beforeRequest: () => {
        throw new Error("hook failed");
      },
      errorFormatter: (err) => ({ custom: err.message }),
    });

    const res = await fetch("http://localhost/api/users");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ custom: "hook failed" });

    handle.restore();
  });

  it("parses JSON body from fetch init", async () => {
    mock("POST /api/users", ({ body }) => [201, body]);
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: "Alice" });

    handle.restore();
  });
});
