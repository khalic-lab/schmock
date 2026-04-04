/// <reference path="../../core/schmock.d.ts" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireCallbacks } from "./callbacks.js";

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

describe("fireCallbacks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a warning when callback fetch fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Connection refused"));

    fireCallbacks(
      [{ urlExpression: "http://example.com/hook", method: "POST" }],
      makeContext(),
      { id: 1 },
    );

    // Wait for the fire-and-forget promise to settle
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Callback POST http://example.com/hook failed"),
        "Connection refused",
      );
    });

    fetchSpy.mockRestore();
  });

  it("skips callbacks with non-http URLs without logging", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fireCallbacks(
      [{ urlExpression: "not-a-url", method: "POST" }],
      makeContext(),
      { id: 1 },
    );

    // Give time for any async work to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("fires callback with correct method and body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));

    fireCallbacks(
      [{ urlExpression: "http://example.com/hook", method: "POST" }],
      makeContext(),
      { result: "created" },
    );

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("http://example.com/hook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ result: "created" }),
      });
    });

    fetchSpy.mockRestore();
  });
});
