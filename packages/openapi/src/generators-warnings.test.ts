/// <reference path="../../core/schmock.d.ts" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { createStaticGenerator } from "./generators.js";
import type { ParsedPath } from "./parser.js";

// Mock @schmock/faker to force schema generation failures
vi.mock("@schmock/faker", () => ({
  generateFromSchema: vi.fn().mockRejectedValue(new Error("Schema too deep")),
}));

function makeParsedPath(overrides: Partial<ParsedPath> = {}): ParsedPath {
  return {
    path: "/test",
    method: "GET",
    parameters: [],
    responses: new Map([
      [
        200,
        {
          schema: { type: "object", properties: { id: { type: "number" } } },
          description: "OK",
        },
      ],
    ]),
    tags: [],
    ...overrides,
  };
}

describe("generators — schema failure warnings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a warning when static route schema generation fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const generator = createStaticGenerator(makeParsedPath());
    const result = await generator({
      path: "/test",
      method: "GET",
      params: {},
      query: {},
      headers: {},
      state: {},
    } as Schmock.RequestContext);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Schema generation failed for GET /test"),
      "Schema too deep",
    );

    // Falls back to a tuple [status, {}] so the spec-declared status (200 here,
    // since the parsedPath has only a 200 response) is preserved through
    // parseResponse — returning raw {} would let parseResponse think it was a
    // schmock fallback and *not* flip its 200→204 conversion for null bodies,
    // but tuple form is the established contract for spec-driven generators.
    expect(result).toEqual([200, {}]);
  });

  it("returns empty object as fallback but does not swallow silently", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const generator = createStaticGenerator(
      makeParsedPath({
        path: "/users",
        method: "POST",
      }),
    );

    await generator({
      path: "/users",
      method: "POST",
      params: {},
      query: {},
      headers: {},
      state: {},
    } as Schmock.RequestContext);

    // The key assertion: console.warn was called (not silently swallowed)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("[@schmock/openapi]");
  });
});
