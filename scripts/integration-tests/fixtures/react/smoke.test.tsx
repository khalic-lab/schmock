/**
 * E2E: Todo app with React + SchmockProvider.
 *
 * Same Todo CRUD baseline as every adapter fixture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useEffect, useState, useCallback } from "react";
import { schmock, notFound, noContent } from "@schmock/core";
import { SchmockProvider, useSchmock } from "@schmock/react";
import { renderWithSchmock } from "@schmock/react/testing";

// ===== Todo App Component =====

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

function TodoApp() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadTodos = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("http://localhost/api/todos");
      if (!res.ok) throw new Error(`${res.status}`);
      setTodos(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadTodos(); }, [loadTodos]);

  const addTodo = async () => {
    if (!input.trim()) return;
    const res = await fetch("http://localhost/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: input, done: false }),
    });
    if (res.ok) {
      const todo = await res.json();
      setTodos((prev) => [...prev, todo]);
      setInput("");
    }
  };

  const toggleTodo = async (id: number) => {
    const todo = todos.find((t) => t.id === id);
    if (!todo) return;
    const res = await fetch(`http://localhost/api/todos/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: !todo.done }),
    });
    if (res.ok) {
      const updated = await res.json();
      setTodos((prev) => prev.map((t) => (t.id === id ? updated : t)));
    }
  };

  const deleteTodo = async (id: number) => {
    const res = await fetch(`http://localhost/api/todos/${id}`, { method: "DELETE" });
    if (res.ok) setTodos((prev) => prev.filter((t) => t.id !== id));
  };

  if (error) return <div data-testid="error">{error}</div>;
  if (loading) return <div data-testid="loading">Loading...</div>;

  return (
    <div>
      <div>
        <input data-testid="todo-input" value={input} onChange={(e) => setInput(e.target.value)} />
        <button data-testid="add-btn" onClick={() => void addTodo()}>Add</button>
      </div>
      <ul data-testid="todo-list">
        {todos.map((t) => (
          <li key={t.id} data-testid={`todo-${t.id}`}>
            <span
              data-testid={`text-${t.id}`}
              style={{ textDecoration: t.done ? "line-through" : "none" }}
              onClick={() => void toggleTodo(t.id)}
            >
              {t.title}
            </span>
            <button data-testid={`delete-${t.id}`} onClick={() => void deleteTodo(t.id)}>X</button>
          </li>
        ))}
      </ul>
      <div data-testid="count">{todos.length} todos</div>
    </div>
  );
}

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

// ===== Tests =====

describe("Todo App — React (SchmockProvider)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("loads all todos", async () => {
    const mock = createTodoMock();
    render(<SchmockProvider mock={mock}><TodoApp /></SchmockProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("text-1").textContent).toBe("Buy milk");
      expect(screen.getByTestId("text-2").textContent).toBe("Write tests");
      expect(screen.getByTestId("count").textContent).toBe("2 todos");
    });
  });

  it("adds a new todo", async () => {
    const user = userEvent.setup();
    const mock = createTodoMock();
    render(<SchmockProvider mock={mock}><TodoApp /></SchmockProvider>);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2 todos"));

    await user.type(screen.getByTestId("todo-input"), "Ship it");
    await user.click(screen.getByTestId("add-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("3 todos");
      expect(screen.getByTestId("text-3").textContent).toBe("Ship it");
    });

    expect(mock.lastRequest("POST", "/api/todos")?.body).toEqual({ title: "Ship it", done: false });
  });

  it("deletes a todo", async () => {
    const user = userEvent.setup();
    const mock = createTodoMock();
    render(<SchmockProvider mock={mock}><TodoApp /></SchmockProvider>);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2 todos"));

    await user.click(screen.getByTestId("delete-1"));

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("1 todos");
      expect(screen.queryByTestId("todo-1")).toBeNull();
    });
  });

  it("toggles a todo's done state", async () => {
    const user = userEvent.setup();
    const mock = createTodoMock();
    render(<SchmockProvider mock={mock}><TodoApp /></SchmockProvider>);

    await waitFor(() => expect(screen.getByTestId("text-1")).toBeDefined());

    await user.click(screen.getByTestId("text-1"));

    await waitFor(() => {
      expect(screen.getByTestId("text-1").style.textDecoration).toBe("line-through");
    });
  });

  it("handles API errors gracefully", async () => {
    const mock = schmock();
    mock("GET /api/todos", [500, { message: "DB down" }]);

    render(<SchmockProvider mock={mock}><TodoApp /></SchmockProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe("500");
    });
  });

  it("full lifecycle: add, toggle, delete", async () => {
    const user = userEvent.setup();
    const mock = createTodoMock();
    render(<SchmockProvider mock={mock}><TodoApp /></SchmockProvider>);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2 todos"));

    // Add
    await user.type(screen.getByTestId("todo-input"), "New");
    await user.click(screen.getByTestId("add-btn"));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("3 todos"));

    // Toggle
    await user.click(screen.getByTestId("text-3"));
    await waitFor(() => {
      expect(screen.getByTestId("text-3").style.textDecoration).toBe("line-through");
    });

    // Delete
    await user.click(screen.getByTestId("delete-3"));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2 todos"));
  });

  it("spy: tracks all operations", async () => {
    const user = userEvent.setup();
    const mock = createTodoMock();
    render(<SchmockProvider mock={mock}><TodoApp /></SchmockProvider>);

    await waitFor(() => expect(screen.getByTestId("count")).toBeDefined());

    await user.type(screen.getByTestId("todo-input"), "X");
    await user.click(screen.getByTestId("add-btn"));
    await waitFor(() => expect(screen.getByTestId("text-3")).toBeDefined());

    await user.click(screen.getByTestId("delete-1"));
    await waitFor(() => expect(screen.queryByTestId("todo-1")).toBeNull());

    expect(mock.called("GET", "/api/todos")).toBe(true);
    expect(mock.called("POST", "/api/todos")).toBe(true);
    expect(mock.called("DELETE", "/api/todos/1")).toBe(true);
  });

  it("test isolation: fresh state each test", async () => {
    const mock = createTodoMock();
    render(<SchmockProvider mock={mock}><TodoApp /></SchmockProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("2 todos");
    });

    expect(mock.callCount()).toBe(1); // Just the initial GET
  });

  it("renderWithSchmock shorthand works", async () => {
    const { mock } = renderWithSchmock(<TodoApp />, {
      routes: [["GET /api/todos", [{ id: 10, title: "Quick", done: false }]]],
    });

    await waitFor(() => {
      expect(screen.getByTestId("text-10").textContent).toBe("Quick");
      expect(screen.getByTestId("count").textContent).toBe("1 todos");
    });
  });
});
