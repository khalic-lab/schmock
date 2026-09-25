import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { generateFromSchema } from "./index";

/**
 * Seeded post-generation behaviour, exercised end to end through
 * generateFromSchema: `applyNullableRolls` (post-process.ts) reintroduces null
 * on `schmockNullable` nodes after json-schema-faker runs, and the enhancer's
 * `applyBooleanWeighting` compiles `schmockTrueProbability` into the faker call
 * before it runs.
 */

describe("applyNullableRolls — schmockNullable", () => {
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

describe("applyBooleanWeighting — schmockTrueProbability compiled by the enhancer", () => {
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
    // The weight is applied through faker's seeded `datatype.boolean`, so the
    // exact split is pinned to the seed.
    expect(flags.filter((flag) => flag === true)).toHaveLength(158);
    expect(flags.filter((flag) => flag === false)).toHaveLength(42);
  });
});

describe("applyBooleanWeighting — nested schemas", () => {
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
    // A string schema has nothing to weight or roll and comes out as a string
    const schema: JSONSchema7 = {
      type: "string",
    };

    const result = await generateFromSchema({ schema });
    expect(typeof result).toBe("string");
  });
});

describe("applyNullableRolls — patternProperties keys", () => {
  /** Nulls rolled across `seeds` objects whose keys come from `pattern`. */
  async function nullsAcrossSeeds(pattern: string, seeds: number) {
    const schema: JSONSchema7 = {
      type: "object",
      patternProperties: { [pattern]: { type: ["integer", "null"] } },
      additionalProperties: false,
      minProperties: 3,
    };
    let nulls = 0;
    let values = 0;
    for (let seed = 1; seed <= seeds; seed += 1) {
      const generated = await generateFromSchema({ schema, seed });
      if (typeof generated !== "object" || generated === null) {
        throw new Error("Expected an object");
      }
      for (const value of Object.values(generated)) {
        values += 1;
        if (value === null) nulls += 1;
      }
    }
    return { nulls, values };
  }

  it("rolls nulls on keys of a pattern that compiles only without the u flag", async () => {
    // `\-` is an identity escape: valid in a plain RegExp, a SyntaxError
    // under the `u` flag. Both spellings describe the same keys.
    const identityEscape = "^x\\-[a-z]+$";
    expect(() => new RegExp(identityEscape, "u")).toThrow(SyntaxError);
    const escaped = await nullsAcrossSeeds(identityEscape, 100);
    const plain = await nullsAcrossSeeds("^x-[a-z]+$", 100);
    expect(escaped.values).toBe(300);
    expect(escaped.nulls).toBeGreaterThan(0);
    expect(escaped).toEqual(plain);
  });
});
