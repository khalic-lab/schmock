import { ResourceLimitError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { MAX_ARRAY_SIZE } from "./constants.js";
import { fakerPlugin } from "./index.js";

function captureFailure(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

function expectResource(
  error: unknown,
  expected: { resource: string; actual?: number; path?: string },
): void {
  expect(error).toBeInstanceOf(ResourceLimitError);
  if (!(error instanceof ResourceLimitError)) {
    throw new Error(`Expected a resource limit error, got ${String(error)}`);
  }
  expect(error.context).toMatchObject(expected);
}

function withKeywords(
  schema: JSONSchema7,
  keywords: Record<string, unknown>,
): JSONSchema7 {
  for (const [keyword, value] of Object.entries(keywords)) {
    Reflect.set(schema, keyword, value);
  }
  return schema;
}

function context(): Schmock.PluginContext {
  return {
    method: "GET",
    path: "/validation",
    params: {},
    query: {},
    state: new Map(),
    routeState: {},
    headers: {},
    route: { pattern: "/validation" },
  };
}

async function generateOnce(schema: JSONSchema7): Promise<unknown> {
  const plugin = fakerPlugin({ schema, seed: 11 });
  return (await plugin.process(context())).response;
}

describe("validateSchema", () => {
  describe("contains draw counts", () => {
    it("rejects a maxContains above the array limit even when maxItems is small", () => {
      const schema = withKeywords(
        {
          type: "array",
          items: { type: "integer" },
          contains: { type: "integer" },
          maxItems: 3,
        },
        { maxContains: 10_000_000 },
      );

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        {
          resource: "array_max_items",
          actual: 10_000_000,
          path: "$",
        },
      );
    });

    it("rejects a nested minContains above the array limit at its path", () => {
      const tags = withKeywords(
        {
          type: "array",
          items: { type: "integer" },
          contains: { type: "integer" },
          maxItems: 3,
        },
        { minContains: 5_000_000 },
      );
      const schema: JSONSchema7 = { type: "object", properties: { tags } };

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        {
          resource: "array_max_items",
          actual: 5_000_000,
          path: "$.properties.tags",
        },
      );
    });

    it("charges every contains draw against the node budget", () => {
      // 5,000 draws of a 1,001-node array: json-schema-faker generates each
      // one before trimming the array back to its single item.
      const schema = withKeywords(
        {
          type: "array",
          items: { type: "integer" },
          contains: {
            type: "array",
            minItems: 1_000,
            maxItems: 1_000,
            items: { type: "integer" },
          },
          maxItems: 1,
        },
        { maxContains: 5_000 },
      );

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        {
          resource: "generated_nodes",
        },
      );
    });

    it("charges the draws of a contains that alone marks an array", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          a: withKeywords(
            {
              contains: {
                type: "array",
                minItems: 1_000,
                maxItems: 1_000,
                items: { type: "integer" },
              },
            },
            { maxContains: 5_000 },
          ),
        },
      };

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        {
          resource: "generated_nodes",
        },
      );
    });

    it("is not held to the maxItems a then branch merges in", () => {
      const conditional = withKeywords(
        {
          type: "array",
          items: { type: "integer" },
          contains: { type: "integer" },
        },
        { maxContains: MAX_ARRAY_SIZE * 2 },
      );
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          a: {
            if: conditional,
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
            then: { type: "array", items: { type: "integer" }, maxItems: 5 },
          },
        },
      };

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        {
          resource: "array_max_items",
          actual: MAX_ARRAY_SIZE * 2,
          path: "$.properties.a.if",
        },
      );
    });

    it("accepts small contains bounds and generates within maxItems", async () => {
      const schema = withKeywords(
        {
          type: "array",
          items: { type: "integer" },
          contains: { type: "integer", minimum: 5, maximum: 9 },
          minItems: 2,
          maxItems: 5,
        },
        { minContains: 2, maxContains: 3 },
      );

      const generated = await generateOnce(schema);

      expect(Array.isArray(generated)).toBe(true);
      if (!Array.isArray(generated)) return;
      expect(generated.length).toBeLessThanOrEqual(5);
    });

    it("does not let a NaN maxContains hide a sibling over the node budget", () => {
      const grid: JSONSchema7 = {
        type: "array",
        minItems: 2_000,
        maxItems: 2_000,
        items: {
          type: "array",
          minItems: 2_000,
          maxItems: 2_000,
          items: { type: "integer" },
        },
      };
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          grid,
          tags: withKeywords(
            {
              type: "array",
              items: { type: "integer" },
              contains: { type: "integer" },
            },
            { maxContains: Number.NaN },
          ),
        },
      };

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        { resource: "generated_nodes" },
      );
    });

    it("ignores contains bounds on an array without contains", () => {
      const schema = withKeywords(
        { type: "array", items: { type: "integer" }, maxItems: 3 },
        { minContains: 5_000_000, maxContains: 10_000_000 },
      );

      expect(() => fakerPlugin({ schema })).not.toThrow();
    });
  });
});
