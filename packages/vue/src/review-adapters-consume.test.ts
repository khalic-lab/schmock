/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";
import { restoreSchmockInterception, schmockPlugin } from "./index.js";

const Empty = defineComponent({ render: () => h("div") });

describe("schmockPlugin `options` alias (types-108)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts the intercept options as `options`, like SchmockProvider", async () => {
    const mock = schmock();
    mock("GET /users", [{ id: 0 }]);
    mock("GET /api/users", [{ id: 1 }]);
    const app = createApp(Empty);
    app.use(schmockPlugin, { mock, options: { baseUrl: "/api" } });

    try {
      const outside = await fetch("http://localhost/users");
      expect(await outside.text()).toBe("real");
      const inside = await fetch("http://localhost/api/users");
      expect(await inside.json()).toEqual([{ id: 1 }]);
    } finally {
      restoreSchmockInterception(app);
    }
  });

  it("uses `interceptOptions` when both names are given", () => {
    const mock = schmock();
    const intercept = vi.spyOn(mock, "intercept");
    const interceptOptions = { baseUrl: "/one" };
    const app = createApp(Empty);
    app.use(schmockPlugin, {
      mock,
      interceptOptions,
      options: { baseUrl: "/two" },
    });

    try {
      expect(intercept).toHaveBeenCalledWith(interceptOptions);
    } finally {
      restoreSchmockInterception(app);
    }
  });
});
