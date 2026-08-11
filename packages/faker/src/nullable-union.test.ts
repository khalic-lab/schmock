import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { generateFromSchema } from "./index";

/**
 * Anti-regression for the normalizer-emitted nullable encodings.
 *
 * The OpenAPI normalizer makes nullability visible to AJV (`type: [T, "null"]`
 * or `anyOf: [{type:"null"}, rest]`). json-schema-faker reads a type union as a
 * ~50/50 branch pick, so the enhancer must strip it back to the non-null shape
 * while keeping the `schmockNullable` marker that drives the ~5% null roll.
 *
 * post-process.test.ts and field-mappings.test.ts hand-write `schmockNullable`
 * on a plain `type: "string"` schema, where the strip is a no-op — they cannot
 * catch either failure mode (50% nulls, or the marker lost so nulls never fire).
 */
describe("nullable union encodings from the OpenAPI normalizer", () => {
  it('collapses `type: [T, "null"]` to T and keeps ~5% nulls', async () => {
    const schema: JSONSchema7 = {
      type: "array",
      items: {
        type: "object",
        properties: {
          value: { type: ["string", "null"], schmockNullable: true },
        },
        required: ["value"],
      },
    } as JSONSchema7;

    const first = (await generateFromSchema({
      schema,
      count: 200,
      seed: 42,
    })) as Array<{ value: unknown }>;
    const second = (await generateFromSchema({
      schema,
      count: 200,
      seed: 42,
    })) as Array<{ value: unknown }>;

    expect(first).toEqual(second);
    expect(first).toHaveLength(200);

    const nulls = first.filter((item) => item.value === null).length;
    // Pre-fix, JSF picked the null branch itself: 121/200 at seed 7.
    expect(nulls).toBeGreaterThan(0);
    expect(nulls).toBeLessThan(40);

    for (const item of first) {
      if (item.value !== null) {
        expect(typeof item.value).toBe("string");
      }
    }
  });

  it('unwraps the `anyOf: [{type:"null"}, rest]` composition encoding', async () => {
    const schema: JSONSchema7 = {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        },
      ],
      schmockNullable: true,
    } as JSONSchema7;

    let nulls = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const generated = await generateFromSchema({ schema, seed });
      if (generated === null) {
        nulls++;
        continue;
      }
      expect(typeof generated).toBe("object");
      const record = generated as Record<string, unknown>;
      expect(typeof record.label).toBe("string");
      expect(record).not.toHaveProperty("anyOf");
    }

    // Only the ~5% post-process roll may null these out — never a 50/50 branch pick.
    expect(nulls).toBeLessThan(15);
  });
});
