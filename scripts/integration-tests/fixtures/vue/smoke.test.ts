/**
 * E2E: Todo app with Vue 3 + schmockPlugin.
 *
 * Same Todo CRUD baseline as every adapter fixture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, onMounted, ref, computed } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { schmock, notFound } from "@schmock/core";
import { schmockPlugin } from "@schmock/vue";

// ===== Todo App Component =====

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

const TodoApp = defineComponent({
  setup() {
    const todos = ref<Todo[]>([]);
    const input = ref("");
    const loading = ref(true);
    const error = ref("");

    onMounted(async () => {
      try {
        const res = await fetch("http://localhost/api/todos");
        if (!res.ok) throw new Error(`${res.status}`);
        todos.value = await res.json();
      } catch (e) {
        error.value = e instanceof Error ? e.message : "Unknown";
      } finally {
        loading.value = false;
      }
    });

    const addTodo = async () => {
      if (!input.value.trim()) return;
      const res = await fetch("http://localhost/api/todos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: input.value, done: false }),
      });
      if (res.ok) {
        todos.value.push(await res.json());
        input.value = "";
      }
    };

    const toggleTodo = async (id: number) => {
      const todo = todos.value.find((t) => t.id === id);
      if (!todo) return;
      const res = await fetch(`http://localhost/api/todos/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: !todo.done }),
      });
      if (res.ok) {
        const updated = await res.json();
        const idx = todos.value.findIndex((t) => t.id === id);
        todos.value[idx] = updated;
      }
    };

    const deleteTodo = async (id: number) => {
      const res = await fetch(`http://localhost/api/todos/${id}`, { method: "DELETE" });
      if (res.ok) {
        todos.value = todos.value.filter((t) => t.id !== id);
      }
    };

    const doneCount = computed(() => todos.value.filter((t) => t.done).length);

    return () => {
      if (error.value) return h("div", { "data-testid": "error" }, error.value);
      if (loading.value) return h("div", { "data-testid": "loading" }, "Loading...");

      return h("div", [
        h("input", {
          "data-testid": "todo-input",
          value: input.value,
          onInput: (e: Event) => { input.value = (e.target as HTMLInputElement).value; },
        }),
        h("button", { "data-testid": "add-btn", onClick: addTodo }, "Add"),
        h("ul", { "data-testid": "todo-list" },
          todos.value.map((t) =>
            h("li", { key: t.id, "data-testid": `todo-${t.id}` }, [
              h("span", {
                "data-testid": `text-${t.id}`,
                class: t.done ? "done" : "",
                onClick: () => void toggleTodo(t.id),
              }, t.title),
              h("button", {
                "data-testid": `delete-${t.id}`,
                onClick: () => void deleteTodo(t.id),
              }, "X"),
            ]),
          ),
        ),
        h("div", { "data-testid": "count" }, `${todos.value.length} todos`),
        h("div", { "data-testid": "done" }, `${doneCount.value} done`),
      ]);
    };
  },
});

// ===== Stateful mock factory (same backend as core fixture) =====

function createTodoMock() {
  const mock = schmock({
    state: {
      todos: [
        { id: 1, title: "Buy milk", done: false },
        { id: 2, title: "Write tests", done: true },
      ] as Todo[],
      nextId: 3,
    },
  });

  mock("GET /api/todos", ({ state }) => state.todos);

  mock("POST /api/todos", ({ body, state }) => {
    const b = body as { title: string; done: boolean };
    const todo = { id: (state as any).nextId++, title: b.title, done: b.done };
    (state as any).todos.push(todo);
    return [201, todo];
  });

  mock("PATCH /api/todos/:id", ({ params, body, state }) => {
    const todos = (state as any).todos as Todo[];
    const todo = todos.find((t) => t.id === Number(params.id));
    if (!todo) return notFound("Todo not found");
    Object.assign(todo, body);
    return todo;
  });

  mock("DELETE /api/todos/:id", ({ params, state }) => {
    const todos = (state as any).todos as Todo[];
    const idx = todos.findIndex((t) => t.id === Number(params.id));
    if (idx === -1) return notFound("Todo not found");
    todos.splice(idx, 1);
    return [204, null];
  });

  return mock;
}

function mountTodo(mock: ReturnType<typeof schmock>) {
  return mount(TodoApp, {
    global: { plugins: [[schmockPlugin, { mock }]] },
  });
}

// ===== Tests =====

describe("Todo App — Vue (schmockPlugin)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads all todos", async () => {
    const mock = createTodoMock();
    const wrapper = mountTodo(mock);
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='text-1']").text()).toBe("Buy milk");
      expect(wrapper.find("[data-testid='text-2']").text()).toBe("Write tests");
      expect(wrapper.find("[data-testid='count']").text()).toBe("2 todos");
      expect(wrapper.find("[data-testid='done']").text()).toBe("1 done");
    });
    wrapper.unmount();
  });

  it("adds a new todo", async () => {
    const mock = createTodoMock();
    const wrapper = mountTodo(mock);
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find("[data-testid='count']").text()).toBe("2 todos"));

    await wrapper.find("[data-testid='todo-input']").setValue("Ship it");
    await wrapper.find("[data-testid='add-btn']").trigger("click");
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='count']").text()).toBe("3 todos");
      expect(wrapper.find("[data-testid='text-3']").text()).toBe("Ship it");
    });

    expect(mock.lastRequest("POST", "/api/todos")?.body).toEqual({ title: "Ship it", done: false });
    wrapper.unmount();
  });

  it("deletes a todo", async () => {
    const mock = createTodoMock();
    const wrapper = mountTodo(mock);
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find("[data-testid='count']").text()).toBe("2 todos"));

    await wrapper.find("[data-testid='delete-1']").trigger("click");
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='count']").text()).toBe("1 todos");
      expect(wrapper.find("[data-testid='todo-1']").exists()).toBe(false);
    });
    wrapper.unmount();
  });

  it("toggles a todo's done state", async () => {
    const mock = createTodoMock();
    const wrapper = mountTodo(mock);
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find("[data-testid='done']").text()).toBe("1 done"));

    await wrapper.find("[data-testid='text-1']").trigger("click");
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='done']").text()).toBe("2 done");
      expect(wrapper.find("[data-testid='text-1']").classes()).toContain("done");
    });
    wrapper.unmount();
  });

  it("handles API errors gracefully", async () => {
    const mock = schmock();
    mock("GET /api/todos", [500, { message: "DB down" }]);

    const wrapper = mountTodo(mock);
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='error']").text()).toBe("500");
    });
    wrapper.unmount();
  });

  it("full lifecycle: add, toggle, delete", async () => {
    const mock = createTodoMock();
    const wrapper = mountTodo(mock);
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find("[data-testid='count']").text()).toBe("2 todos"));

    // Add
    await wrapper.find("[data-testid='todo-input']").setValue("New");
    await wrapper.find("[data-testid='add-btn']").trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find("[data-testid='count']").text()).toBe("3 todos"));

    // Toggle
    await wrapper.find("[data-testid='text-3']").trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find("[data-testid='text-3']").classes()).toContain("done"));

    // Delete
    await wrapper.find("[data-testid='delete-3']").trigger("click");
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find("[data-testid='count']").text()).toBe("2 todos"));

    wrapper.unmount();
  });

  it("spy: tracks all operations", async () => {
    const mock = createTodoMock();
    const wrapper = mountTodo(mock);
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find("[data-testid='count']").text()).toBe("2 todos"));

    await wrapper.find("[data-testid='todo-input']").setValue("X");
    await wrapper.find("[data-testid='add-btn']").trigger("click");
    await flushPromises();

    await wrapper.find("[data-testid='delete-1']").trigger("click");
    await flushPromises();

    expect(mock.called("GET", "/api/todos")).toBe(true);
    expect(mock.called("POST", "/api/todos")).toBe(true);
    expect(mock.called("DELETE", "/api/todos/1")).toBe(true);
    wrapper.unmount();
  });

  it("test isolation: fresh state each test", async () => {
    const mock = createTodoMock();
    const wrapper = mountTodo(mock);
    await flushPromises();

    await vi.waitFor(() => {
      expect(wrapper.find("[data-testid='count']").text()).toBe("2 todos");
    });
    expect(mock.callCount()).toBe(1);
    wrapper.unmount();
  });
});
