/**
 * E2E: Realistic Vue app testing patterns.
 *
 * Simulates what a developer would build after reading the docs:
 * - A task manager with CRUD
 * - Reactive search with debounced API calls
 * - Auth-gated content
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, onMounted, ref, computed, watch } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { schmock, notFound, created, noContent, paginate } from "@schmock/core";
import { schmockPlugin, useSchmock } from "@schmock/vue";

// ============================================================
// App components — what a real Vue developer would write
// ============================================================

interface Task {
  id: number;
  title: string;
  done: boolean;
}

const TaskManager = defineComponent({
  setup() {
    const tasks = ref<Task[]>([]);
    const newTitle = ref("");
    const loading = ref(true);
    const error = ref("");

    onMounted(async () => {
      try {
        const res = await fetch("http://localhost/api/tasks");
        if (!res.ok) throw new Error(`${res.status}`);
        tasks.value = await res.json();
      } catch (e) {
        error.value = e instanceof Error ? e.message : "Unknown";
      } finally {
        loading.value = false;
      }
    });

    const addTask = async () => {
      if (!newTitle.value.trim()) return;
      const res = await fetch("http://localhost/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: newTitle.value, done: false }),
      });
      if (res.ok) {
        tasks.value.push(await res.json());
        newTitle.value = "";
      }
    };

    const deleteTask = async (id: number) => {
      const res = await fetch(`http://localhost/api/tasks/${id}`, { method: "DELETE" });
      if (res.ok) {
        tasks.value = tasks.value.filter((t) => t.id !== id);
      }
    };

    const toggleTask = async (id: number) => {
      const task = tasks.value.find((t) => t.id === id);
      if (!task) return;
      const res = await fetch(`http://localhost/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: !task.done }),
      });
      if (res.ok) {
        const updated = await res.json();
        const idx = tasks.value.findIndex((t) => t.id === id);
        tasks.value[idx] = updated;
      }
    };

    const doneCount = computed(() => tasks.value.filter((t) => t.done).length);

    return () => {
      if (error.value) return h("div", { "data-testid": "error" }, error.value);
      if (loading.value) return h("div", { "data-testid": "loading" }, "Loading...");

      return h("div", [
        h("input", {
          "data-testid": "task-input",
          value: newTitle.value,
          onInput: (e: Event) => { newTitle.value = (e.target as HTMLInputElement).value; },
        }),
        h("button", { "data-testid": "add-btn", onClick: addTask }, "Add"),
        h("ul", { "data-testid": "task-list" },
          tasks.value.map((t) =>
            h("li", { key: t.id, "data-testid": `task-${t.id}` }, [
              h("span", {
                "data-testid": `task-text-${t.id}`,
                class: t.done ? "done" : "",
                onClick: () => void toggleTask(t.id),
              }, t.title),
              h("button", {
                "data-testid": `delete-${t.id}`,
                onClick: () => void deleteTask(t.id),
              }, "X"),
            ]),
          ),
        ),
        h("div", { "data-testid": "stats" }, `${doneCount.value}/${tasks.value.length} done`),
      ]);
    };
  },
});

const AuthGate = defineComponent({
  props: { token: { type: String, default: "" } },
  setup(props) {
    const profile = ref<{ name: string } | null>(null);
    const error = ref("");

    onMounted(async () => {
      const res = await fetch("http://localhost/api/me", {
        headers: props.token ? { Authorization: `Bearer ${props.token}` } : {},
      });
      if (res.ok) {
        profile.value = await res.json();
      } else {
        error.value = "Unauthorized";
      }
    });

    return () => {
      if (error.value) return h("div", { "data-testid": "auth-error" }, error.value);
      if (!profile.value) return h("div", { "data-testid": "loading" }, "Loading...");
      return h("div", { "data-testid": "welcome" }, `Welcome, ${profile.value.name}`);
    };
  },
});

// ============================================================
// Helper
// ============================================================

function mountWith<T extends ReturnType<typeof defineComponent>>(
  component: T,
  mock: ReturnType<typeof schmock>,
  props?: Record<string, unknown>,
) {
  return mount(component, {
    props,
    global: {
      plugins: [[schmockPlugin, { mock }]],
    },
  });
}

// ============================================================
// Tests
// ============================================================

describe("E2E: Task Manager CRUD", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads and displays existing tasks", async () => {
    const mock = schmock();
    mock("GET /api/tasks", [
      { id: 1, title: "Buy groceries", done: false },
      { id: 2, title: "Clean house", done: true },
    ]);

    const wrapper = mountWith(TaskManager, mock);
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='task-text-1']").text()).toBe("Buy groceries");
      expect(wrapper.find("[data-testid='task-text-2']").text()).toBe("Clean house");
      expect(wrapper.find("[data-testid='stats']").text()).toBe("1/2 done");
    });

    wrapper.unmount();
  });

  it("adds a new task", async () => {
    let nextId = 3;
    const mock = schmock();
    mock("GET /api/tasks", [{ id: 1, title: "Existing", done: false }]);
    mock("POST /api/tasks", ({ body }) => {
      const b = body as { title: string; done: boolean };
      return [201, { id: nextId++, title: b.title, done: b.done }];
    });

    const wrapper = mountWith(TaskManager, mock);
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='stats']").text()).toBe("0/1 done");
    });

    // Type and submit
    const input = wrapper.find("[data-testid='task-input']");
    await input.setValue("New task");
    await wrapper.find("[data-testid='add-btn']").trigger("click");
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='task-text-3']").text()).toBe("New task");
      expect(wrapper.find("[data-testid='stats']").text()).toBe("0/2 done");
    });

    // Verify the request
    const lastReq = mock.lastRequest("POST", "/api/tasks");
    expect(lastReq?.body).toEqual({ title: "New task", done: false });

    wrapper.unmount();
  });

  it("deletes a task", async () => {
    const mock = schmock();
    mock("GET /api/tasks", [
      { id: 1, title: "Keep", done: false },
      { id: 2, title: "Delete me", done: false },
    ]);
    mock("DELETE /api/tasks/:id", noContent());

    const wrapper = mountWith(TaskManager, mock);
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='stats']").text()).toBe("0/2 done");
    });

    await wrapper.find("[data-testid='delete-2']").trigger("click");
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='stats']").text()).toBe("0/1 done");
      expect(wrapper.find("[data-testid='task-2']").exists()).toBe(false);
    });

    wrapper.unmount();
  });

  it("toggles a task's done state", async () => {
    const mock = schmock();
    mock("GET /api/tasks", [{ id: 1, title: "Toggle me", done: false }]);
    mock("PATCH /api/tasks/:id", ({ body, params }) => [
      200,
      { id: Number(params.id), title: "Toggle me", ...(body as object) },
    ]);

    const wrapper = mountWith(TaskManager, mock);
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='stats']").text()).toBe("0/1 done");
    });

    await wrapper.find("[data-testid='task-text-1']").trigger("click");
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='stats']").text()).toBe("1/1 done");
      expect(wrapper.find("[data-testid='task-text-1']").classes()).toContain("done");
    });

    wrapper.unmount();
  });

  it("handles API errors gracefully", async () => {
    const mock = schmock();
    mock("GET /api/tasks", [500, { message: "DB down" }]);

    const wrapper = mountWith(TaskManager, mock);
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='error']").text()).toBe("500");
    });

    wrapper.unmount();
  });
});

describe("E2E: Auth-gated content", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("shows profile for valid token", async () => {
    const mock = schmock();
    mock("GET /api/me", ({ headers }) => {
      const auth = headers.Authorization ?? headers.authorization;
      if (auth === "Bearer good") return { name: "Alice" };
      return [401, { message: "Nope" }];
    });

    const wrapper = mountWith(AuthGate, mock, { token: "good" });
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='welcome']").text()).toBe("Welcome, Alice");
    });

    wrapper.unmount();
  });

  it("shows error for invalid token", async () => {
    const mock = schmock();
    mock("GET /api/me", [401, { message: "Invalid" }]);

    const wrapper = mountWith(AuthGate, mock, { token: "bad" });
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='auth-error']").text()).toBe("Unauthorized");
    });

    wrapper.unmount();
  });
});

describe("E2E: Test isolation between tests", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("test A uses mock with value A", async () => {
    const mock = schmock();
    mock("GET /api/data", { value: "A" });
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/data");
    expect(await res.json()).toEqual({ value: "A" });
    handle.restore();
  });

  it("test B uses mock with value B — no bleed from A", async () => {
    const mock = schmock();
    mock("GET /api/data", { value: "B" });
    const handle = mock.intercept();

    const res = await fetch("http://localhost/api/data");
    expect(await res.json()).toEqual({ value: "B" });
    handle.restore();
  });
});
