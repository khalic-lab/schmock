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
});
