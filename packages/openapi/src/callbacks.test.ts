/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCallbacks } from "./callbacks.js";
import { openapi } from "./plugin.js";

function makeContext(
  overrides: Partial<Schmock.PluginContext> = {},
): Schmock.PluginContext {
  return {
    path: "/test",
    method: "POST",
    params: {},
    query: {},
    headers: {},
    body: undefined,
    state: new Map(),
    route: {},
    ...overrides,
  };
}

describe("dispatchCallbacks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a warning when the application dispatcher fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatcher = vi.fn((_request: Schmock.OpenApiCallbackRequest) =>
      Promise.reject(new Error("Connection refused")),
    );

    await dispatchCallbacks(
      [{ urlExpression: "http://example.com/hook", method: "POST" }],
      dispatcher,
      makeContext(),
      { id: 1 },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Callback dispatcher failed for POST http://example.com/hook",
      ),
      "Connection refused",
    );
  });

  it("masks credentials in the URL its failure warnings print", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatcher = vi.fn((_request: Schmock.OpenApiCallbackRequest) =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    const callbackUrl =
      "https://alice:hunter2@client.example/hook?access_token=SECRET123&page=2#frag";

    await dispatchCallbacks(
      [
        { urlExpression: "{$request.body#/callbackUrl}", method: "POST" },
        {
          urlExpression: "{$request.body#/callbackUrl}",
          method: "PUT",
          // An empty schema makes @schmock/faker reject.
          requestBody: {},
        },
      ],
      dispatcher,
      makeContext({ body: { callbackUrl } }),
      { id: 1 },
    );

    // The dispatcher still receives the real URL.
    expect(dispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ url: callbackUrl }),
    );
    const printed = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(printed).toEqual([
      "[@schmock/openapi] Callback dispatcher failed for POST https://client.example/hook?access_token=[redacted]&page=2#frag:",
      "[@schmock/openapi] Callback body generation failed for PUT https://client.example/hook?access_token=[redacted]&page=2#frag:",
    ]);
  });

  it("masks an encoded credential name and keeps the fragment after a masked value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatcher = vi.fn((_request: Schmock.OpenApiCallbackRequest) =>
      Promise.reject(new Error("ECONNREFUSED")),
    );
    // access%5Ftoken is access_token as a server decodes it; the credential
    // right before the fragment must not swallow it.
    const callbackUrl =
      "https://client.example/hook?page=2&access%5Ftoken=SECRET123&api_key=KEY456#frag";

    await dispatchCallbacks(
      [{ urlExpression: "{$request.body#/callbackUrl}", method: "POST" }],
      dispatcher,
      makeContext({ body: { callbackUrl } }),
      { id: 1 },
    );

    const printed = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(printed).toEqual([
      "[@schmock/openapi] Callback dispatcher failed for POST https://client.example/hook?page=2&access%5Ftoken=[redacted]&api_key=[redacted]#frag:",
    ]);
  });

  it("skips callbacks whose runtime URL resolves to an empty value", async () => {
    const dispatcher = vi.fn((_request: Schmock.OpenApiCallbackRequest) => {});

    await dispatchCallbacks(
      [
        {
          urlExpression: "{$request.body#/missingCallbackUrl}",
          method: "POST",
        },
      ],
      dispatcher,
      makeContext({ body: { id: 1 } }),
      { id: 1 },
    );

    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("dispatches the resolved method and tuple body without using fetch", async () => {
    const dispatcher = vi.fn((_request: Schmock.OpenApiCallbackRequest) => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await dispatchCallbacks(
      [{ urlExpression: "http://example.com/hook", method: "POST" }],
      dispatcher,
      makeContext(),
      [201, { result: "created" }],
    );

    expect(dispatcher).toHaveBeenCalledWith({
      url: "http://example.com/hook",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { result: "created" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("generates the callback payload from the callback operation's declared request body", async () => {
    const dispatcher = vi.fn((_request: Schmock.OpenApiCallbackRequest) => {});

    await dispatchCallbacks(
      [
        {
          urlExpression: "http://example.com/hook",
          method: "POST",
          requestBody: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
          },
        },
      ],
      dispatcher,
      makeContext(),
      [201, { result: "created" }],
      { seed: 42 },
    );

    expect(dispatcher).toHaveBeenCalledTimes(1);
    const body = dispatcher.mock.calls[0][0].body as Record<string, unknown>;
    expect(typeof body.status).toBe("string");
    expect(body).not.toHaveProperty("result");
  });

  it("falls back to the response body when the callback declares no request body", async () => {
    const dispatcher = vi.fn((_request: Schmock.OpenApiCallbackRequest) => {});

    await dispatchCallbacks(
      [{ urlExpression: "http://example.com/hook", method: "POST" }],
      dispatcher,
      makeContext(),
      [201, { result: "created" }],
      { seed: 42 },
    );

    expect(dispatcher).toHaveBeenCalledWith({
      url: "http://example.com/hook",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { result: "created" },
    });
  });

  it("skips the callback and warns when body generation fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatcher = vi.fn((_request: Schmock.OpenApiCallbackRequest) => {});

    await dispatchCallbacks(
      [
        {
          urlExpression: "http://example.com/hook",
          method: "POST",
          // An empty schema makes @schmock/faker reject.
          requestBody: {},
        },
      ],
      dispatcher,
      makeContext(),
      [201, { result: "created" }],
    );

    expect(dispatcher).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Callback body generation failed for POST/),
      expect.anything(),
    );
  });

  it("generates deterministic callback bodies under a faker seed", async () => {
    const callbacks = [
      {
        urlExpression: "http://example.com/hook",
        method: "POST" as const,
        requestBody: {
          type: "object" as const,
          properties: {
            status: { type: "string" as const },
            attempts: { type: "integer" as const },
          },
          required: ["status", "attempts"],
        },
      },
    ];

    const first = vi.fn((_request: Schmock.OpenApiCallbackRequest) => {});
    const second = vi.fn((_request: Schmock.OpenApiCallbackRequest) => {});

    await dispatchCallbacks(callbacks, first, makeContext(), undefined, {
      seed: 1234,
    });
    await dispatchCallbacks(callbacks, second, makeContext(), undefined, {
      seed: 1234,
    });

    expect(JSON.stringify(first.mock.calls[0][0].body)).toBe(
      JSON.stringify(second.mock.calls[0][0].body),
    );
  });

  it("resolves escaped array pointers and unwraps response objects", async () => {
    const dispatcher = vi.fn((_request: Schmock.OpenApiCallbackRequest) => {});
    const body = {
      targets: [{ "callback~/url": "https://callbacks.example.test/response" }],
    };

    await dispatchCallbacks(
      [
        {
          urlExpression: "{$response.body#/targets/0/callback~0~1url}",
          method: "POST",
        },
      ],
      dispatcher,
      makeContext(),
      { status: 202, body, headers: { "x-result": "created" } },
    );

    expect(dispatcher).toHaveBeenCalledWith({
      url: "https://callbacks.example.test/response",
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  });

  describe("error responses", () => {
    const pet = {
      type: "object",
      properties: { id: { type: "integer" }, name: { type: "string" } },
    };
    const json = (schema: Record<string, unknown>) => ({
      "application/json": { schema },
    });
    const hook = {
      updated: {
        "https://hooks.example/updated": {
          post: { responses: { "200": { description: "ok" } } },
        },
      },
    };
    const itemSpec = {
      openapi: "3.0.3",
      info: { title: "callbacks", version: "1.0.0" },
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "list",
                content: json({ type: "array", items: pet }),
              },
            },
          },
          post: {
            responses: { "201": { description: "c", content: json(pet) } },
          },
        },
        "/pets/{petId}": {
          patch: {
            responses: {
              "200": { description: "p", content: json(pet) },
              "404": {
                description: "missing",
                content: json({
                  type: "object",
                  properties: { message: { type: "string" } },
                }),
              },
            },
            callbacks: hook,
          },
          delete: {
            responses: { "204": { description: "gone" } },
            callbacks: hook,
          },
        },
      },
    };

    async function mockWithDispatcher() {
      const urls: string[] = [];
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: itemSpec,
          callbacks: {
            dispatch: (request) => {
              urls.push(request.url);
            },
          },
        }),
      );
      return { mock, urls };
    }

    it("dispatches nothing for a CRUD 404", async () => {
      const { mock, urls } = await mockWithDispatcher();

      const patched = await mock.handle("PATCH", "/pets/9", {
        body: { name: "x" },
      });
      const deleted = await mock.handle("DELETE", "/pets/9");
      expect([patched.status, deleted.status]).toEqual([404, 404]);
      expect(urls).toEqual([]);
    });

    it("still dispatches for a success and for a Prefer-simulated error", async () => {
      const { mock, urls } = await mockWithDispatcher();
      await mock.handle("POST", "/pets", { body: { name: "rex" } });

      const patched = await mock.handle("PATCH", "/pets/1", {
        body: { name: "max" },
      });
      expect(patched.status).toBe(200);
      expect(urls).toEqual(["https://hooks.example/updated"]);

      const simulated = await mock.handle("PATCH", "/pets/1", {
        body: { name: "max" },
        headers: { prefer: "code=404" },
      });
      expect(simulated.status).toBe(404);
      expect(urls).toHaveLength(2);
    });
  });

  describe("the request's abort signal", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "callbacks", version: "1.0.0" },
      paths: {
        "/jobs": {
          post: {
            responses: { "202": { description: "accepted" } },
            callbacks: {
              done: {
                "https://hooks.example/done": {
                  post: { responses: { "200": { description: "ok" } } },
                },
              },
            },
          },
        },
      },
    };

    it("hands the dispatcher a signal that aborts with the request", async () => {
      let seen: AbortSignal | undefined;
      let entered: () => void = () => {};
      const dispatching = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const mock = schmock();
      mock.pipe(
        await openapi({
          spec,
          callbacks: {
            dispatch: ({ signal }) => {
              seen = signal;
              entered();
              // A delivery that only ends when it is told to.
              return new Promise<void>((resolve) => {
                signal?.addEventListener("abort", () => resolve());
              });
            },
          },
        }),
      );
      const controller = new AbortController();

      const pending = mock.handle("POST", "/jobs", {
        signal: controller.signal,
      });
      await dispatching;
      expect(seen?.aborted).toBe(false);
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(seen?.aborted).toBe(true);
    });

    it("leaves the signal out for a request without one", async () => {
      const requests: Schmock.OpenApiCallbackRequest[] = [];
      const mock = schmock();
      mock.pipe(
        await openapi({
          spec,
          callbacks: { dispatch: (request) => requests.push(request) },
        }),
      );

      await mock.handle("POST", "/jobs");

      expect(requests).toHaveLength(1);
      expect("signal" in (requests[0] ?? {})).toBe(false);
    });
  });

  describe("fallback payload ownership", () => {
    const pet = {
      type: "object",
      properties: { id: { type: "integer" }, name: { type: "string" } },
    };
    const createSpec = {
      openapi: "3.0.3",
      info: { title: "callbacks", version: "1.0.0" },
      paths: {
        "/pets": {
          get: {
            responses: {
              "200": {
                description: "list",
                content: {
                  "application/json": {
                    schema: { type: "array", items: pet },
                  },
                },
              },
            },
          },
          post: {
            responses: {
              "201": {
                description: "created",
                content: { "application/json": { schema: pet } },
              },
            },
            callbacks: {
              created: {
                "https://hooks.example/first": {
                  post: { responses: { "200": { description: "ok" } } },
                },
                "https://hooks.example/second": {
                  post: { responses: { "200": { description: "ok" } } },
                },
              },
            },
          },
        },
      },
    };

    it("gives each dispatch its own copy, never the stored row", async () => {
      const received: unknown[] = [];
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: createSpec,
          callbacks: {
            dispatch: (request) => {
              received.push(structuredClone(request.body));
              const payload = request.body as Record<string, unknown>;
              payload.event = "pet.created";
              delete payload.name;
            },
          },
        }),
      );

      const created = await mock.handle("POST", "/pets", {
        body: { name: "rex" },
      });
      expect(created.body).toEqual({ id: 1, name: "rex" });
      expect(received).toEqual([
        { id: 1, name: "rex" },
        { id: 1, name: "rex" },
      ]);

      const list = await mock.handle("GET", "/pets");
      expect(list.body).toEqual([{ id: 1, name: "rex" }]);
    });
  });

  describe("values spliced into a fixed URL", () => {
    async function dispatchedUrl(
      urlExpression: string,
      body: Record<string, unknown>,
      response: unknown = { id: 1 },
    ): Promise<string> {
      const urls: string[] = [];
      await dispatchCallbacks(
        [{ urlExpression, method: "POST" }],
        (request) => {
          urls.push(request.url);
        },
        makeContext({ body }),
        response,
      );
      expect(urls).toHaveLength(1);
      return urls[0];
    }

    it("keeps a client value inside the path segment the template fixes", async () => {
      const url = await dispatchedUrl(
        "https://hooks.example.com/orders/{$request.body#/note}/paid?source=mock",
        { note: "a/../../../admin/purge?all=1#" },
      );
      const parsed = new URL(url);
      expect(parsed.pathname).toBe(
        `/orders/${encodeURIComponent("a/../../../admin/purge?all=1#")}/paid`,
      );
      expect(parsed.searchParams.get("source")).toBe("mock");
      expect(parsed.hash).toBe("");
    });

    it("delivers query values with reserved characters intact", async () => {
      const url = await dispatchedUrl(
        "http://notificationServer.com?transactionId={$request.body#/id}&email={$request.body#/email}",
        { id: "t 1", email: "a+b@x.com&admin=1" },
      );
      const params = [...new URL(url).searchParams];
      expect(params).toEqual([
        ["transactionId", "t 1"],
        ["email", "a+b@x.com&admin=1"],
      ]);
    });

    it("splices an expression that opens the template as the URL itself", async () => {
      const url = await dispatchedUrl(
        "{$request.body#/callbackUrl}/pets/{$response.body#/id}",
        { callbackUrl: "https://hooks.example/v1?key=a" },
        { id: "p/1" },
      );
      expect(url).toBe("https://hooks.example/v1?key=a/pets/p%2F1");
    });

    it("skips a callback whose value cannot be encoded and still dispatches the rest", async () => {
      const urls: string[] = [];
      await dispatchCallbacks(
        [
          {
            urlExpression: "https://hooks.example/{$request.body#/id}",
            method: "POST",
          },
          {
            urlExpression: "https://hooks.example/after/{$request.body#/n}",
            method: "POST",
          },
        ],
        (request) => {
          urls.push(request.url);
        },
        makeContext({ body: { id: "\uD800x", n: "ok" } }),
        { id: 1 },
      );
      expect(urls).toEqual(["https://hooks.example/after/ok"]);
    });
  });
});
