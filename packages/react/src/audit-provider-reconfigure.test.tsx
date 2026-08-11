/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchmockProvider } from "./index.js";

describe("SchmockProvider — prop changes (fix 3.4)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("real"));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("re-intercepts when the mock prop changes", async () => {
    const mockA = schmock();
    mockA("GET /api/data", { v: "A" });

    const mockB = schmock();
    mockB("GET /api/data", { v: "B" });

    const { rerender } = render(
      <SchmockProvider mock={mockA}>
        <div />
      </SchmockProvider>,
    );

    // First fetch should use mockA
    const resA = await fetch("http://localhost/api/data").then((r) => r.json());
    expect(resA).toEqual({ v: "A" });

    // Swap mock prop to mockB
    rerender(
      <SchmockProvider mock={mockB}>
        <div />
      </SchmockProvider>,
    );

    // Second fetch should use mockB — this fails before the fix
    const resB = await fetch("http://localhost/api/data").then((r) => r.json());
    expect(resB).toEqual({ v: "B" });
  });

  it("re-intercepts when a callback option changes identity", async () => {
    const mock = schmock();
    mock("GET /api/data", ({ headers }) => ({ marker: headers["x-marker"] }));

    const provider = (marker: string) => (
      <SchmockProvider
        mock={mock}
        options={{
          beforeRequest: (request) => ({
            ...request,
            headers: { ...request.headers, "x-marker": marker },
          }),
        }}
      >
        <div />
      </SchmockProvider>
    );

    const { rerender } = render(provider("first"));
    const first = await fetch("http://localhost/api/data").then((response) =>
      response.json(),
    );
    expect(first).toEqual({ marker: "first" });

    rerender(provider("second"));
    const second = await fetch("http://localhost/api/data").then((response) =>
      response.json(),
    );
    expect(second).toEqual({ marker: "second" });
  });

  it("does not steal precedence from a newer root when options change", async () => {
    const olderMock = schmock();
    olderMock("GET /api/shared", ({ headers }) => ({
      source: "older",
      marker: headers["x-root"] ?? null,
    }));
    const newerMock = schmock();
    newerMock("GET /api/shared", { source: "newer" });

    const olderRoot = (marker: string) => (
      <SchmockProvider
        mock={olderMock}
        options={{
          beforeRequest: (request) => ({
            ...request,
            headers: { ...request.headers, "x-root": marker },
          }),
        }}
      >
        <div />
      </SchmockProvider>
    );

    const older = render(olderRoot("first"));
    const newer = render(
      <SchmockProvider mock={newerMock}>
        <div />
      </SchmockProvider>,
    );

    expect(
      await fetch("http://localhost/api/shared").then((r) => r.json()),
    ).toEqual({ source: "newer" });

    older.rerender(olderRoot("second"));

    // The newer root registered last and must keep winning the shared route.
    expect(
      await fetch("http://localhost/api/shared").then((r) => r.json()),
    ).toEqual({ source: "newer" });

    // ...while the older root's lease still picked up the new hook in place.
    newer.unmount();
    expect(
      await fetch("http://localhost/api/shared").then((r) => r.json()),
    ).toEqual({ source: "older", marker: "second" });
  });
});
