/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import {
  act,
  cleanup,
  type RenderResult,
  render,
  screen,
} from "@testing-library/react";
import { type ReactNode, StrictMode, Suspense, use } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchmockProvider } from "./index.js";
import { renderWithSchmock } from "./testing.js";

const NETWORK = { src: "NETWORK" };
const MOCK = { src: "MOCK" };

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// React 19 retries a suspended tree only for renders a test awaits in act().
async function renderInAct(ui: ReactNode): Promise<RenderResult> {
  let result: RenderResult | undefined;
  await act(async () => {
    result = render(ui);
  });
  if (result === undefined) throw new Error("render did not run");
  return result;
}

function activeLeases(spy: {
  mock: { results: Array<{ value: unknown }> };
}): number {
  return spy.mock.results.filter(
    (result) =>
      typeof result.value === "object" &&
      result.value !== null &&
      "active" in result.value &&
      result.value.active === true,
  ).length;
}

describe("SchmockProvider render-phase interception (finding 3)", () => {
  let baselineFetch: typeof globalThis.fetch;
  let networkFetch: typeof globalThis.fetch;

  beforeEach(() => {
    baselineFetch = globalThis.fetch;
    networkFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(NETWORK),
    );
    globalThis.fetch = networkFetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = baselineFetch;
  });

  function createMock(): Schmock.CallableMockInstance {
    const mock = schmock();
    mock("GET /api/users", MOCK);
    return mock;
  }

  // The keyed promise cache TanStack useSuspenseQuery and SWR suspense use:
  // the fetch starts while the component renders, before any effect runs.
  function createSuspenseReader() {
    let pending: Promise<{ src: string }> | undefined;
    return function Users(): ReactNode {
      pending ??= fetch("http://localhost/api/users").then((response) =>
        response.json(),
      );
      const data = use(pending);
      return <p>source:{data.src}</p>;
    };
  }

  it("intercepts a fetch a child starts while it renders", async () => {
    const mock = createMock();
    let started: Promise<unknown> | undefined;
    function Eager(): ReactNode {
      started ??= fetch("http://localhost/api/users").then((response) =>
        response.json(),
      );
      return null;
    }

    render(
      <SchmockProvider mock={mock}>
        <Eager />
      </SchmockProvider>,
    );

    expect(await started).toEqual(MOCK);
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("serves a Suspense child under the provider from the mock", async () => {
    const mock = createMock();
    const Users = createSuspenseReader();

    await renderInAct(
      <SchmockProvider mock={mock}>
        <Suspense fallback="loading">
          <Users />
        </Suspense>
      </SchmockProvider>,
    );

    expect(await screen.findByText("source:MOCK")).toBeTruthy();
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("serves a Suspense boundary outside the provider and leaks no lease", async () => {
    const mock = createMock();
    const intercept = vi.spyOn(mock, "intercept");
    const Users = createSuspenseReader();

    const { unmount } = await renderInAct(
      <Suspense fallback="loading">
        <SchmockProvider mock={mock}>
          <Users />
        </SchmockProvider>
      </Suspense>,
    );

    expect(await screen.findByText("source:MOCK")).toBeTruthy();
    expect(networkFetch).not.toHaveBeenCalled();

    await flushMicrotasks();
    // The render that suspended never committed; its lease must not linger.
    expect(activeLeases(intercept)).toBe(1);

    unmount();
    await flushMicrotasks();
    expect(activeLeases(intercept)).toBe(0);
    expect(globalThis.fetch).toBe(networkFetch);
  });

  it("holds exactly one lease under StrictMode and releases it on unmount", async () => {
    const mock = createMock();
    const intercept = vi.spyOn(mock, "intercept");
    const Users = createSuspenseReader();

    const { unmount } = await renderInAct(
      <StrictMode>
        <SchmockProvider mock={mock}>
          <Suspense fallback="loading">
            <Users />
          </Suspense>
        </SchmockProvider>
      </StrictMode>,
    );

    expect(await screen.findByText("source:MOCK")).toBeTruthy();
    expect(networkFetch).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(activeLeases(intercept)).toBe(1);

    unmount();
    expect(activeLeases(intercept)).toBe(0);
    expect(globalThis.fetch).toBe(networkFetch);
  });

  it("gives renderWithSchmock the same render-phase guarantee", async () => {
    const Users = createSuspenseReader();

    await act(async () => {
      renderWithSchmock(
        <Suspense fallback="loading">
          <Users />
        </Suspense>,
        { routes: [["GET /api/users", MOCK]] },
      );
    });

    expect(await screen.findByText("source:MOCK")).toBeTruthy();
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("moves the lease to a new mock and releases the old one on commit", async () => {
    const first = createMock();
    const second = schmock();
    second("GET /api/users", { src: "SECOND" });
    const firstIntercept = vi.spyOn(first, "intercept");

    const { rerender } = render(
      <SchmockProvider mock={first}>
        <div />
      </SchmockProvider>,
    );
    rerender(
      <SchmockProvider mock={second}>
        <div />
      </SchmockProvider>,
    );
    await flushMicrotasks();

    expect(activeLeases(firstIntercept)).toBe(0);
    const response = await fetch("http://localhost/api/users");
    expect(await response.json()).toEqual({ src: "SECOND" });

    cleanup();
    await flushMicrotasks();
    expect(globalThis.fetch).toBe(networkFetch);
  });
});

describe("SchmockProvider DOM detection (finding 48)", () => {
  let baselineFetch: typeof globalThis.fetch;

  beforeEach(() => {
    baselineFetch = globalThis.fetch;
    globalThis.fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(NETWORK),
    );
  });

  afterEach(() => {
    globalThis.fetch = baselineFetch;
  });

  it("intercepts when the DOM appears after the adapter was imported", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    expect(descriptor?.configurable).toBe(true);

    // Hoisted imports run before a test registers its DOM: evaluate the
    // adapter (and the fresh React it binds to) with no document, then add
    // the DOM back. JSX would use this file's React, so elements are built
    // with the fresh instance's createElement.
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "document");
    let adapter: typeof import("./index.js");
    let react: typeof import("react");
    try {
      adapter = await import("./index.js");
      react = await import("react");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    }
    const { createRoot } = await import("react-dom/client");

    const mock = schmock();
    mock("GET /api/users", MOCK);
    const root = createRoot(document.createElement("div"));
    const children = null;
    await react.act(async () => {
      root.render(
        react.createElement(adapter.SchmockProvider, { mock, children }),
      );
    });

    try {
      const response = await fetch("http://localhost/api/users");
      expect(await response.json()).toEqual(MOCK);
    } finally {
      await react.act(async () => {
        root.unmount();
      });
    }
  });
});
