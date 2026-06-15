import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { generateFromSchema } from "./index";

/**
 * Regression tests for fakerArgs threading in field-mappings.
 *
 * Bug (4.5): enhanceFieldSchema read only fakerMethod/format/trueProbability
 * from a matched mapping — it never forwarded fakerArgs — so numeric bounds
 * defined in field-mappings.ts (e.g. age → {min:18, max:80}) were silently
 * ignored and faker fell back to its own defaults (potentially a very wide
 * range).
 *
 * Fix: when a matched mapping has fakerArgs, set
 *   enhanced.faker = { [fakerMethod]: fakerArgs }
 * (the json-schema-faker object-form extension), so JSF passes the options
 * object to faker's method.  If the object form does not honour the bounds
 * in the current JSF/faker setup, fall back to also stamping minimum/maximum
 * onto the schema so numeric constraints are applied at the schema level.
 */

describe("fakerArgs on field mappings are honoured (fix 4.5)", () => {
  it("generates age values always within [18, 80] across 50 samples", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        age: { type: "integer" },
      },
      required: ["age"],
    };

    const outOfRange: number[] = [];

    for (let i = 0; i < 50; i++) {
      const result = (await generateFromSchema({ schema })) as Record<
        string,
        unknown
      >;
      const age = result.age as number;
      if (age < 18 || age > 80) {
        outOfRange.push(age);
      }
    }

    expect(outOfRange).toEqual([]);
  });

  it("generates rating values always within [1, 5] across 50 samples", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        rating: { type: "integer" },
      },
      required: ["rating"],
    };

    const outOfRange: number[] = [];

    for (let i = 0; i < 50; i++) {
      const result = (await generateFromSchema({ schema })) as Record<
        string,
        unknown
      >;
      const rating = result.rating as number;
      if (rating < 1 || rating > 5) {
        outOfRange.push(rating);
      }
    }

    expect(outOfRange).toEqual([]);
  });

  it("generates count values always within [1, 100] across 50 samples", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        count: { type: "integer" },
      },
      required: ["count"],
    };

    const outOfRange: number[] = [];

    for (let i = 0; i < 50; i++) {
      const result = (await generateFromSchema({ schema })) as Record<
        string,
        unknown
      >;
      const count = result.count as number;
      if (count < 1 || count > 100) {
        outOfRange.push(count);
      }
    }

    expect(outOfRange).toEqual([]);
  });
});
