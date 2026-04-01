import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import React, { useEffect, useState, useCallback } from "react";
import { schmock } from "@schmock/core";
import { SchmockProvider, useSchmock } from "@schmock/react";
import { renderWithSchmock } from "@schmock/react/testing";

// ===== Test Components =====

function UserList() {
  const [users, setUsers] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetch("http://localhost/api/users")
      .then((r) => r.json())
      .then((data) => {
        setUsers(data);
        setLoading(false);
      });
  }, []);

  if (loading) return <div data-testid="loading">Loading...</div>;
  return (
    <ul data-testid="user-list">
      {users.map((u) => (
        <li key={u.id} data-testid={`user-${u.id}`}>{u.name}</li>
      ))}
    </ul>
  );
}

function CreateForm({ onCreated }: { onCreated?: () => void }) {
  const [result, setResult] = useState<string>("");

  const handleSubmit = useCallback(async () => {
    const res = await fetch("http://localhost/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "NewUser" }),
    });
    const data = await res.json();
    setResult(data.name);
    onCreated?.();
  }, [onCreated]);

  return (
    <div>
      <button data-testid="submit" onClick={handleSubmit}>Create</button>
      {result && <span data-testid="result">{result}</span>}
    </div>
  );
}

function ErrorDisplay() {
  const [error, setError] = useState<string>("");

  useEffect(() => {
    void fetch("http://localhost/api/failing").then((r) => {
      if (!r.ok) setError(`Error: ${r.status}`);
    });
  }, []);

  return <div data-testid="error">{error || "loading"}</div>;
}

function MockInspector() {
  const mock = useSchmock();
  const [count, setCount] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCount(mock.callCount());
    }, 50);
    return () => clearInterval(interval);
  }, [mock]);

  return <div data-testid="call-count">{count}</div>;
}

function MultiLoader() {
  const [data, setData] = useState<Record<string, unknown>>({});

  useEffect(() => {
    void Promise.all([
      fetch("http://localhost/api/users").then((r) => r.json()),
      fetch("http://localhost/api/posts").then((r) => r.json()),
      fetch("http://localhost/api/tags").then((r) => r.json()),
    ]).then(([users, posts, tags]) => {
      setData({ users, posts, tags });
    });
  }, []);

  return (
    <div>
      <span data-testid="users-count">{Array.isArray(data.users) ? data.users.length : 0}</span>
      <span data-testid="posts-count">{Array.isArray(data.posts) ? data.posts.length : 0}</span>
      <span data-testid="tags-count">{Array.isArray(data.tags) ? data.tags.length : 0}</span>
    </div>
  );
}

// ===== Tests =====

describe("React adapter integration", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  describe("SchmockProvider lifecycle", () => {
    it("renders loading state then mocked data", async () => {
      const mock = schmock();
      mock("GET /api/users", [{ id: 1, name: "Alice" }]);

      render(
        <SchmockProvider mock={mock}>
          <UserList />
        </SchmockProvider>,
      );

      // Initially loading
      expect(screen.getByTestId("loading")).toBeDefined();

      // Then data appears
      await waitFor(() => {
        expect(screen.getByTestId("user-1")).toBeDefined();
        expect(screen.getByTestId("user-1").textContent).toBe("Alice");
      });
    });

    it("restores fetch on unmount — no leak between tests", () => {
      const mock = schmock();
      const fetchBefore = globalThis.fetch;

      const { unmount } = render(
        <SchmockProvider mock={mock}>
          <div />
        </SchmockProvider>,
      );

      expect(globalThis.fetch).not.toBe(fetchBefore);
      unmount();
      expect(globalThis.fetch).toBe(fetchBefore);
    });

    it("multiple components share one provider", async () => {
      const mock = schmock();
      mock("GET /api/users", [{ id: 1, name: "Alice" }]);

      render(
        <SchmockProvider mock={mock}>
          <UserList />
          <MockInspector />
        </SchmockProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("user-1")).toBeDefined();
        expect(screen.getByTestId("call-count").textContent).toBe("1");
      });
    });
  });

  describe("useSchmock hook", () => {
    it("provides access to spy API from within components", async () => {
      const mock = schmock();
      mock("GET /api/users", [{ id: 1, name: "Alice" }]);

      render(
        <SchmockProvider mock={mock}>
          <UserList />
          <MockInspector />
        </SchmockProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("call-count").textContent).toBe("1");
      });
    });

    it("throws descriptive error outside provider", () => {
      expect(() => render(<MockInspector />)).toThrow(/SchmockProvider/);
    });
  });

  describe("POST and mutations", () => {
    it("handles POST with JSON body round-trip", async () => {
      const mock = schmock();
      mock("GET /api/users", []);
      mock("POST /api/users", ({ body }) => [201, body]);

      render(
        <SchmockProvider mock={mock}>
          <CreateForm />
        </SchmockProvider>,
      );

      await act(async () => {
        screen.getByTestId("submit").click();
      });

      await waitFor(() => {
        expect(screen.getByTestId("result").textContent).toBe("NewUser");
      });

      expect(mock.callCount("POST", "/api/users")).toBe(1);
    });
  });

  describe("error handling", () => {
    it("error status codes flow through to components", async () => {
      const mock = schmock();
      mock("GET /api/failing", [500, { message: "broken" }]);

      render(
        <SchmockProvider mock={mock}>
          <ErrorDisplay />
        </SchmockProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("error").textContent).toBe("Error: 500");
      });
    });
  });

  describe("concurrent fetches", () => {
    it("handles parallel fetches from one component", async () => {
      const mock = schmock();
      mock("GET /api/users", [{ id: 1 }]);
      mock("GET /api/posts", [{ id: 10 }, { id: 11 }]);
      mock("GET /api/tags", ["a", "b", "c"]);

      render(
        <SchmockProvider mock={mock}>
          <MultiLoader />
        </SchmockProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("users-count").textContent).toBe("1");
        expect(screen.getByTestId("posts-count").textContent).toBe("2");
        expect(screen.getByTestId("tags-count").textContent).toBe("3");
      });

      expect(mock.callCount()).toBe(3);
    });
  });

  describe("renderWithSchmock utility", () => {
    it("sets up routes and provider in one call", async () => {
      const { mock } = renderWithSchmock(<UserList />, {
        routes: [["GET /api/users", [{ id: 1, name: "Bob" }]]],
      });

      await waitFor(() => {
        expect(screen.getByTestId("user-1").textContent).toBe("Bob");
      });

      expect(mock.called("GET", "/api/users")).toBe(true);
    });

    it("accepts a pre-configured mock instance", async () => {
      const mock = schmock();
      mock("GET /api/users", [{ id: 5, name: "Eve" }]);

      renderWithSchmock(<UserList />, { mock });

      await waitFor(() => {
        expect(screen.getByTestId("user-5").textContent).toBe("Eve");
      });
    });

    it("cleans up on unmount", () => {
      const fetchBefore = globalThis.fetch;

      const { unmount } = renderWithSchmock(<div />, {
        routes: [["GET /api/x", []]],
      });

      expect(globalThis.fetch).not.toBe(fetchBefore);
      unmount();
      expect(globalThis.fetch).toBe(fetchBefore);
    });
  });

  describe("passthrough", () => {
    it("unmatched routes hit the original fetch", async () => {
      const fakeFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
      const mock = schmock();
      mock("GET /api/users", []);

      render(
        <SchmockProvider mock={mock} options={{ passthrough: true }}>
          <div />
        </SchmockProvider>,
      );

      await fetch("http://localhost/api/unknown");
      expect(fakeFetch).toHaveBeenCalled();
    });
  });
});
