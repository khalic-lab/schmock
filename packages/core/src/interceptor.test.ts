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

  it("returns browser binary bodies without JSON serialization", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    mock("GET /api/binary", bytes);
    const handle = mock.intercept();

    try {
      const response = await fetch("http://localhost/api/binary");
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      handle.restore();
    }
  });

  it("returns dynamic binary bodies with binary content type", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    mock("GET /api/dynamic-binary", () => bytes.buffer);
    const handle = mock.intercept();

    try {
      const response = await fetch("http://localhost/api/dynamic-binary");
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      handle.restore();
    }
  });

  it("returns tuple binary bodies with binary content type", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    mock(
      "GET /api/tuple-binary",
      () => [206, new DataView(bytes.buffer)] satisfies [number, unknown],
    );
    const handle = mock.intercept();

    try {
      const response = await fetch("http://localhost/api/tuple-binary");
      expect(response.status).toBe(206);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      handle.restore();
    }
  });

  it("normalizes a binary body supplied by beforeResponse", async () => {
    mock("GET /api/source", "source");
    const sharedBytes = new Uint8Array(new SharedArrayBuffer(3));
    sharedBytes.set([10, 11, 12]);
    const handle = mock.intercept({
      beforeResponse: () => ({
        status: 200,
        body: new DataView(sharedBytes.buffer),
        headers: {},
      }),
    });

    try {
      const response = await fetch("http://localhost/api/source");
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array([10, 11, 12]),
      );
    } finally {
      handle.restore();
    }
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
    mock("GET /api/users", ({ headers }) => [
      200,
      { token: headers["x-token"] },
    ]);
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
      beforeResponse: (resp) => ({
        ...resp,
        headers: { ...resp.headers, "x-mock": "true" },
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

  it("normalizes header keys to lowercase", async () => {
    mock("POST /api/data", ({ headers }) => [
      200,
      { auth: headers.authorization, ct: headers["content-type"] },
    ]);
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/data", {
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(await res.json()).toEqual({
      auth: "Bearer tok",
      ct: "application/json",
    });

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

  it("intercepts fetch called with a Request object", async () => {
    mock("GET /api/users", [{ id: 1, name: "Alice" }]);
    const handle = mock.intercept();

    const req = new Request("http://localhost/api/users");
    const res = await fetch(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 1, name: "Alice" }]);

    handle.restore();
  });

  it("prefers init.headers over Request.headers", async () => {
    mock("GET /api/data", ({ headers }) => [200, { val: headers["x-custom"] }]);
    const handle = mock.intercept();

    const req = new Request("http://localhost/api/data", {
      headers: { "X-Custom": "from-request" },
    });
    const res = await fetch(req, {
      headers: { "X-Custom": "from-init" },
    });
    expect(await res.json()).toEqual({ val: "from-init" });

    handle.restore();
  });

  it("parses URLSearchParams body", async () => {
    mock("POST /api/form", ({ body }) => [200, body]);
    const handle = mock.intercept();

    const params = new URLSearchParams();
    params.set("name", "Alice");
    params.set("role", "admin");

    const res = await fetch("http://localhost/api/form", {
      method: "POST",
      body: params,
    });
    expect(await res.json()).toEqual({ name: "Alice", role: "admin" });

    handle.restore();
  });

  it("baseUrl /api should NOT match /apiv2 (segment boundary)", async () => {
    mock("GET /apiv2/data", [{ v2: true }]);
    const savedFetch = globalThis.fetch;
    const handle = mock.intercept({ baseUrl: "/api" });

    // /apiv2/data does not start with "/api/" — it should passthrough
    await fetch("http://localhost/apiv2/data");
    expect(savedFetch).toHaveBeenCalled();

    handle.restore();
  });

  it("baseUrl with trailing slash matches the same routes as without", async () => {
    mock("GET /api/items", [{ id: 1 }]);

    // Without trailing slash
    const handle1 = mock.intercept({ baseUrl: "/api" });
    const res1 = await fetch("http://localhost/api/items");
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual([{ id: 1 }]);
    handle1.restore();

    // With trailing slash — should still match /api/items
    const handle2 = mock.intercept({ baseUrl: "/api/" });
    const res2 = await fetch("http://localhost/api/items");
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual([{ id: 1 }]);
    handle2.restore();
  });

  it("extractBody: init.body wins over Request.body per Fetch spec", async () => {
    mock("POST /api/data", ({ body }) => [200, body]);
    const handle = mock.intercept();

    const req = new Request("http://localhost/api/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "request" }),
    });

    const res = await fetch(req, {
      body: JSON.stringify({ source: "init" }),
    });
    expect(await res.json()).toEqual({ source: "init" });

    handle.restore();
  });

  it("extractBody: failed JSON parse falls back to text", async () => {
    mock("POST /api/text", ({ body }) => [200, { received: body }]);
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/text", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json-{broken",
    });

    const json = await res.json();
    expect(json.received).toBe("not-json-{broken");

    handle.restore();
  });

  it("composes mock instances newest-first and chains passthrough", async () => {
    const olderMock = schmock();
    olderMock("GET /api/shared", { source: "older" });
    olderMock("GET /api/older", { source: "older" });

    const newerMock = schmock();
    newerMock("GET /api/shared", { source: "newer" });

    const olderHandle = olderMock.intercept();
    const newerHandle = newerMock.intercept();

    try {
      const sharedResponse = await fetch("http://localhost/api/shared");
      expect(await sharedResponse.json()).toEqual({ source: "newer" });

      const olderResponse = await fetch("http://localhost/api/older");
      expect(await olderResponse.json()).toEqual({ source: "older" });
    } finally {
      newerHandle.restore();
      olderHandle.restore();
    }
  });

  it("keeps remaining interceptors installed after out-of-order restore", async () => {
    const baseline = globalThis.fetch;
    const olderMock = schmock();
    const newerMock = schmock();
    newerMock("GET /api/newer", { source: "newer" });

    const olderHandle = olderMock.intercept();
    const newerHandle = newerMock.intercept();

    olderHandle.restore();
    expect(olderHandle.active).toBe(false);
    expect(newerHandle.active).toBe(true);
    expect(globalThis.fetch).not.toBe(baseline);

    try {
      const response = await fetch("http://localhost/api/newer");
      expect(await response.json()).toEqual({ source: "newer" });
    } finally {
      newerHandle.restore();
    }

    expect(globalThis.fetch).toBe(baseline);
  });

  it("restores idempotently", () => {
    const baseline = globalThis.fetch;
    const handle = mock.intercept();

    handle.restore();
    handle.restore();

    expect(handle.active).toBe(false);
    expect(globalThis.fetch).toBe(baseline);
  });

  it("does not overwrite a fetch replacement installed after Schmock", () => {
    const handle = mock.intercept();
    const replacementFetch = vi
      .fn()
      .mockResolvedValue(new Response("third-party backend"));
    globalThis.fetch = replacementFetch;

    handle.restore();

    expect(globalThis.fetch).toBe(replacementFetch);
  });

  it("keeps a third-party wrapper's captured dispatcher usable", async () => {
    const baseline = globalThis.fetch;
    const handle = mock.intercept();
    const schmockDispatcher = globalThis.fetch;
    const replacementFetch = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        schmockDispatcher(input, init),
    );
    globalThis.fetch = replacementFetch;

    handle.restore();

    const response = await fetch("http://localhost/real-backend");
    expect(await response.text()).toBe("real backend");
    expect(replacementFetch).toHaveBeenCalledOnce();
    expect(baseline).toHaveBeenCalledOnce();
  });

  it("wraps the current fetch when a later interceptor follows a replacement", async () => {
    const olderMock = schmock();
    olderMock("GET /api/older", { source: "older" });
    const olderHandle = olderMock.intercept();

    const replacementFetch = vi
      .fn()
      .mockResolvedValue(new Response("third-party backend"));
    globalThis.fetch = replacementFetch;

    const newerMock = schmock();
    newerMock("GET /api/newer", { source: "newer" });
    const newerHandle = newerMock.intercept();

    olderHandle.restore();
    expect(olderHandle.active).toBe(false);
    expect(newerHandle.active).toBe(true);

    try {
      const mockedResponse = await fetch("http://localhost/api/newer");
      expect(await mockedResponse.json()).toEqual({ source: "newer" });

      const passthroughResponse = await fetch("http://localhost/real-backend");
      expect(await passthroughResponse.text()).toBe("third-party backend");
      expect(replacementFetch).toHaveBeenCalledOnce();
    } finally {
      newerHandle.restore();
    }

    expect(globalThis.fetch).toBe(replacementFetch);
  });
});
