import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schmock } from "./index.js";
import { createFetchInterceptor } from "./interceptor.js";

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

  it("does not give relative inputs a synthetic origin for baseUrl matching", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const savedFetch = globalThis.fetch;
    const handle = mock.intercept({
      baseUrl: "https://api.example.com",
    });

    try {
      await fetch("/api/users");
      expect(savedFetch).toHaveBeenCalledOnce();
      const [passthroughInput, ...remainingArguments] =
        savedFetch.mock.calls[0];
      expect(remainingArguments).toEqual([]);
      expect(passthroughInput).toBeInstanceOf(Request);
      if (!(passthroughInput instanceof Request)) {
        throw new Error("Expected passthrough to receive a Request snapshot");
      }
      expect(new URL(passthroughInput.url).pathname).toBe("/api/users");
    } finally {
      handle.restore();
    }
  });

  it("lets one mock hold two concurrent leases", async () => {
    mock("GET /alpha/ping", { lease: "alpha" });
    mock("GET /beta/ping", { lease: "beta" });

    const older = mock.intercept({ baseUrl: "/alpha" });
    const newer = mock.intercept({ baseUrl: "/beta" });

    try {
      expect(older.active).toBe(true);
      expect(newer.active).toBe(true);
      expect(
        await fetch("http://localhost/alpha/ping").then((r) => r.json()),
      ).toEqual({ lease: "alpha" });
      expect(
        await fetch("http://localhost/beta/ping").then((r) => r.json()),
      ).toEqual({ lease: "beta" });
    } finally {
      older.restore();
      newer.restore();
    }
  });

  it("restores exactly one of two leases held by the same mock", async () => {
    mock("GET /alpha/ping", { lease: "alpha" });
    mock("GET /beta/ping", { lease: "beta" });
    const baselineFetch = globalThis.fetch;

    const older = mock.intercept({ baseUrl: "/alpha" });
    const newer = mock.intercept({ baseUrl: "/beta" });

    newer.restore();
    expect(newer.active).toBe(false);
    expect(older.active).toBe(true);
    expect(globalThis.fetch).not.toBe(baselineFetch);
    expect(
      await fetch("http://localhost/alpha/ping").then((r) => r.json()),
    ).toEqual({ lease: "alpha" });

    older.restore();
    expect(older.active).toBe(false);
    expect(globalThis.fetch).toBe(baselineFetch);
  });

  it("emits one lifecycle event set when two leases of one mock miss", async () => {
    mock("GET /api/hit", { hit: true });
    const events: string[] = [];
    mock.on("request:start", () => {
      events.push("start");
    });
    mock.on("request:notfound", () => {
      events.push("notfound");
    });
    mock.on("request:end", () => {
      events.push("end");
    });

    const older = mock.intercept();
    const newer = mock.intercept();

    try {
      await fetch("http://localhost/api/miss");
      // One network request consults the mock once, no matter how many
      // leases it holds.
      expect(events).toEqual(["start", "notfound", "end"]);
    } finally {
      newer.restore();
      older.restore();
    }
  });

  it("consults both leases of one mock when their baseUrls are disjoint", async () => {
    mock("GET /alpha/ping", { lease: "alpha" });
    mock("GET /beta/ping", { lease: "beta" });
    const events: string[] = [];
    mock.on("request:start", () => {
      events.push("start");
    });
    mock.on("request:notfound", () => {
      events.push("notfound");
    });

    const older = mock.intercept({ baseUrl: "/alpha" });
    const newer = mock.intercept({ baseUrl: "/beta" });

    try {
      // The newer lease filters the request out before it reaches the mock,
      // so it must not consume the owner's single consultation.
      expect(
        await fetch("http://localhost/alpha/ping").then((r) => r.json()),
      ).toEqual({ lease: "alpha" });
      expect(events).toEqual(["start"]);

      // An unmatched path under the older lease still misses exactly once.
      await fetch("http://localhost/alpha/miss");
      expect(events).toEqual(["start", "start", "notfound"]);
    } finally {
      newer.restore();
      older.restore();
    }
  });

  it("applies a new baseUrl through update()", async () => {
    mock("GET /alpha/ping", { lease: "alpha" });
    mock("GET /beta/ping", { lease: "beta" });
    const baselineFetch = vi.mocked(globalThis.fetch);
    const handle = mock.intercept({ baseUrl: "/alpha" });

    try {
      await fetch("http://localhost/beta/ping");
      expect(baselineFetch).toHaveBeenCalledTimes(1);

      handle.update({ baseUrl: "/beta" });

      expect(
        await fetch("http://localhost/beta/ping").then((r) => r.json()),
      ).toEqual({ lease: "beta" });

      await fetch("http://localhost/alpha/ping");
      expect(baselineFetch).toHaveBeenCalledTimes(2);
    } finally {
      handle.restore();
    }
  });

  it("flips passthrough through update()", async () => {
    mock("GET /api/known", { ok: true });
    const handle = mock.intercept({ passthrough: true });

    try {
      expect(await (await fetch("http://localhost/api/unknown")).text()).toBe(
        "real backend",
      );

      handle.update({ passthrough: false });

      const strict = await fetch("http://localhost/api/unknown");
      expect(strict.status).toBe(404);
      expect(await strict.json()).toEqual({
        error: "No matching mock route found",
        code: "ROUTE_NOT_FOUND",
      });
    } finally {
      handle.restore();
    }
  });

  it("swaps request and response hooks through update()", async () => {
    mock("GET /api/hook", ({ headers }) => ({ marker: headers["x-marker"] }));

    const handle = mock.intercept({
      beforeRequest: (request) => ({
        ...request,
        headers: { ...request.headers, "x-marker": "first" },
      }),
      beforeResponse: (response) => ({
        ...response,
        headers: { ...response.headers, "x-hook": "first" },
      }),
    });

    try {
      const first = await fetch("http://localhost/api/hook");
      expect(await first.json()).toEqual({ marker: "first" });
      expect(first.headers.get("x-hook")).toBe("first");

      handle.update({
        beforeRequest: (request) => ({
          ...request,
          headers: { ...request.headers, "x-marker": "second" },
        }),
        beforeResponse: (response) => ({
          ...response,
          headers: { ...response.headers, "x-hook": "second" },
        }),
      });

      const second = await fetch("http://localhost/api/hook");
      expect(await second.json()).toEqual({ marker: "second" });
      expect(second.headers.get("x-hook")).toBe("second");
    } finally {
      handle.restore();
    }
  });

  it("swaps errorFormatter through update()", async () => {
    mock("GET /api/users", [{ id: 1 }]);
    const handle = mock.intercept({
      beforeRequest: () => {
        throw new Error("hook failed");
      },
      errorFormatter: (error) => ({ stage: "first", message: error.message }),
    });

    try {
      expect(
        await fetch("http://localhost/api/users").then((r) => r.json()),
      ).toEqual({ stage: "first", message: "hook failed" });

      handle.update({
        beforeRequest: () => {
          throw new Error("hook failed again");
        },
        errorFormatter: (error) => ({
          stage: "second",
          message: error.message,
        }),
      });

      expect(
        await fetch("http://localhost/api/users").then((r) => r.json()),
      ).toEqual({ stage: "second", message: "hook failed again" });
    } finally {
      handle.restore();
    }
  });

  it("keeps its stack position when a lease updates its options", async () => {
    mock("GET /api/shared", { source: "older" });
    const newerMock = schmock();
    newerMock("GET /api/shared", { source: "newer" });

    const older = mock.intercept();
    const newer = newerMock.intercept();

    try {
      older.update({ passthrough: false });

      expect(
        await fetch("http://localhost/api/shared").then((r) => r.json()),
      ).toEqual({ source: "newer" });
    } finally {
      older.restore();
      newer.restore();
    }
  });

  it("ignores update() on a restored lease", () => {
    mock("GET /api/known", { ok: true });
    const handle = mock.intercept();
    handle.restore();

    expect(() => handle.update({ passthrough: false })).not.toThrow();
    expect(handle.active).toBe(false);
  });

  it("does not leak an admission for unsupported fetch methods", async () => {
    const uninstall = vi.fn();
    mock.pipe({
      name: "cleanup",
      process: (context, response) => ({ context, response }),
      uninstall,
    });
    const handle = mock.intercept({ passthrough: false });

    try {
      await expect(
        fetch("http://localhost/resource", { method: "PROPFIND" }),
      ).rejects.toThrow('Invalid HTTP method: "PROPFIND"');
      mock.reset();
      expect(uninstall).toHaveBeenCalledOnce();
    } finally {
      handle.restore();
    }
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

  it("resolves relative references against the document base URI", async () => {
    vi.stubGlobal("document", {
      baseURI: "https://app.example.test/app/page.html",
    });
    mock("GET /app/users", { matched: true });
    const handle = mock.intercept({ passthrough: false });

    try {
      const response = await fetch("users");
      expect(await response.json()).toEqual({ matched: true });
    } finally {
      handle.restore();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["?page=2", "/app/page.html", "page=2"],
    ["#details", "/app/page.html", ""],
    ["/root", "/root", ""],
  ])("resolves relative reference %s using browser URL semantics", async (reference, expectedPath, expectedQuery) => {
    vi.stubGlobal("document", {
      baseURI: "https://app.example.test/app/page.html",
    });
    const baselineFetch = vi.fn().mockResolvedValue(new Response("backend"));
    globalThis.fetch = baselineFetch;
    const handle = mock.intercept({ baseUrl: "https://api.example.test" });

    try {
      await fetch(reference);
      const [input] = baselineFetch.mock.calls[0];
      if (!(input instanceof Request)) {
        throw new Error("Expected passthrough to receive a Request");
      }
      const url = new URL(input.url);
      expect(url.pathname).toBe(expectedPath);
      expect(url.searchParams.toString()).toBe(expectedQuery);
    } finally {
      handle.restore();
      vi.unstubAllGlobals();
    }
  });

  it("rejects malformed absolute URLs instead of treating them as paths", async () => {
    const handle = mock.intercept();

    try {
      await expect(fetch("http://[")).rejects.toBeDefined();
    } finally {
      handle.restore();
    }
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
      headers: { "content-type": "application/json" },
      body: "not-json-{broken",
    });

    const json = await res.json();
    expect(json.received).toBe("not-json-{broken");

    handle.restore();
  });

  it("passes unmatched malformed JSON through without entering history", async () => {
    const baselineFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        return new Response(await request.text());
      },
    );
    globalThis.fetch = baselineFetch;
    mock("POST /api/matched", { mocked: true });
    const errorFormatter = vi.fn(() => ({ formatted: true }));
    const handle = mock.intercept({ passthrough: true, errorFormatter });

    try {
      const response = await fetch("http://localhost/api/unmatched", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json-{broken",
      });
      expect(await response.text()).toBe("not-json-{broken");
      expect(baselineFetch).toHaveBeenCalledOnce();
      expect(errorFormatter).not.toHaveBeenCalled();
      expect(mock.history()).toHaveLength(0);
    } finally {
      handle.restore();
    }
  });

  it("removes absolute URL fragments before extracting query values", async () => {
    mock("GET /api/fragmented", ({ query }) => ({ query }));
    const handle = mock.intercept({ passthrough: false });

    try {
      const response = await fetch(
        "http://localhost/api/fragmented?kept=yes#ignored",
      );
      expect(await response.json()).toEqual({ query: { kept: "yes" } });
    } finally {
      handle.restore();
    }
  });

  it("parses structured JSON media types after normalizing parameters", async () => {
    mock("POST /api/problem", ({ body }) => body);
    const handle = mock.intercept({ passthrough: false });

    try {
      const response = await fetch("http://localhost/api/problem", {
        method: "POST",
        headers: {
          "content-type": "Application/Problem+JSON; Charset=UTF-8",
        },
        body: JSON.stringify({ title: "Invalid request" }),
      });
      expect(await response.json()).toEqual({ title: "Invalid request" });
    } finally {
      handle.restore();
    }
  });

  it("passes multipart bodies to handlers as FormData", async () => {
    mock("POST /api/upload", ({ body }) => ({
      isFormData: body instanceof FormData,
      name: body instanceof FormData ? body.get("name") : undefined,
    }));
    const handle = mock.intercept({ passthrough: false });
    const form = new FormData();
    form.set("name", "Alice");

    try {
      const response = await fetch("http://localhost/api/upload", {
        method: "POST",
        body: form,
      });
      expect(await response.json()).toEqual({
        isFormData: true,
        name: "Alice",
      });
    } finally {
      handle.restore();
    }
  });

  it("passes unrecognized body media as an ArrayBuffer", async () => {
    mock("POST /api/bytes", ({ body }) => ({
      isArrayBuffer: body instanceof ArrayBuffer,
      bytes:
        body instanceof ArrayBuffer
          ? Array.from(new Uint8Array(body))
          : undefined,
    }));
    const handle = mock.intercept({ passthrough: false });

    try {
      const response = await fetch("http://localhost/api/bytes", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3]),
      });
      expect(await response.json()).toEqual({
        isArrayBuffer: true,
        bytes: [1, 2, 3],
      });
    } finally {
      handle.restore();
    }
  });

  it("delivers an unlabeled string body as text on every runtime", async () => {
    // The Fetch standard stamps text/plain;charset=UTF-8 onto a string body.
    // Node's Request constructor conforms while Bun's omits the header, so
    // without normalization the same call yields a string on Node and an
    // opaque ArrayBuffer on Bun.
    mock("POST /api/unlabeled", ({ body, headers }) => ({
      bodyKind: body instanceof ArrayBuffer ? "arraybuffer" : typeof body,
      receivedBody: typeof body === "string" ? body : undefined,
      contentType: headers["content-type"] ?? null,
    }));
    const handle = mock.intercept({ passthrough: false });

    try {
      const payload = JSON.stringify({ a: 1 });
      const response = await fetch("http://localhost/api/unlabeled", {
        method: "POST",
        body: payload,
      });
      const result = (await response.json()) as {
        bodyKind: string;
        receivedBody?: string;
        contentType: string | null;
      };
      expect(result.bodyKind).toBe("string");
      expect(result.receivedBody).toBe(payload);
      expect(result.contentType?.toLowerCase()).toContain("text/plain");
    } finally {
      handle.restore();
    }
  });

  it("keeps the inherited body's content type when init headers replace the header list", async () => {
    // fetch(request, { headers }) replaces the whole header list, which
    // drops the content type stamped when the input Request extracted its
    // string body. The interceptor restores it from the input so the
    // handler still receives the body as text. (Node stamps string bodies
    // at Request construction; Bun never does, so on Bun this relies on an
    // explicit content type on the input Request.)
    mock("POST /api/inherited", ({ body, headers }) => ({
      bodyKind: body instanceof ArrayBuffer ? "arraybuffer" : typeof body,
      receivedBody: typeof body === "string" ? body : undefined,
      contentType: headers["content-type"] ?? null,
    }));
    const handle = mock.intercept({ passthrough: false });

    try {
      const input = new Request("http://localhost/api/inherited", {
        method: "POST",
        body: "hello",
        headers: { "content-type": "text/plain;charset=UTF-8" },
      });
      const response = await fetch(input, { headers: { "x-trace": "1" } });
      const result = (await response.json()) as {
        bodyKind: string;
        receivedBody?: string;
        contentType: string | null;
      };
      expect(result.bodyKind).toBe("string");
      expect(result.receivedBody).toBe("hello");
      expect(result.contentType?.toLowerCase()).toContain("text/plain");
    } finally {
      handle.restore();
    }
  });

  it("forwards the effective AbortSignal to handle request options", async () => {
    const handleRequest = vi.fn(
      async (): Promise<Schmock.Response> => ({
        status: 200,
        body: { ok: true },
        headers: {},
      }),
    );
    const interceptor = createFetchInterceptor(handleRequest, {
      passthrough: false,
    });
    const controller = new AbortController();

    try {
      await fetch("http://localhost/api/signal", {
        signal: controller.signal,
      });
      expect(handleRequest).toHaveBeenCalledWith(
        "GET",
        "/api/signal",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      interceptor.restore();
    }
  });

  it("constructs a bodyless Fetch response for no-content statuses", async () => {
    mock("GET /api/no-content", () => [204, { forbidden: true }]);
    const handle = mock.intercept({ passthrough: false });

    try {
      const response = await fetch("http://localhost/api/no-content");
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    } finally {
      handle.restore();
    }
  });

  it("emits string bodies verbatim under the default JSON content type", async () => {
    mock("GET /api/json-string", () => JSON.stringify({ a: 1 }));
    const handle = mock.intercept({ passthrough: false });

    // A string body is pre-serialized wire bytes: quoting it would
    // double-encode routes that return JSON.stringify(...) themselves.
    try {
      const response = await fetch("http://localhost/api/json-string");
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({ a: 1 });
    } finally {
      handle.restore();
    }
  });

  it("emits bare tuple strings as untyped raw text", async () => {
    mock("GET /api/tuple-string", () => [200, "hello"]);
    const handle = mock.intercept({ passthrough: false });

    try {
      const response = await fetch("http://localhost/api/tuple-string");
      expect(response.headers.get("content-type")).toBeNull();
      expect(await response.text()).toBe("hello");
    } finally {
      handle.restore();
    }
  });

  it("keeps unmatched HEAD passthrough after body normalization", async () => {
    const baselineFetch = vi.fn().mockResolvedValue(new Response(null));
    globalThis.fetch = baselineFetch;
    const handle = mock.intercept({ passthrough: true });

    try {
      await fetch("http://localhost/api/missing", { method: "HEAD" });
      expect(baselineFetch).toHaveBeenCalledOnce();
    } finally {
      handle.restore();
    }
  });

  it("returns a bodyless strict 404 for unmatched HEAD requests", async () => {
    const handle = mock.intercept({ passthrough: false });

    try {
      const response = await fetch("http://localhost/api/missing", {
        method: "HEAD",
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    } finally {
      handle.restore();
    }
  });

  it("uses a method rewritten to HEAD when formatting adapter errors", async () => {
    mock("HEAD /api/failure", { ok: true });
    const handle = mock.intercept({
      passthrough: false,
      beforeRequest: (request) => ({ ...request, method: "HEAD" }),
      beforeResponse: () => {
        throw new Error("response hook failed");
      },
      errorFormatter: (error) => ({ error: error.message }),
    });

    try {
      const response = await fetch("http://localhost/api/failure");
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("");
    } finally {
      handle.restore();
    }
  });

  it("rejects an abort while an async hook remains pending", async () => {
    mock("GET /api/slow-hook", { completed: true });
    let announceHookStart = () => {};
    let releaseHook = () => {};
    const hookStarted = new Promise<void>((resolve) => {
      announceHookStart = () => resolve();
    });
    const hookBarrier = new Promise<void>((resolve) => {
      releaseHook = () => resolve();
    });
    const errorFormatter = vi.fn(() => ({ formatted: true }));
    const handle = mock.intercept({
      passthrough: false,
      beforeRequest: async (request) => {
        announceHookStart();
        await hookBarrier;
        return request;
      },
      errorFormatter,
    });
    const controller = new AbortController();

    try {
      const responsePromise = fetch("http://localhost/api/slow-hook", {
        signal: controller.signal,
      });
      await hookStarted;
      controller.abort();

      await expect(
        Promise.race([
          responsePromise,
          new Promise<Response>((_, reject) => {
            setTimeout(() => reject(new Error("abort timed out")), 100);
          }),
        ]),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(errorFormatter).not.toHaveBeenCalled();
      expect(mock.history()).toHaveLength(0);
    } finally {
      releaseHook();
      handle.restore();
    }
  });

  it("keeps the route generation admitted before an async request hook", async () => {
    let announceHookStart = () => {};
    let releaseHook = () => {};
    const hookStarted = new Promise<void>((resolve) => {
      announceHookStart = resolve;
    });
    const hookBarrier = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    mock("GET /api/generation", { generation: "old" });
    const handle = mock.intercept({
      passthrough: false,
      async beforeRequest(request) {
        announceHookStart();
        await hookBarrier;
        return request;
      },
    });

    try {
      const pending = fetch("http://localhost/api/generation");
      await hookStarted;
      mock.reset();
      const staleStart = vi.fn();
      mock.on("request:start", staleStart);
      mock("GET /api/generation", { generation: "new" });
      releaseHook();

      expect(await (await pending).json()).toEqual({ generation: "old" });
      expect(mock.history()).toHaveLength(0);
      expect(staleStart).not.toHaveBeenCalled();
    } finally {
      releaseHook();
      handle.restore();
    }
  });

  it("keeps a streamed request body readable for baseline passthrough", async () => {
    const baselineFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        return new Response(await request.text());
      },
    );
    globalThis.fetch = baselineFetch;
    mock("POST /api/matched", { mocked: true });
    const handle = mock.intercept({ passthrough: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("passthrough body"));
        controller.close();
      },
    });
    const requestInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
      duplex: "half",
    };

    try {
      const response = await fetch(
        "http://localhost/api/unmatched",
        requestInit,
      );
      expect(await response.text()).toBe("passthrough body");
      expect(baselineFetch).toHaveBeenCalledOnce();
      const [passthroughInput, ...remainingArguments] =
        baselineFetch.mock.calls[0];
      expect(passthroughInput).toBeInstanceOf(Request);
      expect(remainingArguments).toEqual([]);
    } finally {
      handle.restore();
    }
  });

  it("passes an immutable effective Request snapshot to baseline fetch", async () => {
    const baselineFetch = vi.fn().mockResolvedValue(new Response("backend"));
    globalThis.fetch = baselineFetch;
    let announceHookStart = () => {};
    let releaseHook = () => {};
    const hookStarted = new Promise<void>((resolve) => {
      announceHookStart = resolve;
    });
    const hookBarrier = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const headers = new Headers({ "x-snapshot": "original" });
    const handle = mock.intercept({
      passthrough: true,
      async beforeRequest(request) {
        announceHookStart();
        await hookBarrier;
        return request;
      },
    });

    try {
      const pending = fetch("http://localhost/api/unmatched", { headers });
      await hookStarted;
      headers.set("x-snapshot", "mutated");
      releaseHook();
      await pending;

      const [input, ...remainingArguments] = baselineFetch.mock.calls[0];
      expect(remainingArguments).toEqual([]);
      if (!(input instanceof Request)) {
        throw new Error("Expected passthrough to receive a Request snapshot");
      }
      expect(input.headers.get("x-snapshot")).toBe("original");
    } finally {
      releaseHook();
      handle.restore();
    }
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
