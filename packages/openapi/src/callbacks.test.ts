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
});
