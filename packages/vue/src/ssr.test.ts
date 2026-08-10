// @vitest-environment node
/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";
import {
  restoreSchmockInterception,
  schmockPlugin,
  useSchmock,
} from "./index.js";

describe("schmockPlugin without a DOM", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("never patches the process-global fetch", () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1 }]);
    const savedFetch = globalThis.fetch;

    const app = createApp(defineComponent({ render: () => h("div") }));
    app.use(schmockPlugin, { mock });

    expect(typeof document).toBe("undefined");
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("still provides the mock to components", () => {
    const mock = schmock();
    const app = createApp(defineComponent({ render: () => h("div") }));
    app.use(schmockPlugin, { mock });

    expect(app.runWithContext(() => useSchmock())).toBe(mock);
  });

  it("treats releasing an unpatched app as a no-op", () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;
    const app = createApp(defineComponent({ render: () => h("div") }));
    app.use(schmockPlugin, { mock });

    expect(() => restoreSchmockInterception(app)).not.toThrow();
    expect(globalThis.fetch).toBe(savedFetch);
  });
});
