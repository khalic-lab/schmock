/// <reference path="../../../core/schmock.d.ts" />

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import { defineComponent, h, onMounted, ref } from "vue";
import { mount } from "@vue/test-utils";
import { schmock } from "@schmock/core";
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
    const mock = useSchmock();
    return () => h("div", { "data-testid": "has-mock" }, mock ? "yes" : "no");
  },
});

describeFeature(feature, ({ Scenario }) => {
  let mock: Schmock.CallableMockInstance;
  let originalFetch: typeof globalThis.fetch;

  Scenario(
    "SchmockPlugin intercepts fetch calls",
    ({ Given, When, Then }) => {
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
    },
  );

  Scenario(
    "Plugin restores fetch on app unmount",
    ({ Given, When, Then }) => {
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
        const wrapper = mount(
          defineComponent({ render: () => h("div") }),
          { global: { plugins: [[schmockPlugin, { mock }]] } },
        );
        wrapper.unmount();
      });

      Then(
        "fetch should be restored to the original implementation",
        () => {
          expect(globalThis.fetch).toBe(savedFetch);
          globalThis.fetch = originalFetch;
        },
      );
    },
  );

  Scenario(
    "useSchmock returns the mock instance",
    ({ Given, When, Then }) => {
      let wrapper: ReturnType<typeof mount>;

      Given("a Schmock instance", () => {
        originalFetch = globalThis.fetch;
        mock = schmock();
      });

      When(
        "I use the useSchmock composable inside a component with the plugin",
        () => {
          wrapper = mount(MockConsumer, {
            global: { plugins: [[schmockPlugin, { mock }]] },
          });
        },
      );

      Then("it should receive the CallableMockInstance", () => {
        expect(wrapper.find("[data-testid='has-mock']").text()).toBe("yes");
        wrapper.unmount();
        globalThis.fetch = originalFetch;
      });
    },
  );

  Scenario(
    "Passthrough for unmatched routes",
    ({ Given, When, Then, And }) => {
      const fakeFetch = vi.fn().mockResolvedValue(new Response("real"));

      Given(
        'a Schmock instance with route "GET /api/users" returning users',
        () => {
          originalFetch = globalThis.fetch;
          globalThis.fetch = fakeFetch;
          mock = schmock();
          mock("GET /api/users", [{ id: 1 }]);
        },
      );

      And("the plugin is configured with passthrough enabled", () => {
        mount(
          defineComponent({ render: () => h("div") }),
          {
            global: {
              plugins: [
                [
                  schmockPlugin,
                  { mock, interceptOptions: { passthrough: true } },
                ],
              ],
            },
          },
        );
      });

      When('the component fetches "/api/other"', async () => {
        await fetch("http://localhost/api/other");
      });

      Then("the request should pass through to the original fetch", () => {
        expect(fakeFetch).toHaveBeenCalled();
        globalThis.fetch = originalFetch;
      });
    },
  );
});
