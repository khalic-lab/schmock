/// <reference path="../schmock.d.ts" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schmock } from "./index.js";
import { normalizeResponse } from "./response-normalizer.js";

// A pass-through spy: behaviour is untouched, calls are counted.
vi.mock("./response-normalizer.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./response-normalizer.js")>();
  return { ...original, normalizeResponse: vi.fn(original.normalizeResponse) };
});

describe("fetch interceptor response shaping (finding 124)", () => {
  let originalFetch: typeof globalThis.fetch;
  let handle: Schmock.InterceptHandle | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("network"),
    );
    vi.mocked(normalizeResponse).mockClear();
  });

  afterEach(() => {
    handle?.restore();
    handle = undefined;
    globalThis.fetch = originalFetch;
  });

  it("normalizes handle() output once when no beforeResponse hook ran", async () => {
    const mock = schmock();
    mock("GET /api/items", [{ id: 1 }, { id: 2 }]);
    handle = mock.intercept();

    const response = await fetch("http://localhost/api/items");

    expect(await response.json()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(normalizeResponse).toHaveBeenCalledOnce();
  });

  it("re-normalizes a response a beforeResponse hook produced", async () => {
    const mock = schmock();
    mock("GET /api/items", [{ id: 1 }]);
    handle = mock.intercept({
      beforeResponse: (response) => ({
        ...response,
        body: { wrapped: response.body },
      }),
    });

    const response = await fetch("http://localhost/api/items");

    expect(await response.json()).toEqual({ wrapped: [{ id: 1 }] });
    expect(normalizeResponse).toHaveBeenCalledTimes(2);
  });

  it("still validates a hook body the transport cannot serialize", async () => {
    const mock = schmock();
    mock("GET /api/items", [{ id: 1 }]);
    handle = mock.intercept({
      beforeResponse: (response) => ({ ...response, body: { big: 1n } }),
    });

    await expect(fetch("http://localhost/api/items")).rejects.toThrow(/bigint/);
  });
});
