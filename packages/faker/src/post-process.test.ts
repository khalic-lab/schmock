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

describe("applyNullableRolls — a type union's own composition (faker-10)", () => {
  const FOO: JSONSchema7 = {
    type: "object",
    properties: { a: { type: "string" } },
  };

  /** `foo` values generated with `foo` described by `node`, over 200 seeds. */
  async function fooValues(node: JSONSchema7): Promise<unknown[]> {
    const schema: JSONSchema7 = {
      type: "object",
      properties: { foo: node },
      required: ["foo"],
      $defs: { Foo: FOO },
    };
    const values: unknown[] = [];
    for (let seed = 1; seed <= 200; seed += 1) {
      const value = await generateFromSchema({ schema, seed });
      values.push(Reflect.get(Object(value), "foo"));
    }
    return values;
  }

  const marked = (node: JSONSchema7): JSONSchema7 => {
    const copy = { ...node };
    Reflect.set(copy, "schmockNullable", true);
    return copy;
  };

  it.each([
    [
      "marked, allOf $ref",
      marked({ type: ["object", "null"], allOf: [{ $ref: "#/$defs/Foo" }] }),
    ],
    [
      "native, allOf $ref",
      { type: ["object", "null"], allOf: [{ $ref: "#/$defs/Foo" }] },
    ],
    [
      "marked, inline allOf",
      marked({ type: ["object", "null"], allOf: [FOO] }),
    ],
    [
      "marked, $ref beside type",
      marked({ type: ["object", "null"], $ref: "#/$defs/Foo" }),
    ],
  ] satisfies [string, JSONSchema7][])(
    "never rolls a null its own composition rejects (%s)",
    async (_, node) => {
      for (const foo of await fooValues(node)) expect(foo).not.toBeNull();
    },
  );

  it("still rolls null through a union's non-null alternative", async () => {
    const values = await fooValues(
      marked({
        anyOf: [{ type: "null" }, { allOf: [{ $ref: "#/$defs/Foo" }] }],
      }),
    );
    expect(values).toContain(null);
  });

  it("still rolls null when the type union's composition admits it", async () => {
    const values = await fooValues(
      marked({ type: ["object", "null"], allOf: [{ minProperties: 0 }] }),
    );
    expect(values).toContain(null);
  });

  it("still rolls null for the marker alone beside a $ref or allOf", async () => {
    expect(await fooValues(marked({ $ref: "#/$defs/Foo" }))).toContain(null);
    expect(
      await fooValues(marked({ allOf: [{ $ref: "#/$defs/Foo" }] })),
    ).toContain(null);
  });
});

describe("applyNullableRolls — uniqueItems (faker-9)", () => {
  /** Arrays generated from `schema` over `seeds` seeds. */
  async function arraysFrom(
    schema: JSONSchema7,
    seeds: number,
  ): Promise<unknown[][]> {
    const arrays: unknown[][] = [];
    for (let seed = 1; seed <= seeds; seed += 1) {
      const value = await generateFromSchema({ schema, seed });
      if (!Array.isArray(value)) throw new Error("Expected an array");
      arrays.push(value);
    }
    return arrays;
  }

  const nullCount = (items: unknown[]) =>
    items.filter((item) => item === null).length;

  it.each([
    ["a type union", { type: ["integer", "null"] }],
    ["an anyOf union", { anyOf: [{ type: "integer" }, { type: "null" }] }],
    ["a uuid union", { type: ["string", "null"], format: "uuid" }],
  ] satisfies [string, JSONSchema7][])(
    "rolls at most one null into a uniqueItems array of %s",
    async (_, items) => {
      const arrays = await arraysFrom(
        { type: "array", items, uniqueItems: true, minItems: 20, maxItems: 20 },
        100,
      );
      for (const array of arrays) {
        expect(nullCount(array)).toBeLessThanOrEqual(1);
      }
      // Nulls are still rolled, just never twice in one array.
      expect(arrays.some((array) => nullCount(array) === 1)).toBe(true);
    },
  );

  it("still rolls several nulls into an array that allows duplicates", async () => {
    const arrays = await arraysFrom(
      {
        type: "array",
        items: { type: ["integer", "null"] },
        minItems: 20,
        maxItems: 20,
      },
      100,
    );
    expect(arrays.some((array) => nullCount(array) > 1)).toBe(true);
  });
});

describe("applyNullableRolls — a not that rejects null (faker-2)", () => {
  /** Items generated from `items` over a few seeds, 50 per array. */
  async function itemsFrom(items: JSONSchema7): Promise<unknown[]> {
    const values: unknown[] = [];
    for (let seed = 1; seed <= 6; seed += 1) {
      const value = await generateFromSchema({
        schema: { type: "array", items, minItems: 50, maxItems: 50 },
        seed,
      });
      if (!Array.isArray(value)) throw new Error("Expected an array");
      values.push(...value);
    }
    return values;
  }

  it.each([
    [
      "a not.type union with null",
      {
        type: ["string", "integer", "null"],
        not: { type: ["string", "null"] },
      },
    ],
    ["a not.const null", { type: ["integer", "null"], not: { const: null } }],
    [
      "a not.enum holding null",
      { type: ["integer", "null"], not: { enum: [null, 7] } },
    ],
    [
      "a not whose body ignores null",
      { type: ["integer", "null"], not: { minLength: 1 } },
    ],
  ] satisfies [string, JSONSchema7][])(
    "never rolls null beside %s",
    async (_, items) => {
      expect(await itemsFrom(items)).not.toContain(null);
    },
  );

  it("still rolls null when the not body rejects null", async () => {
    const values = await itemsFrom({
      type: ["string", "integer", "null"],
      not: { type: "string" },
    });
    expect(values).toContain(null);
    expect(values.every((value) => typeof value !== "string")).toBe(true);
  });
});
