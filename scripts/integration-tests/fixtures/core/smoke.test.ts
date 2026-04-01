/**
 * E2E: Todo app using mock.intercept() directly — no framework.
 *
 * Baseline test: same Todo CRUD in every adapter fixture.
 * This version uses bare fetch with mock.intercept().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { schmock, notFound, created, noContent } from "@schmock/core";

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

describe("Todo App — core (mock.intercept)", () => {
  let mock: ReturnType<typeof schmock>;
  let handle: ReturnType<ReturnType<typeof schmock>["intercept"]>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));

    mock = schmock({
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

    handle = mock.intercept();
  });

  afterEach(() => {
    handle.restore();
    globalThis.fetch = originalFetch;
  });

  it("loads all todos", async () => {
    const res = await fetch("http://localhost/api/todos");
    expect(res.status).toBe(200);
    const todos = await res.json();
    expect(todos).toHaveLength(2);
    expect(todos[0].title).toBe("Buy milk");
    expect(todos[1].done).toBe(true);
  });

  it("adds a new todo", async () => {
    const res = await fetch("http://localhost/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New todo", done: false }),
    });
    expect(res.status).toBe(201);
    const todo = await res.json();
    expect(todo.id).toBe(3);
    expect(todo.title).toBe("New todo");

    // Verify it persists in state
    const list = await fetch("http://localhost/api/todos");
    expect(await list.json()).toHaveLength(3);
  });

  it("toggles a todo's done state", async () => {
    const res = await fetch("http://localhost/api/todos/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(200);
    const todo = await res.json();
    expect(todo.done).toBe(true);
    expect(todo.title).toBe("Buy milk");
  });

  it("deletes a todo", async () => {
    const res = await fetch("http://localhost/api/todos/1", { method: "DELETE" });
    expect(res.status).toBe(204);

    const list = await fetch("http://localhost/api/todos");
    const todos = await list.json();
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe(2);
  });

  it("returns 404 for missing todo", async () => {
    const res = await fetch("http://localhost/api/todos/999", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(404);
  });

  it("handles full lifecycle: add, toggle, delete", async () => {
    // Add
    const createRes = await fetch("http://localhost/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Ship it", done: false }),
    });
    const newTodo = await createRes.json();

    // Toggle
    await fetch(`http://localhost/api/todos/${newTodo.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: true }),
    });

    // Delete
    await fetch(`http://localhost/api/todos/${newTodo.id}`, { method: "DELETE" });

    // Verify original 2 remain
    const list = await fetch("http://localhost/api/todos");
    expect(await list.json()).toHaveLength(2);
  });

  it("spy: tracks all operations", async () => {
    await fetch("http://localhost/api/todos");
    await fetch("http://localhost/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "X", done: false }),
    });
    await fetch("http://localhost/api/todos/1", { method: "DELETE" });

    expect(mock.callCount()).toBe(3);
    expect(mock.called("GET", "/api/todos")).toBe(true);
    expect(mock.called("POST", "/api/todos")).toBe(true);
    expect(mock.called("DELETE", "/api/todos/1")).toBe(true);

    const postReq = mock.lastRequest("POST", "/api/todos");
    expect(postReq?.body).toEqual({ title: "X", done: false });
  });

  it("test isolation: state resets between tests", async () => {
    // This runs after other tests modified state, but beforeEach recreates mock
    const res = await fetch("http://localhost/api/todos");
    const todos = await res.json();
    expect(todos).toHaveLength(2); // Always starts with 2
    expect(mock.callCount()).toBe(1); // Fresh history
  });
});
