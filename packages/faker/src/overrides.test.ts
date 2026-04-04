import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { determineArrayCount } from "./overrides";

describe("determineArrayCount", () => {
  it("returns explicit count when provided", () => {
    expect(determineArrayCount({}, 5)).toBe(5);
  });

  it("returns 0 for negative explicit count", () => {
    expect(determineArrayCount({}, -3)).toBe(0);
  });

  it("returns value within minItems/maxItems range", () => {
    const schema: JSONSchema7 = { minItems: 2, maxItems: 5 };
    for (let i = 0; i < 50; i++) {
      const count = determineArrayCount(schema);
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(5);
    }
  });

  it("handles minItems greater than maxItems without producing garbage", () => {
    const schema: JSONSchema7 = { minItems: 10, maxItems: 3 };
    const count = determineArrayCount(schema);

    // Should not produce negative numbers or unreasonably large values
    expect(count).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(count)).toBe(true);
    expect(Number.isNaN(count)).toBe(false);
  });

  it("handles minItems equal to maxItems", () => {
    const schema: JSONSchema7 = { minItems: 5, maxItems: 5 };
    const count = determineArrayCount(schema);
    expect(count).toBe(5);
  });
});
