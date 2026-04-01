import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, onMounted, ref, watch, nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { schmock } from "@schmock/core";
import { schmockPlugin, useSchmock } from "@schmock/vue";

// ===== Test Components =====

const UserList = defineComponent({
  setup() {
    const users = ref<Array<{ id: number; name: string }>>([]);
    const loading = ref(true);

    onMounted(async () => {
      const res = await fetch("http://localhost/api/users");
      users.value = await res.json();
      loading.value = false;
    });

    return () =>
      loading.value
        ? h("div", { "data-testid": "loading" }, "Loading...")
        : h(
            "ul",
            { "data-testid": "user-list" },
            users.value.map((u) =>
              h("li", { "data-testid": `user-${u.id}`, key: u.id }, u.name),
            ),
          );
  },
});

const MockInspector = defineComponent({
  setup() {
    const mock = useSchmock();
    return () =>
      h("div", { "data-testid": "call-count" }, String(mock.callCount()));
  },
});

const ErrorDisplay = defineComponent({
  setup() {
    const error = ref("loading");

    onMounted(async () => {
      const res = await fetch("http://localhost/api/failing");
      if (!res.ok) error.value = `Error: ${res.status}`;
    });

    return () => h("div", { "data-testid": "error" }, error.value);
  },
});

const PostForm = defineComponent({
  setup() {
    const result = ref("");

    onMounted(async () => {
      const res = await fetch("http://localhost/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "NewUser" }),
      });
      const data = await res.json();
      result.value = data.name;
    });

    return () => h("div", { "data-testid": "result" }, result.value || "pending");
  },
});

const MultiLoader = defineComponent({
  setup() {
    const counts = ref({ users: 0, posts: 0, tags: 0 });

    onMounted(async () => {
      const [users, posts, tags] = await Promise.all([
        fetch("http://localhost/api/users").then((r) => r.json()),
        fetch("http://localhost/api/posts").then((r) => r.json()),
        fetch("http://localhost/api/tags").then((r) => r.json()),
      ]);
      counts.value = {
        users: users.length,
        posts: posts.length,
        tags: tags.length,
      };
    });

    return () =>
      h("div", [
        h("span", { "data-testid": "users-count" }, String(counts.value.users)),
        h("span", { "data-testid": "posts-count" }, String(counts.value.posts)),
        h("span", { "data-testid": "tags-count" }, String(counts.value.tags)),
      ]);
  },
});

// ===== Tests =====

function mountWith(
  component: ReturnType<typeof defineComponent>,
  mock: ReturnType<typeof schmock>,
  interceptOptions?: Record<string, unknown>,
) {
  return mount(component, {
    global: {
      plugins: [[schmockPlugin, { mock, interceptOptions }]],
    },
  });
}

describe("Vue adapter integration", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("schmockPlugin lifecycle", () => {
    it("renders mocked data after mount", async () => {
      const mock = schmock();
      mock("GET /api/users", [{ id: 1, name: "Alice" }]);

      const wrapper = mountWith(UserList, mock);
      await flushPromises();
      await vi.waitFor(() => {
        expect(wrapper.find("[data-testid='user-1']").text()).toBe("Alice");
      });
      wrapper.unmount();
    });

    it("restores fetch on unmount", () => {
      const mock = schmock();
      const fetchBefore = globalThis.fetch;

      const wrapper = mountWith(
        defineComponent({ render: () => h("div") }),
        mock,
      );

      expect(globalThis.fetch).not.toBe(fetchBefore);
      wrapper.unmount();
      expect(globalThis.fetch).toBe(fetchBefore);
    });

    it("multiple components share one plugin instance", async () => {
      const mock = schmock();
      mock("GET /api/users", [{ id: 1, name: "Alice" }]);

      const App = defineComponent({
        setup() {
          return () => h("div", [h(UserList), h(MockInspector)]);
        },
      });

      const wrapper = mountWith(App, mock);
      await flushPromises();
      await vi.waitFor(() => {
        expect(wrapper.find("[data-testid='user-1']").text()).toBe("Alice");
        expect(wrapper.find("[data-testid='call-count']").text()).toBe("1");
      });
      wrapper.unmount();
    });
  });

  describe("useSchmock composable", () => {
    it("provides access to mock instance", () => {
      const mock = schmock();
      const wrapper = mountWith(MockInspector, mock);
      expect(wrapper.find("[data-testid='call-count']").text()).toBe("0");
      wrapper.unmount();
    });

    it("throws descriptive error without plugin", () => {
      expect(() => mount(MockInspector)).toThrow(/schmockPlugin/);
    });
  });

  describe("POST and mutations", () => {
    it("handles POST with JSON body round-trip", async () => {
      const mock = schmock();
      mock("POST /api/users", ({ body }) => [201, body]);

      const wrapper = mountWith(PostForm, mock);
      await flushPromises();
      await vi.waitFor(() => {
        expect(wrapper.find("[data-testid='result']").text()).toBe("NewUser");
      });
      expect(mock.callCount("POST", "/api/users")).toBe(1);
      wrapper.unmount();
    });
  });

  describe("error handling", () => {
    it("error status codes flow through to components", async () => {
      const mock = schmock();
      mock("GET /api/failing", [500, { message: "broken" }]);

      const wrapper = mountWith(ErrorDisplay, mock);
      await flushPromises();
      await vi.waitFor(() => {
        expect(wrapper.find("[data-testid='error']").text()).toBe("Error: 500");
      });
      wrapper.unmount();
    });
  });

  describe("concurrent fetches", () => {
    it("handles parallel fetches from one component", async () => {
      const mock = schmock();
      mock("GET /api/users", [{ id: 1 }]);
      mock("GET /api/posts", [{ id: 10 }, { id: 11 }]);
      mock("GET /api/tags", ["a", "b", "c"]);

      const wrapper = mountWith(MultiLoader, mock);
      await flushPromises();
      await vi.waitFor(() => {
        expect(wrapper.find("[data-testid='users-count']").text()).toBe("1");
        expect(wrapper.find("[data-testid='posts-count']").text()).toBe("2");
        expect(wrapper.find("[data-testid='tags-count']").text()).toBe("3");
      });
      expect(mock.callCount()).toBe(3);
      wrapper.unmount();
    });
  });

  describe("passthrough", () => {
    it("unmatched routes hit the original fetch", async () => {
      const fakeFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
      const mock = schmock();
      mock("GET /api/users", []);

      const wrapper = mountWith(
        defineComponent({ render: () => h("div") }),
        mock,
        { passthrough: true },
      );

      await fetch("http://localhost/api/unknown");
      expect(fakeFetch).toHaveBeenCalled();
      wrapper.unmount();
    });
  });
});
