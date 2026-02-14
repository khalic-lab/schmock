/// <reference path="../../packages/core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";
import { afterEach, describe, expect, it } from "vitest";
import { PETSTORE_SPEC, fetchJson } from "./helpers";

describe("Edge Cases", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => {
    mock?.close();
  });

  it("Unicode body round-trip", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: PETSTORE_SPEC }));

    const { port } = await mock.listen(0);

    const unicodeName = "Buddy🎉你好سلام";
    const created = await fetchJson(port, "/pets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: unicodeName, tag: "unicode" }),
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe(unicodeName);

    // Verify via GET
    const fetched = await fetchJson(port, `/pets/${created.body.petId}`);
    expect(fetched.body.name).toBe(unicodeName);
  });

  it("Unicode in path params", async () => {
    mock = schmock({ state: {} });
    mock("GET /items/:id", (ctx) => ({ id: ctx.params.id }));

    const { port } = await mock.listen(0);

    const res = await fetchJson(
      port,
      `/items/${encodeURIComponent("café-☕")}`,
    );
    expect(res.status).toBe(200);
    // The param is URL-encoded in the path
    expect(res.body).toHaveProperty("id");
  });

  it("Empty body POST", async () => {
    mock = schmock({ state: {} });
    mock("POST /empty", (ctx) => ({
      hasBody: ctx.body !== undefined,
    }));

    const { port } = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/empty`, {
      method: "POST",
      headers: { "content-length": "0" },
    });
    // Should not crash
    expect(res.status).toBe(200);
  });

  it("Null values in JSON body", async () => {
    mock = schmock({ state: {} });
    mock("POST /nulls", (ctx) => ctx.body);

    const { port } = await mock.listen(0);

    const res = await fetchJson(port, "/nulls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: null, value: 0, empty: "" }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: null, value: 0, empty: "" });
  });

  it("Huge payload (1MB JSON)", async () => {
    mock = schmock({ state: {} });
    mock("POST /big", (ctx) => {
      const body = ctx.body;
      return { count: Array.isArray(body) ? body.length : 0 };
    });

    const { port } = await mock.listen(0);

    // ~1MB: 10k items each with ~100 bytes
    const bigArray = Array.from({ length: 10_000 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      data: "x".repeat(80),
    }));

    const res = await fetchJson(port, "/big", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bigArray),
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(10_000);
  });

  it("Huge response (10K items)", async () => {
    const items = Array.from({ length: 10_000 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
    }));
    mock = schmock({ state: {} });
    mock("GET /many", items);

    const { port } = await mock.listen(0);

    const res = await fetchJson(port, "/many");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(10_000);
  });

  it("Concurrent requests (50 parallel)", async () => {
    mock = schmock({ state: {} });
    let counter = 0;
    mock("GET /counter", () => {
      counter++;
      return { value: counter };
    });

    const { port } = await mock.listen(0);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => fetchJson(port, "/counter")),
    );

    // All should resolve successfully
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => typeof r.body.value === "number")).toBe(true);
  });

  it("Concurrent mixed methods", async () => {
    mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: PETSTORE_SPEC }));

    const { port } = await mock.listen(0);

    // Fire 10 POSTs and 10 GETs concurrently
    const posts = Array.from({ length: 10 }, (_, i) =>
      fetchJson(port, "/pets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Pet-${i}`, tag: "test" }),
      }),
    );
    const gets = Array.from({ length: 10 }, () => fetchJson(port, "/pets"));

    const all = await Promise.all([...posts, ...gets]);
    const postResults = all.slice(0, 10);
    const getResults = all.slice(10);

    // All POSTs should succeed
    expect(postResults.every((r) => r.status === 201)).toBe(true);
    // All GETs should succeed
    expect(getResults.every((r) => r.status === 200)).toBe(true);
  });

  it("Malformed JSON body", async () => {
    mock = schmock({ state: {} });
    mock("POST /parse", (ctx) => ({ body: ctx.body }));

    const { port } = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    // Should not crash the server
    expect([200, 400, 500]).toContain(res.status);
  });

  it("Missing Content-Type header", async () => {
    mock = schmock({ state: {} });
    mock("POST /noct", (ctx) => ({
      bodyType: typeof ctx.body,
      hasBody: ctx.body !== undefined,
    }));

    const { port } = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/noct`, {
      method: "POST",
      body: "hello raw",
    });
    // Should not crash
    expect([200, 400]).toContain(res.status);
  });

  it("Trailing slash normalization", async () => {
    mock = schmock({ state: {} });
    mock("GET /items", [{ id: 1 }]);

    const { port } = await mock.listen(0);

    const withSlash = await fetchJson(port, "/items/");
    const withoutSlash = await fetchJson(port, "/items");

    // Both should match
    expect(withoutSlash.status).toBe(200);
    expect(withSlash.status).toBe(200);
  });

  it("Unknown HTTP method on spec with only GET returns 404", async () => {
    mock = schmock({ state: {} });
    mock("GET /readonly", { data: "ok" });

    const res = await mock.handle("PATCH", "/readonly");
    expect(res.status).toBe(404);
  });

  it("Very long URL path returns 404 without regex catastrophe", async () => {
    mock = schmock({ state: {} });
    mock("GET /a", { ok: true });

    const { port } = await mock.listen(0);

    const longPath =
      "/" + Array.from({ length: 100 }, (_, i) => `seg${i}`).join("/");
    const start = Date.now();
    const res = await fetchJson(port, longPath);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(404);
    expect(elapsed).toBeLessThan(5000);
  });

  it("Special chars in query params", async () => {
    mock = schmock({ state: {} });
    mock("GET /search", (ctx) => ({ q: ctx.query.q, tags: ctx.query.tags }));

    const { port } = await mock.listen(0);

    const res = await fetchJson(port, "/search?q=hello%20world&tags=a%2Cb");
    expect(res.status).toBe(200);
    expect(res.body.q).toBe("hello world");
    expect(res.body.tags).toBe("a,b");
  });

  it("Headers case insensitivity in security", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Auth Test", version: "1.0.0" },
          components: {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
          },
          security: [{ bearerAuth: [] }],
          paths: {
            "/test": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { ok: { type: "boolean" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        security: true,
      }),
    );

    const { port } = await mock.listen(0);

    // Lowercase header
    const lower = await fetchJson(port, "/test", {
      headers: { authorization: "Bearer token123" },
    });
    expect(lower.status).toBe(200);
  });

  it("Port reuse after close", async () => {
    mock = schmock({ state: {} });
    mock("GET /ping", { pong: true });

    const { port } = await mock.listen(0);
    mock.close();

    // Re-listen on same port should work
    await mock.listen(port);
    const res = await fetchJson(port, "/ping");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
  });

  it("Multiple listen calls throws", async () => {
    mock = schmock({ state: {} });
    mock("GET /test", { ok: true });

    await mock.listen(0);

    // listen() throws synchronously if server already exists
    expect(() => mock.listen(0)).toThrow(/already running/i);
  });
});
