/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, onMounted, ref } from "vue";
import {
  restoreSchmockInterception,
  schmockPlugin,
  useSchmock,
} from "./index.js";

const UserList = defineComponent({
  setup() {
    const users = ref<Array<{ id: number; name: string }>>([]);

    onMounted(async () => {
      const res = await fetch("http://localhost/api/users");
      users.value = await res.json();
    });

    return () =>
      h(
        "ul",
        users.value.map((u) => h("li", { key: u.id }, u.name)),
      );
  },
});

const MockConsumer = defineComponent({
  setup() {
    const mock = useSchmock();
    return () => h("div", { "data-testid": "has-mock" }, mock ? "yes" : "no");
  },
});

describe("schmockPlugin", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("intercepts fetch when plugin is installed", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1, name: "Alice" }]);

    const wrapper = mount(UserList, {
      global: {
        plugins: [[schmockPlugin, { mock }]],
      },
    });

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("Alice");
    });
  });

  it("restores fetch on app unmount", () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;

    const wrapper = mount(defineComponent({ render: () => h("div") }), {
      global: { plugins: [[schmockPlugin, { mock }]] },
    });

    expect(globalThis.fetch).not.toBe(savedFetch);
    wrapper.unmount();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("releases interception for an app that never mounts", () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;

    const app = createApp(defineComponent({ render: () => h("div") }));
    app.use(schmockPlugin, { mock });
    expect(globalThis.fetch).not.toBe(savedFetch);

    restoreSchmockInterception(app);
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("ignores a release for an app that never installed the plugin", () => {
    const savedFetch = globalThis.fetch;
    const app = createApp(defineComponent({ render: () => h("div") }));

    expect(() => restoreSchmockInterception(app)).not.toThrow();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("releases interception when a release is repeated", () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;

    const app = createApp(defineComponent({ render: () => h("div") }));
    app.use(schmockPlugin, { mock });
    restoreSchmockInterception(app);
    restoreSchmockInterception(app);

    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("releases interception when mount throws", () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;

    const Broken = defineComponent({
      setup() {
        throw new Error("setup failed");
      },
    });

    const app = createApp(Broken);
    app.use(schmockPlugin, { mock });
    expect(globalThis.fetch).not.toBe(savedFetch);

    const container = document.createElement("div");
    expect(() => app.mount(container)).toThrow("setup failed");
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("lets two apps share one mock", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1, name: "Alice" }]);
    const savedFetch = globalThis.fetch;

    const first = createApp(defineComponent({ render: () => h("div") }));
    const second = createApp(defineComponent({ render: () => h("div") }));
    first.use(schmockPlugin, { mock });
    expect(() => second.use(schmockPlugin, { mock })).not.toThrow();

    expect(
      await fetch("http://localhost/api/users").then((r) => r.json()),
    ).toEqual([{ id: 1, name: "Alice" }]);

    restoreSchmockInterception(second);
    expect(
      await fetch("http://localhost/api/users").then((r) => r.json()),
    ).toEqual([{ id: 1, name: "Alice" }]);

    restoreSchmockInterception(first);
    expect(globalThis.fetch).toBe(savedFetch);
  });
});

describe("useSchmock", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns mock instance from injected context", () => {
    const mock = schmock();

    const wrapper = mount(MockConsumer, {
      global: { plugins: [[schmockPlugin, { mock }]] },
    });

    expect(wrapper.find("[data-testid='has-mock']").text()).toBe("yes");
  });

  it("throws when used without the plugin", () => {
    expect(() => mount(MockConsumer)).toThrow(/schmockPlugin/);
  });
});
