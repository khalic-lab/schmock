/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, Suspense, use, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchmockProvider } from "./index.js";

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Shows its children until told to suspend on a promise. */
function createGate() {
  let suspendOn: (promise: Promise<void> | undefined) => void = () => {};
  function Gate() {
    const [pending, setPending] = useState<Promise<void> | undefined>();
    suspendOn = setPending;
    if (pending !== undefined) use(pending);
    return <p>shown</p>;
  }
  return { Gate, suspend: (promise: Promise<void>) => suspendOn(promise) };
}

async function who(): Promise<unknown> {
  const response = await fetch("http://localhost/api/who");
  return response.json();
}

describe("SchmockProvider under a Suspense boundary that re-suspends", () => {
  let baselineFetch: typeof globalThis.fetch;
  let networkFetch: typeof globalThis.fetch;

  beforeEach(() => {
    baselineFetch = globalThis.fetch;
    networkFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ who: "network" }),
    );
    globalThis.fetch = networkFetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = baselineFetch;
  });

  function mockAnswering(name: string): Schmock.CallableMockInstance {
    const mock = schmock();
    mock("GET /api/who", { who: name });
    return mock;
  }

  it("keeps fetch patched while the fallback shows", async () => {
    const mock = mockAnswering("inner");
    const { Gate, suspend } = createGate();
    const gate = deferred();

    await act(async () => {
      render(
        <Suspense fallback={<p>fallback</p>}>
          <SchmockProvider mock={mock}>
            <Gate />
          </SchmockProvider>
        </Suspense>,
      );
    });
    expect(screen.getByText("shown")).toBeTruthy();

    // A plain (non-transition) update: React hides the shown content.
    act(() => suspend(gate.promise));
    expect(screen.getByText("fallback")).toBeTruthy();

    expect(globalThis.fetch).not.toBe(networkFetch);
    expect(await who()).toEqual({ who: "inner" });
    expect(networkFetch).not.toHaveBeenCalled();

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(screen.getByText("shown")).toBeTruthy();
  });

  it("keeps its dispatch position across the hide and the reveal", async () => {
    const inner = mockAnswering("inner");
    const outer = mockAnswering("outer");
    const innerIntercept = vi.spyOn(inner, "intercept");
    const { Gate, suspend } = createGate();
    const gate = deferred();

    await act(async () => {
      render(
        <>
          <Suspense fallback={<p>fallback</p>}>
            <SchmockProvider mock={inner}>
              <Gate />
            </SchmockProvider>
          </Suspense>
          <SchmockProvider mock={outer}>
            <div />
          </SchmockProvider>
        </>,
      );
    });
    // The provider mounted later answers first.
    expect(await who()).toEqual({ who: "outer" });

    act(() => suspend(gate.promise));
    expect(screen.getByText("fallback")).toBeTruthy();
    expect(await who()).toEqual({ who: "outer" });

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(screen.getByText("shown")).toBeTruthy();

    // The reveal must not take a new lease at the front of the stack.
    expect(await who()).toEqual({ who: "outer" });
    expect(activeLeases(innerIntercept)).toBe(1);
  });

  it("still holds one lease under StrictMode and releases it on unmount", async () => {
    const mock = mockAnswering("inner");
    const intercept = vi.spyOn(mock, "intercept");
    const { Gate, suspend } = createGate();
    const gate = deferred();

    let unmount: () => void = () => {};
    await act(async () => {
      ({ unmount } = render(
        <StrictMode>
          <Suspense fallback={<p>fallback</p>}>
            <SchmockProvider mock={mock}>
              <Gate />
            </SchmockProvider>
          </Suspense>
        </StrictMode>,
      ));
    });
    expect(activeLeases(intercept)).toBe(1);

    act(() => suspend(gate.promise));
    expect(activeLeases(intercept)).toBe(1);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(activeLeases(intercept)).toBe(1);

    unmount();
    expect(activeLeases(intercept)).toBe(0);
    expect(globalThis.fetch).toBe(networkFetch);
  });

  it("releases the lease when the hidden provider unmounts", async () => {
    const mock = mockAnswering("inner");
    const intercept = vi.spyOn(mock, "intercept");
    const { Gate, suspend } = createGate();
    const gate = deferred();

    const { unmount } = render(
      <Suspense fallback={<p>fallback</p>}>
        <SchmockProvider mock={mock}>
          <Gate />
        </SchmockProvider>
      </Suspense>,
    );
    act(() => suspend(gate.promise));
    expect(screen.getByText("fallback")).toBeTruthy();

    unmount();
    expect(activeLeases(intercept)).toBe(0);
    expect(globalThis.fetch).toBe(networkFetch);
  });
});

describe("SchmockProvider under a Suspense boundary on its first mount", () => {
  let baselineFetch: typeof globalThis.fetch;
  let networkFetch: typeof globalThis.fetch;

  beforeEach(() => {
    baselineFetch = globalThis.fetch;
    networkFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ src: "NETWORK" }),
    );
    globalThis.fetch = networkFetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = baselineFetch;
  });

  it("intercepts a fetch chained after an await in a render-created promise", async () => {
    const mock = schmock();
    mock("GET /api/token", { token: 1 });
    mock("GET /api/users", { src: "MOCK" });

    let pending: Promise<{ src: string }> | undefined;
    function Users() {
      pending ??= fetch("http://localhost/api/token")
        .then((response) => response.json())
        .then(() => fetch("http://localhost/api/users"))
        .then((response) => response.json());
      const data = use(pending);
      return <p>{`source:${data.src}`}</p>;
    }

    await act(async () => {
      render(
        <Suspense fallback={<p>loading</p>}>
          <SchmockProvider mock={mock}>
            <Users />
          </SchmockProvider>
        </Suspense>,
      );
    });
    await act(async () => {
      await new Promise((settle) => setTimeout(settle, 20));
    });

    expect(screen.getByText("source:MOCK")).toBeTruthy();
    expect(networkFetch).not.toHaveBeenCalled();
  });
});
