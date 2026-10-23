/// <reference path="../../core/schmock.d.ts" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCallbacks } from "./callbacks.js";

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
  });
});
