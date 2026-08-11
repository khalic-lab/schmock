import { describe, expect, it } from "vitest";
import {
  findRepresentativeResponse,
  findResponseEntry,
  findSuccessResponse,
  parseResponseStatusKey,
  type ResponseStatusKey,
} from "./response-status";

describe("OpenAPI response status selection", () => {
  it("parses exact, wildcard, and default response keys", () => {
    expect(parseResponseStatusKey("201")).toBe(201);
    expect(parseResponseStatusKey("2xx")).toBe("2XX");
    expect(parseResponseStatusKey("default")).toBe("default");
    expect(parseResponseStatusKey("success")).toBeUndefined();
  });

  it("selects exact, then class wildcard, then default", () => {
    const responses = new Map<ResponseStatusKey, string>([
      ["default", "fallback"],
      ["2XX", "success-range"],
      [201, "created"],
    ]);

    expect(findResponseEntry(responses, 201)).toBe("created");
    expect(findResponseEntry(responses, 202)).toBe("success-range");
    expect(findResponseEntry(responses, 418)).toBe("fallback");
  });

  it("uses 200 as the representative status for a 2XX generator", () => {
    const responses = new Map<ResponseStatusKey, string>([["2XX", "range"]]);
    expect(findSuccessResponse(responses)).toEqual([200, "range"]);
  });

  it("uses default as a final generator fallback", () => {
    const responses = new Map<ResponseStatusKey, string>([
      ["default", "fallback"],
    ]);
    expect(findSuccessResponse(responses)).toEqual([200, "fallback"]);
  });
});

describe("findRepresentativeResponse", () => {
  it("answers the lowest declared status when no 2xx exists", () => {
    const responses = new Map<ResponseStatusKey, string>([
      [503, "unavailable"],
      [404, "missing"],
    ]);
    expect(findRepresentativeResponse(responses)).toEqual([404, "missing"]);
  });

  it("treats a range key by its effective status, so 4XX beats 503", () => {
    // A "numerics first, then ranges" implementation would pick 503 here.
    const responses = new Map<ResponseStatusKey, string>([
      ["4XX", "client-error"],
      [503, "unavailable"],
    ]);
    expect(findRepresentativeResponse(responses)).toEqual([
      400,
      "client-error",
    ]);
  });

  it("delegates to findSuccessResponse for a default-only operation", () => {
    const responses = new Map<ResponseStatusKey, string>([
      ["default", "fallback"],
    ]);
    expect(findRepresentativeResponse(responses)).toEqual([200, "fallback"]);
  });

  it("prefers a declared success over a lower error status", () => {
    const responses = new Map<ResponseStatusKey, string>([
      [404, "missing"],
      [201, "created"],
    ]);
    expect(findRepresentativeResponse(responses)).toEqual([201, "created"]);
  });

  it("returns undefined for an operation declaring no responses", () => {
    expect(
      findRepresentativeResponse(new Map<ResponseStatusKey, string>()),
    ).toBeUndefined();
  });
});
