import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { generateFromSchema } from "./index";
import { applyOverrides, determineArrayCount } from "./overrides";

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

  it.each([
    [
      "a Draft-7 tuple with additionalItems false",
      {
        type: "array",
        items: [{ type: "string" }, { type: "integer" }],
        additionalItems: false,
        minItems: 2,
      },
    ],
    [
      "a prefixItems tuple with items false",
      {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "integer" }],
        items: false,
        minItems: 2,
      },
    ],
    [
      "a prefixItems tuple with items false and no minItems",
      {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "integer" }],
        items: false,
      },
    ],
  ] satisfies Array<[string, JSONSchema7]>)(
    "generates a root %s at no more than its positions",
    async (_, schema) => {
      for (let seed = 1; seed <= 5; seed += 1) {
        const generated = await generateFromSchema({ schema, seed });
        expect(Array.isArray(generated)).toBe(true);
        const [first, second, ...rest] = generated as unknown[];
        expect(typeof first).toBe("string");
        expect(Number.isInteger(second)).toBe(true);
        expect(rest).toEqual([]);
      }
    },
  );
});

describe("a closed tuple at the root", () => {
  /** `{ type: "array", items: false, prefixItems: [string, integer] }`. */
  function closedTuple(keywords: JSONSchema7 = {}): JSONSchema7 {
    return Object.assign<JSONSchema7, object>(
      { type: "array", items: false, ...keywords },
      { prefixItems: [{ type: "string" }, { type: "integer" }] },
    );
  }

  function expectPair(generated: unknown): void {
    expect(generated).toEqual([expect.any(String), expect.any(Number)]);
  }

  it("generates the 2020-12 tuple's prefix items", async () => {
    expectPair(await generateFromSchema({ schema: closedTuple(), seed: 1 }));
  });

  it("holds an explicit count to the prefix length", async () => {
    expectPair(
      await generateFromSchema({ schema: closedTuple(), count: 5, seed: 1 }),
    );
  });

  it("holds a maxItems range to the prefix length", async () => {
    const schema = closedTuple({ minItems: 1, maxItems: 6 });
    for (let seed = 0; seed < 10; seed++) {
      const generated = await generateFromSchema({ schema, seed });
      expect(Array.isArray(generated) && generated.length).toBeLessThanOrEqual(
        2,
      );
    }
  });

  it("holds an explicit count to a closed Draft-7 tuple", async () => {
    const schema: JSONSchema7 = {
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
      additionalItems: false,
    };

    expectPair(await generateFromSchema({ schema, count: 5, seed: 1 }));
  });
});

describe("an open tuple at the root", () => {
  it.each([1, 5])(
    "defaults an open 2020-12 tuple of %i prefix items to its prefix length",
    (length) => {
      const schema = Object.assign<JSONSchema7, object>(
        { type: "array", items: { type: "string" } },
        { prefixItems: Array.from({ length }, () => ({ type: "string" })) },
      );

      expect(determineArrayCount(schema)).toBe(length);
    },
  );

  it("generates every prefix item of an open 2020-12 tuple", async () => {
    const schema = Object.assign<JSONSchema7, object>(
      { type: "array", items: { type: "string" } },
      {
        prefixItems: [
          { type: "string" },
          { type: "integer" },
          { type: "boolean" },
          { type: "string" },
          { type: "integer" },
        ],
      },
    );

    const generated = await generateFromSchema({ schema, seed: 1 });

    expect(Array.isArray(generated) && generated.length).toBe(5);
  });
});

describe("applyOverrides — caller-owned references", () => {
  const itemSchema: JSONSchema7 = {
    type: "array",
    items: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  };

  function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected a plain object");
    }
    return value as Record<string, unknown>;
  }

  it("gives every generated item its own copy of an array override", async () => {
    const overrides = { tags: ["a", "b"] };

    const generated = await generateFromSchema({
      schema: itemSchema,
      count: 3,
      overrides,
      seed: 1,
    });

    if (!Array.isArray(generated)) {
      throw new Error("Expected an array");
    }
    const first = asRecord(generated[0]).tags;
    const second = asRecord(generated[1]).tags;
    expect(first).toEqual(["a", "b"]);
    expect(first).not.toBe(overrides.tags);
    expect(first).not.toBe(second);

    (first as string[]).push("MUTATED");
    expect(overrides.tags).toEqual(["a", "b"]);
    expect(asRecord(generated[1]).tags).toEqual(["a", "b"]);

    const regenerated = await generateFromSchema({
      schema: itemSchema,
      count: 1,
      overrides,
      seed: 1,
    });
    if (!Array.isArray(regenerated)) {
      throw new Error("Expected an array");
    }
    expect(asRecord(regenerated[0]).tags).toEqual(["a", "b"]);
  });

  it("copies values assigned through a nested override path", () => {
    const nested = { deep: ["x"] };

    const result = asRecord(applyOverrides({}, { "a.b": nested }));
    const branch = asRecord(result.a);

    expect(branch.b).toEqual(nested);
    expect(branch.b).not.toBe(nested);
  });

  it("copies the value a single-expression state template resolves to", () => {
    const state = { cart: { items: ["x"] } };

    const result = asRecord(
      applyOverrides({}, { cart: "{{state.cart}}" }, undefined, state),
    );

    expect(result.cart).toEqual(state.cart);
    expect(result.cart).not.toBe(state.cart);

    const items = asRecord(result.cart).items;
    (items as string[]).push("MUTATED");
    expect(state.cart.items).toEqual(["x"]);
  });

  it("passes through override values that cannot be structurally cloned", () => {
    const callback = () => "unclonable";

    const result = asRecord(applyOverrides({}, { callback }));

    expect(result.callback).toBe(callback);
  });
});
