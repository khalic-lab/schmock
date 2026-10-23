import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { MAX_ARRAY_SIZE } from "./constants.js";
import { fakerPlugin } from "./index.js";
import { validateFakerMethod } from "./validation.js";

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

function expectSchemaError(error: unknown, schemaPath: string): void {
  expect(error).toBeInstanceOf(SchemaValidationError);
  if (!(error instanceof SchemaValidationError)) {
    throw new Error(`Expected a schema validation error, got ${String(error)}`);
  }
  expect(error.context).toMatchObject({ schemaPath });
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

/** An object whose `rows` property holds `count` copies of `item`. */
function rowsOf(item: JSONSchema7, count: number): JSONSchema7 {
  return {
    type: "object",
    properties: {
      rows: { type: "array", minItems: count, maxItems: count, items: item },
    },
    required: ["rows"],
  };
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

  describe("certain string floors", () => {
    it("charges a pattern's shortest match against the character budget", () => {
      const schema = rowsOf({ type: "string", pattern: "^[a-z]{60000}$" }, 300);

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        {
          resource: "generated_chars",
          actual: 18_000_000,
        },
      );
    });

    it.each([
      ["string.alpha", [{ length: 60_000 }]],
      ["string.alphanumeric", [60_000]],
      ["string.numeric", [{ length: { min: 60_000, max: 60_000 } }]],
      ["string.hexadecimal", [{ length: 60_000 }]],
      ["string.nanoid", [{ min: 60_000, max: 60_000 }]],
      ["string.sample", [60_000]],
      ["internet.password", [{ length: 60_000 }]],
    ])(
      "charges the %s length argument against the character budget",
      (method, args) => {
        const item = withKeywords(
          { type: "string" },
          {
            faker: { [method]: args },
          },
        );
        const schema = rowsOf(item, 300);

        expectResource(
          captureFailure(() => fakerPlugin({ schema })),
          {
            resource: "generated_chars",
            actual: 18_000_000,
          },
        );
      },
    );

    it("charges the larger of minLength and a pattern floor", () => {
      const schema = rowsOf(
        { type: "string", minLength: 10, pattern: "^[a-z]{60000}$" },
        300,
      );

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        {
          resource: "generated_chars",
          actual: 18_000_000,
        },
      );
    });

    it.each([
      [
        "a maxLength that truncates the pattern",
        { type: "string", pattern: "^[a-z]{60000}$", maxLength: 10 },
      ],
      [
        "a format that replaces the pattern",
        { type: "string", pattern: "^[a-z]{60000}$", format: "uuid" },
      ],
      [
        "an enum that replaces the pattern",
        { type: "string", pattern: "^[a-z]{60000}$", enum: ["a"] },
      ],
      [
        "a default that replaces the pattern",
        { type: "string", pattern: "^[a-z]{60000}$", default: "a" },
      ],
      [
        "a nullable pattern",
        { type: ["string", "null"], pattern: "^[a-z]{60000}$" },
      ],
      [
        "an allOf maxLength that truncates the pattern",
        { type: "string", pattern: "^[a-z]{60000}$", allOf: [{ maxLength: 10 }] },
      ],
      [
        "an anyOf enum that replaces the pattern",
        { type: "string", pattern: "^[a-z]{60000}$", anyOf: [{ enum: ["x"] }] },
      ],
      [
        "a then const that replaces the pattern",
        {
          type: "string",
          pattern: "^[a-z]{60000}$",
          if: { minLength: 0 },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
          then: { const: "x" },
        },
      ],
      [
        "a NaN maxLength",
        { type: "string", pattern: "^[a-z]{60000}$", maxLength: Number.NaN },
      ],
    ] satisfies Array<[string, JSONSchema7]>)(
      "does not charge a pattern floor under %s",
      (_, item) => {
        expect(() => fakerPlugin({ schema: rowsOf(item, 300) })).not.toThrow();
      },
    );

    it("still charges a pattern beside an allOf that leaves it in place", () => {
      const schema = rowsOf(
        { type: "string", pattern: "^[a-z]{60000}$", allOf: [{ minLength: 1 }] },
        300,
      );

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        { resource: "generated_chars", actual: 18_000_000 },
      );
    });

    it("does not let a NaN minLength hide a sibling over the character budget", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          rows: rowsOf({ type: "string", minLength: 60_000 }, 300),
          odd: { type: "string", minLength: Number.NaN },
        },
      };

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        { resource: "generated_chars", actual: 18_000_000 },
      );
    });

    it.each([
      ["word.sample", [{ length: 60_000 }]],
      ["lorem.word", [{ length: 60_000 }]],
      ["lorem.words", [30_000]],
      ["string.fromCharacters", [["", "a"], 60_000]],
    ])(
      "does not charge %s, whose output length is not certain",
      (method, args) => {
        const item = withKeywords(
          { type: "string" },
          {
            faker: { [method]: args },
          },
        );

        expect(() => fakerPlugin({ schema: rowsOf(item, 300) })).not.toThrow();
      },
    );
  });

  describe("faker method paths", () => {
    it.each([
      "person.faker.string.alpha",
      "lorem.faker.lorem.paragraphs",
      "person.faker.seed",
      "helpers.faker.helpers.multiple",
    ])("rejects %s, which reaches through the faker back-reference", (path) => {
      expect(() => validateFakerMethod(path)).toThrow(SchemaValidationError);
    });

    it("rejects an aliased method whose arguments the allocation policy would refuse", () => {
      const schema = withKeywords(
        { type: "string" },
        {
          faker: { "person.faker.string.alpha": [{ length: 5_000_000 }] },
        },
      );

      expectSchemaError(
        captureFailure(() => fakerPlugin({ schema })),
        "$.faker",
      );
    });

    it("rejects an aliased helpers.fake placeholder", () => {
      const schema = withKeywords(
        { type: "string" },
        {
          faker: {
            "helpers.fake": [
              '{{person.faker.string.alpha({"length":5000000})}}',
            ],
          },
        },
      );

      expectSchemaError(
        captureFailure(() => fakerPlugin({ schema })),
        "$.faker",
      );
    });

    it("accepts module.method paths and placeholders", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          name: withKeywords({ type: "string" }, { faker: "person.firstName" }),
          code: withKeywords(
            { type: "string" },
            {
              faker: {
                "helpers.fake": ["{{string.alpha(5)}}-{{person.firstName}}"],
              },
            },
          ),
        },
        required: ["name", "code"],
      };

      const generated = await generateOnce(schema);

      expect(generated).toMatchObject({
        name: expect.any(String),
        code: expect.stringMatching(/^[A-Za-z]{5}-/),
      });
    });
  });

  describe("references json-schema-faker cannot follow", () => {
    const uuid: JSONSchema7 = { type: "string", format: "uuid" };

    it.each([
      [
        "an $anchor",
        { type: "object", properties: { n: { $ref: "#sid" } } },
        { S: withKeywords({ ...uuid }, { $anchor: "sid" }) },
      ],
      [
        "a $dynamicAnchor",
        { type: "object", properties: { n: { $ref: "#sid" } } },
        { S: withKeywords({ ...uuid }, { $dynamicAnchor: "sid" }) },
      ],
      [
        "an anchor named by an absolute URI",
        {
          $id: "https://example.test/root.json",
          type: "object",
          properties: { n: { $ref: "https://example.test/root.json#sid" } },
        },
        { S: withKeywords({ ...uuid }, { $anchor: "sid" }) },
      ],
    ] satisfies Array<[string, JSONSchema7, Record<string, JSONSchema7>]>)(
      "rejects a $ref to %s at creation",
      (_, schema, defs) => {
        const error = captureFailure(() =>
          fakerPlugin({ schema: { ...schema, $defs: defs } }),
        );

        expectSchemaError(error, "$.properties.n.$ref");
        expect(String(error)).toContain("anchor");
      },
    );

    it("rejects a $dynamicRef at creation", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          n: withKeywords({}, { $dynamicRef: "#sid" }),
        },
        $defs: { S: withKeywords({ ...uuid }, { $dynamicAnchor: "sid" }) },
      };

      expectSchemaError(
        captureFailure(() => fakerPlugin({ schema })),
        "$.properties.n.$dynamicRef",
      );
    });

    it("still reports a dynamic-reference cycle as circular", () => {
      const schema = withKeywords(
        {
          $id: "https://example.test/node.json",
          type: "object",
          properties: { child: withKeywords({}, { $dynamicRef: "#node" }) },
        },
        { $dynamicAnchor: "node" },
      );

      const error = captureFailure(() => fakerPlugin({ schema }));

      expect(error).toBeInstanceOf(SchemaValidationError);
      expect(String(error)).toMatch(/circular/i);
    });

    it("leaves an anchor reference inside not alone, since nothing is generated from it", () => {
      const schema: JSONSchema7 = {
        type: "string",
        maxLength: 5,
        not: { $ref: "#sid" },
        $defs: { S: withKeywords({ ...uuid }, { $anchor: "sid" }) },
      };

      expect(() => fakerPlugin({ schema })).not.toThrow();
    });

    it.each([
      ["a JSON Pointer", "#/$defs/S", { S: uuid }],
      ["an embedded $id", "s.json", { S: { $id: "s.json", ...uuid } }],
    ] satisfies Array<[string, string, Record<string, JSONSchema7>]>)(
      "generates through %s",
      async (_, $ref, defs) => {
        const generated = await generateOnce({
          type: "object",
          properties: { n: { $ref } },
          required: ["n"],
          $defs: defs,
        });

        expect(generated).toMatchObject({
          n: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });
      },
    );
  });
});
