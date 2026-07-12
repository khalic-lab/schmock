/// <reference path="../../../core/schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { schmock } from "@schmock/core";
import { mount } from "@vue/test-utils";
import { expect, vi } from "vitest";
import { defineComponent, h, onMounted, ref } from "vue";
import { schmockPlugin, useSchmock } from "../index.js";

const feature = await loadFeature("../../features/vue-adapter.feature");

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
    useSchmock();
    return () => h("div", { "data-testid": "has-mock" }, "yes");
  },
});

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let mock: Schmock.CallableMockInstance;
  let originalFetch: typeof globalThis.fetch = globalThis.fetch;

  AfterEachScenario(() => {
    globalThis.fetch = originalFetch;
  });

  Scenario("SchmockPlugin intercepts fetch calls", ({ Given, When, Then }) => {
    let wrapper: ReturnType<typeof mount>;

    Given(
      'a Schmock instance with route "GET /api/users" returning users',
      () => {
        originalFetch = globalThis.fetch;
        mock = schmock();
        mock("GET /api/users", [{ id: 1, name: "Alice" }]);
      },
    );

    When(
      'I mount a component that fetches "/api/users" with the Schmock plugin',
      () => {
        wrapper = mount(UserList, {
          global: { plugins: [[schmockPlugin, { mock }]] },
        });
      },
    );

    Then("the component should display the mocked users", async () => {
      await vi.waitFor(() => {
        expect(wrapper.text()).toContain("Alice");
      });
      wrapper.unmount();
      globalThis.fetch = originalFetch;
    });
  });

  Scenario("Plugin restores fetch on app unmount", ({ Given, When, Then }) => {
    let savedFetch: typeof globalThis.fetch;

    Given(
      'a Schmock instance with route "GET /api/users" returning users',
      () => {
        originalFetch = globalThis.fetch;
        mock = schmock();
        mock("GET /api/users", [{ id: 1 }]);
      },
    );

    When("I mount and unmount a Vue app with the Schmock plugin", () => {
      savedFetch = globalThis.fetch;
      const wrapper = mount(defineComponent({ render: () => h("div") }), {
        global: { plugins: [[schmockPlugin, { mock }]] },
      });
      wrapper.unmount();
    });

    Then("fetch should be restored to the original implementation", () => {
      expect(globalThis.fetch).toBe(savedFetch);
      globalThis.fetch = originalFetch;
    });
  });

  Scenario("useSchmock throws without the plugin", ({ Given, When, Then }) => {
    let error: Error | undefined;

    Given("a component that calls useSchmock without the plugin", () => {
      originalFetch = globalThis.fetch;
    });

    When("I try to mount it", () => {
      try {
        mount(MockConsumer);
      } catch (caught) {
        if (caught instanceof Error) error = caught;
      }
    });

    Then("it should throw an error mentioning schmockPlugin", () => {
      expect(error?.message).toMatch(/schmockPlugin/);
      globalThis.fetch = originalFetch;
    });
  });
});
