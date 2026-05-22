import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { generateFromSchema } from "./index";

/**
 * Tests for postProcessGenerated behavior.
 * Since postProcessGenerated is not exported, we test it indirectly via generateFromSchema.
 */

describe("postProcessGenerated — schmockNullable", () => {
  it("schema with schmockNullable: true — over 100 runs, some should be null", async () => {
    // We use a schema where the field has schmockNullable set.
    // Since enhanceSchemaWithSmartMapping may add this marker for nullable fields,
    // we test by adding the marker directly through a schema that triggers it.
    // The simplest approach: craft a schema with the x-nullable pattern that
    // enhanceSchemaWithSmartMapping would process, or use a type that gets
    // the schmockNullable marker applied.
    //
    // Since schmockNullable is set by the enhancement layer for nullable fields,
    // we test via a schema with nullable: true (OpenAPI pattern) or anyOf with null.
    // However, the safest approach is to test a field that we know goes through
    // postProcessGenerated with the schmockNullable flag.

    // Direct approach: construct a schema that includes schmockNullable at the property level
    const schema: JSONSchema7 & Record<string, unknown> = {
      type: "object",
      properties: {
        value: {
          type: "string",
          schmockNullable: true,
        } as JSONSchema7 & { schmockNullable: boolean },
      },
      required: ["value"],
    };

    let nullCount = 0;
    const runs = 200;
    for (let i = 0; i < runs; i++) {
      const result = (await generateFromSchema({ schema })) as Record<
        string,
        unknown
      >;
      if (result.value === null) {
        nullCount++;
      }
    }

    // With NULLABLE_NULL_PROBABILITY = 0.05, over 200 runs we expect ~10 nulls.
    // We use a loose check: at least 1 null (very unlikely to get 0 in 200 trials at 5%)
    expect(nullCount).toBeGreaterThan(0);
    // And not all nulls
    expect(nullCount).toBeLessThan(runs);
  });
});

describe("postProcessGenerated — schmockTrueProbability", () => {
  it("schema with schmockTrueProbability: 0.8 — over 100 runs, ~80% should be true", async () => {
    const schema: JSONSchema7 & Record<string, unknown> = {
      type: "object",
      properties: {
        isActive: {
          type: "boolean",
          schmockTrueProbability: 0.8,
        } as JSONSchema7 & { schmockTrueProbability: number },
      },
      required: ["isActive"],
    };

    let trueCount = 0;
    const runs = 200;
    for (let i = 0; i < runs; i++) {
      const result = (await generateFromSchema({ schema })) as Record<
        string,
        unknown
      >;
      if (result.isActive === true) {
        trueCount++;
      }
    }

    const trueRate = trueCount / runs;
    // With probability 0.8, expect trueRate to be roughly in [0.65, 0.95]
    expect(trueRate).toBeGreaterThan(0.55);
    expect(trueRate).toBeLessThan(0.95);
  });
});

describe("postProcessGenerated — recursive processing", () => {
  it("nested object properties are recursively processed", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "boolean",
              schmockTrueProbability: 1.0,
            } as JSONSchema7 & { schmockTrueProbability: number },
          },
          required: ["inner"],
        },
      },
      required: ["outer"],
    };

    // With schmockTrueProbability = 1.0, every run should yield true
    for (let i = 0; i < 10; i++) {
      const result = (await generateFromSchema({ schema })) as {
        outer: { inner: boolean };
      };
      expect(result.outer.inner).toBe(true);
    }
  });

  it("array items are recursively processed", async () => {
    const schema: JSONSchema7 = {
      type: "array",
      items: {
        type: "object",
        properties: {
          flag: {
            type: "boolean",
            schmockTrueProbability: 1.0,
          } as JSONSchema7 & { schmockTrueProbability: number },
        },
        required: ["flag"],
      },
    };

    const result = (await generateFromSchema({ schema, count: 5 })) as Array<{
      flag: boolean;
    }>;

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(5);
    for (const item of result) {
      expect(item.flag).toBe(true);
    }
  });

  it("non-object data passes through unchanged", async () => {
    // A string schema should pass through postProcessGenerated without issues
    const schema: JSONSchema7 = {
      type: "string",
    };

    const result = await generateFromSchema({ schema });
    expect(typeof result).toBe("string");
  });
});
