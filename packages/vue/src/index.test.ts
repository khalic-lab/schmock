/// <reference path="../../core/schmock.d.ts" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, onMounted, ref } from "vue";
import { mount } from "@vue/test-utils";
import { schmock } from "@schmock/core";
import { schmockPlugin, useSchmock } from "./index.js";

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

    const wrapper = mount(
      defineComponent({ render: () => h("div") }),
      { global: { plugins: [[schmockPlugin, { mock }]] } },
    );

    expect(globalThis.fetch).not.toBe(savedFetch);
    wrapper.unmount();
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
