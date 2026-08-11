import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { generateFromSchema } from "./index";

/**
 * Tests for postProcessGenerated behavior.
 * Since postProcessGenerated is not exported, we test it indirectly via generateFromSchema.
 */

describe("postProcessGenerated — schmockNullable", () => {
  it("uses the generation seed for a reproducible nullable distribution", async () => {
    const nullableString: JSONSchema7 & { schmockNullable: boolean } = {
      type: "string",
      schmockNullable: true,
    };
    const schema: JSONSchema7 = {
      type: "array",
      items: {
        type: "object",
        properties: { value: nullableString },
        required: ["value"],
      },
    };

    const first = await generateFromSchema({ schema, count: 200, seed: 42 });
    const second = await generateFromSchema({ schema, count: 200, seed: 42 });

    expect(first).toEqual(second);
    if (!Array.isArray(first)) {
      throw new Error("Expected generated nullable data to be an array");
    }
    const values = first.map((item) => {
      if (typeof item !== "object" || item === null || !("value" in item)) {
        throw new Error("Expected each nullable item to contain value");
      }
      return item.value;
    });
    expect(values.filter((value) => value === null)).toHaveLength(9);
    expect(values.filter((value) => typeof value === "string")).toHaveLength(
      191,
    );
  });
});

describe("postProcessGenerated — schmockTrueProbability", () => {
  it("uses the generation seed for deterministic weighted booleans", async () => {
    const weightedBoolean: JSONSchema7 & {
      schmockTrueProbability: number;
    } = {
      type: "boolean",
      schmockTrueProbability: 0.5,
    };
    const schema: JSONSchema7 = {
      type: "array",
      items: {
        type: "object",
        properties: { flag: weightedBoolean },
        required: ["flag"],
      },
    };

    const first = await generateFromSchema({ schema, count: 12, seed: 42 });
    const second = await generateFromSchema({ schema, count: 12, seed: 42 });

    expect(first).toEqual(second);
    expect(Array.isArray(first)).toBe(true);
    if (!Array.isArray(first)) {
      throw new Error("Expected generated data to be an array");
    }
    const flags = first.flatMap((item) => {
      if (typeof item !== "object" || item === null || !("flag" in item)) {
        return [];
      }
      return [item.flag];
    });
    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  it("applies a reproducible weighted boolean distribution", async () => {
    const weightedBoolean: JSONSchema7 & {
      schmockTrueProbability: number;
    } = {
      type: "boolean",
      schmockTrueProbability: 0.8,
    };
    const schema: JSONSchema7 = {
      type: "array",
      items: {
        type: "object",
        properties: { flag: weightedBoolean },
        required: ["flag"],
      },
    };

    const first = await generateFromSchema({ schema, count: 200, seed: 42 });
    const second = await generateFromSchema({ schema, count: 200, seed: 42 });

    expect(first).toEqual(second);
    if (!Array.isArray(first)) {
      throw new Error("Expected generated weighted data to be an array");
    }
    const flags = first.map((item) => {
      if (typeof item !== "object" || item === null || !("flag" in item)) {
        throw new Error("Expected each weighted item to contain flag");
      }
      return item.flag;
    });
    expect(flags.filter((flag) => flag === true)).toHaveLength(162);
    expect(flags.filter((flag) => flag === false)).toHaveLength(38);
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
