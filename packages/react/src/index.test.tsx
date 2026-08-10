/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchmockProvider, useSchmock } from "./index.js";
import { renderWithSchmock } from "./testing.js";

function UserList() {
  const [users, setUsers] = useState<Array<{ id: number; name: string }>>([]);

  useEffect(() => {
    void fetch("http://localhost/api/users")
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

function LayoutEffectFetcher() {
  const [source, setSource] = useState("loading");

  useLayoutEffect(() => {
    let active = true;
    void fetch("http://localhost/api/layout-effect")
      .then((response) => response.json())
      .then((body: unknown) => {
        if (
          active &&
          typeof body === "object" &&
          body !== null &&
          "source" in body &&
          typeof body.source === "string"
        ) {
          setSource(body.source);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return <div data-testid="layout-effect-source">{source}</div>;
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

  it("intercepts descendant layout effects on the first commit", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ source: "real" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const mock = schmock();
    mock("GET /api/layout-effect", { source: "mock" });

    render(
      <SchmockProvider mock={mock}>
        <LayoutEffectFetcher />
      </SchmockProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("layout-effect-source").textContent).toBe(
        "mock",
      );
    });
  });

  it("survives StrictMode's setup-cleanup-setup lifecycle", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1, name: "Strict Alice" }]);
    const savedFetch = globalThis.fetch;

    const { unmount } = render(
      <StrictMode>
        <SchmockProvider mock={mock}>
          <UserList />
        </SchmockProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByText("Strict Alice")).toBeDefined();
    });

    unmount();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("composes nested providers and restores their handles together", async () => {
    const outerMock = schmock();
    outerMock("GET /api/outer", { source: "outer" });
    const innerMock = schmock();
    innerMock("GET /api/inner", { source: "inner" });
    const savedFetch = globalThis.fetch;

    const { unmount } = render(
      <SchmockProvider mock={outerMock}>
        <SchmockProvider mock={innerMock}>
          <div />
        </SchmockProvider>
      </SchmockProvider>,
    );

    const outerResponse = await fetch("http://localhost/api/outer");
    const innerResponse = await fetch("http://localhost/api/inner");
    expect(await outerResponse.json()).toEqual({ source: "outer" });
    expect(await innerResponse.json()).toEqual({ source: "inner" });

    unmount();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("keeps a sibling provider active when an older sibling unmounts", async () => {
    const olderMock = schmock();
    olderMock("GET /api/older", { source: "older" });
    const newerMock = schmock();
    newerMock("GET /api/newer", { source: "newer" });
    const savedFetch = globalThis.fetch;

    const Providers = ({ showOlder }: { showOlder: boolean }) => (
      <>
        {showOlder ? (
          <SchmockProvider mock={olderMock}>
            <div />
          </SchmockProvider>
        ) : null}
        <SchmockProvider mock={newerMock}>
          <div />
        </SchmockProvider>
      </>
    );

    const { rerender, unmount } = render(<Providers showOlder />);
    rerender(<Providers showOlder={false} />);

    const response = await fetch("http://localhost/api/newer");
    expect(await response.json()).toEqual({ source: "newer" });

    unmount();
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("does not mutate fetch when provider rendering is abandoned", () => {
    const mock = schmock();
    const savedFetch = globalThis.fetch;

    function BrokenChild(): never {
      throw new Error("render failed");
    }

    expect(() =>
      render(
        <SchmockProvider mock={mock}>
          <BrokenChild />
        </SchmockProvider>,
      ),
    ).toThrow("render failed");
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

  it("shares one mock with an outer provider already intercepting", async () => {
    const mock = schmock();
    mock("GET /api/users", [{ id: 1, name: "Shared" }]);

    render(
      <SchmockProvider mock={mock}>
        <div />
      </SchmockProvider>,
    );

    expect(() => renderWithSchmock(<UserList />, { mock })).not.toThrow();

    await waitFor(() => {
      expect(screen.getByText("Shared")).toBeDefined();
    });
  });

  it("rerender preserves provider context", async () => {
    const { rerender } = renderWithSchmock(<MockConsumer />, {
      routes: [],
    });

    await waitFor(() => {
      expect(screen.getByTestId("has-mock").textContent).toBe("yes");
    });

    // Rerender should still have the provider wrapping
    rerender(<MockConsumer />);

    await waitFor(() => {
      expect(screen.getByTestId("has-mock").textContent).toBe("yes");
    });
  });
});
