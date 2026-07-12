import { describe, expect, it } from "vitest";
import {
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
