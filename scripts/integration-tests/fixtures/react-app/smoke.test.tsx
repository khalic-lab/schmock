/**
 * E2E: Realistic React app testing patterns.
 *
 * Simulates what a developer would build after reading the docs:
 * - A todo app with CRUD operations
 * - Authentication flow with protected routes
 * - Paginated list with load-more
 * - Error boundary handling
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useEffect, useState, useCallback } from "react";
import { schmock, notFound, created, noContent, paginate } from "@schmock/core";
import { SchmockProvider, useSchmock } from "@schmock/react";
import { renderWithSchmock } from "@schmock/react/testing";

// ============================================================
// App components — what a real developer would write
// ============================================================

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
    if (res.ok) {
      setTodos((prev) => prev.filter((t) => t.id !== id));
    }
  };

  if (error) return <div data-testid="error">{error}</div>;
  if (loading) return <div data-testid="loading">Loading...</div>;

  return (
    <div>
      <div>
        <input
          data-testid="todo-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button data-testid="add-btn" onClick={addTodo}>Add</button>
      </div>
      <ul data-testid="todo-list">
        {todos.map((t) => (
          <li key={t.id} data-testid={`todo-${t.id}`}>
            <span
              data-testid={`todo-text-${t.id}`}
              style={{ textDecoration: t.done ? "line-through" : "none" }}
              onClick={() => void toggleTodo(t.id)}
            >
              {t.title}
            </span>
            <button data-testid={`delete-${t.id}`} onClick={() => void deleteTodo(t.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      <div data-testid="count">{todos.length} todos</div>
    </div>
  );
}

function ProtectedPage() {
  const [data, setData] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    void fetch("http://localhost/api/profile", {
      headers: { Authorization: "Bearer valid-token" },
    }).then(async (res) => {
      if (res.status === 401) {
        setError("Please log in");
      } else {
        const json = await res.json();
        setData(json.name);
      }
    });
  }, []);

  if (error) return <div data-testid="auth-error">{error}</div>;
  if (!data) return <div data-testid="loading">Loading...</div>;
  return <div data-testid="profile">{data}</div>;
}

interface Article {
  id: number;
  title: string;
}

function PaginatedList() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(async (p: number) => {
    setLoading(true);
    const res = await fetch(`http://localhost/api/articles?page=${p}&pageSize=3`);
    const json = await res.json();
    setArticles((prev) => [...prev, ...json.data]);
    setTotalPages(json.totalPages);
    setPage(p);
    setLoading(false);
  }, []);

  useEffect(() => { void loadPage(1); }, [loadPage]);

  return (
    <div>
      <ul data-testid="article-list">
        {articles.map((a) => (
          <li key={a.id} data-testid={`article-${a.id}`}>{a.title}</li>
        ))}
      </ul>
      <div data-testid="page-info">Page {page} of {totalPages}</div>
      {page < totalPages && (
        <button
          data-testid="load-more"
          disabled={loading}
          onClick={() => void loadPage(page + 1)}
        >
          Load More
        </button>
      )}
    </div>
  );
}

// ============================================================
// Tests — realistic testing patterns
// ============================================================

describe("E2E: Todo App with full CRUD", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("loads and displays existing todos", async () => {
    renderWithSchmock(<TodoApp />, {
      routes: [
        ["GET /api/todos", [
          { id: 1, title: "Buy milk", done: false },
          { id: 2, title: "Write tests", done: true },
        ]],
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId("todo-1")).toBeDefined();
      expect(screen.getByTestId("todo-text-1").textContent).toBe("Buy milk");
      expect(screen.getByTestId("todo-text-2").textContent).toBe("Write tests");
      expect(screen.getByTestId("count").textContent).toBe("2 todos");
    });
  });

  it("adds a new todo via POST", async () => {
    const user = userEvent.setup();
    let nextId = 3;

    const mock = schmock();
    mock("GET /api/todos", [
      { id: 1, title: "Existing", done: false },
    ]);
    mock("POST /api/todos", ({ body }) => {
      const b = body as { title: string; done: boolean };
      return [201, { id: nextId++, title: b.title, done: b.done }];
    });

    render(
      <SchmockProvider mock={mock}>
        <TodoApp />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("1 todos");
    });

    await user.type(screen.getByTestId("todo-input"), "New todo");
    await user.click(screen.getByTestId("add-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("2 todos");
      expect(screen.getByTestId("todo-text-3").textContent).toBe("New todo");
    });

    expect(mock.callCount("POST", "/api/todos")).toBe(1);
    const lastReq = mock.lastRequest("POST", "/api/todos");
    expect(lastReq?.body).toEqual({ title: "New todo", done: false });
  });

  it("deletes a todo", async () => {
    const user = userEvent.setup();
    const mock = schmock();
    mock("GET /api/todos", [
      { id: 1, title: "To delete", done: false },
      { id: 2, title: "Keep this", done: false },
    ]);
    mock("DELETE /api/todos/:id", noContent());

    render(
      <SchmockProvider mock={mock}>
        <TodoApp />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("2 todos");
    });

    await user.click(screen.getByTestId("delete-1"));

    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("1 todos");
      expect(screen.queryByTestId("todo-1")).toBeNull();
      expect(screen.getByTestId("todo-2")).toBeDefined();
    });
  });

  it("handles API errors gracefully", async () => {
    renderWithSchmock(<TodoApp />, {
      routes: [["GET /api/todos", [500, { message: "Database down" }]]],
    });

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe("500");
    });
  });
});

describe("E2E: Authentication flow", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("shows profile for authenticated user", async () => {
    const mock = schmock();
    mock("GET /api/profile", ({ headers }) => {
      const auth = headers.Authorization ?? headers.authorization;
      if (auth === "Bearer valid-token") {
        return [200, { name: "Alice", role: "admin" }];
      }
      return [401, { message: "Unauthorized" }];
    });

    render(
      <SchmockProvider mock={mock}>
        <ProtectedPage />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("profile").textContent).toBe("Alice");
    });
  });

  it("shows login prompt for unauthenticated user", async () => {
    const mock = schmock();
    mock("GET /api/profile", [401, { message: "Unauthorized" }]);

    // Component sends a valid token, but mock ignores it and always returns 401
    render(
      <SchmockProvider mock={mock}>
        <ProtectedPage />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("auth-error").textContent).toBe("Please log in");
    });
  });
});

describe("E2E: Paginated list with load-more", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("loads first page and shows load-more button", async () => {
    const articles = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      title: `Article ${i + 1}`,
    }));

    const mock = schmock();
    mock("GET /api/articles", ({ query }) =>
      paginate(articles, {
        page: Number(query.page || "1"),
        pageSize: Number(query.pageSize || "3"),
      }),
    );

    render(
      <SchmockProvider mock={mock}>
        <PaginatedList />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("article-1")).toBeDefined();
      expect(screen.getByTestId("article-3")).toBeDefined();
      expect(screen.queryByTestId("article-4")).toBeNull();
      expect(screen.getByTestId("page-info").textContent).toBe("Page 1 of 3");
      expect(screen.getByTestId("load-more")).toBeDefined();
    });
  });

  it("loads more pages and hides button on last page", async () => {
    const user = userEvent.setup();
    const articles = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      title: `Article ${i + 1}`,
    }));

    const mock = schmock();
    mock("GET /api/articles", ({ query }) =>
      paginate(articles, {
        page: Number(query.page || "1"),
        pageSize: Number(query.pageSize || "3"),
      }),
    );

    render(
      <SchmockProvider mock={mock}>
        <PaginatedList />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("article-3")).toBeDefined();
    });

    await user.click(screen.getByTestId("load-more"));

    await waitFor(() => {
      // All 5 articles loaded (page 1: 3, page 2: 2)
      expect(screen.getByTestId("article-5")).toBeDefined();
      expect(screen.getByTestId("page-info").textContent).toBe("Page 2 of 2");
      // No more pages — button should be gone
      expect(screen.queryByTestId("load-more")).toBeNull();
    });

    expect(mock.callCount("GET", "/api/articles")).toBe(2);
  });
});

describe("E2E: Test isolation — no bleed between tests", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("test A: mocks /api/data with value A", async () => {
    const { mock } = renderWithSchmock(
      React.createElement("div", null, null),
      { routes: [["GET /api/data", { value: "A" }]] },
    );

    const res = await fetch("http://localhost/api/data");
    expect(await res.json()).toEqual({ value: "A" });
  });

  it("test B: mocks /api/data with value B — no leaking from test A", async () => {
    const { mock } = renderWithSchmock(
      React.createElement("div", null, null),
      { routes: [["GET /api/data", { value: "B" }]] },
    );

    const res = await fetch("http://localhost/api/data");
    expect(await res.json()).toEqual({ value: "B" });
  });
});
