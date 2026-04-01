/// <reference path="../../core/schmock.d.ts" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import React, { useEffect, useState } from "react";
import { schmock } from "@schmock/core";
import { SchmockProvider, useSchmock } from "./index.js";
import { renderWithSchmock } from "./testing.js";

function UserList() {
  const [users, setUsers] = useState<Array<{ id: number; name: string }>>([]);

  useEffect(() => {
    fetch("http://localhost/api/users")
      .then((res) => res.json())
      .then(setUsers);
  }, []);

  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}

function MockConsumer() {
  const mock = useSchmock();
  return <div data-testid="has-mock">{mock ? "yes" : "no"}</div>;
}

describe("SchmockProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("intercepts fetch and provides mocked data", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1, name: "Alice" }]);

    render(
      <SchmockProvider mock={mock}>
        <UserList />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeDefined();
    });
  });

  it("restores fetch on unmount", () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;

    const { unmount } = render(
      <SchmockProvider mock={mock}>
        <div />
      </SchmockProvider>,
    );

    expect(globalThis.fetch).not.toBe(savedFetch);
    unmount();
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
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("returns the mock instance from context", async () => {
    const mock = schmock();

    render(
      <SchmockProvider mock={mock}>
        <MockConsumer />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("has-mock").textContent).toBe("yes");
    });
  });

  it("throws when used outside SchmockProvider", () => {
    expect(() => render(<MockConsumer />)).toThrow(/SchmockProvider/);
  });
});

describe("renderWithSchmock", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("sets up provider with routes and cleans up", async () => {
    const { unmount } = renderWithSchmock(<UserList />, {
      routes: [["GET /api/users", [{ id: 1, name: "Bob" }]]],
    });

    await waitFor(() => {
      expect(screen.getByText("Bob")).toBeDefined();
    });

    const fetchBeforeUnmount = globalThis.fetch;
    unmount();
    expect(globalThis.fetch).not.toBe(fetchBeforeUnmount);
  });
});
