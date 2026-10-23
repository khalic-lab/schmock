import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { MAX_ARRAY_SIZE } from "./constants.js";
import { fakerPlugin } from "./index.js";
import { validateFakerMethod, validateSchema } from "./validation.js";

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
        {
          type: "string",
          pattern: "^[a-z]{60000}$",
          allOf: [{ maxLength: 10 }],
        },
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
        {
          type: "string",
          pattern: "^[a-z]{60000}$",
          allOf: [{ minLength: 1 }],
        },
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

    it("describes a non-Error a faker value throws as core does, keeping it as the cause", () => {
      const thrown = { reason: "trap" };
      const faker = new Proxy(
        {},
        {
          ownKeys() {
            throw thrown;
          },
        },
      );

      // Straight to the walk: the plugin snapshots its schema first, which
      // turns every faker value into plain data.
      const error = captureFailure(() =>
        validateSchema(withKeywords({ type: "string" }, { faker })),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: '{"reason":"trap"}',
        cause: thrown,
      });
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

  describe("helpers.fake placeholders", () => {
    function fakeString(...templates: unknown[]): JSONSchema7 {
      return withKeywords(
        { type: "string" },
        { faker: { "helpers.fake": templates } },
      );
    }

    it.each([
      ["literal braces around a placeholder", "{{{string.alpha(5)}}}"],
      ["a brace pair that opens no method", "{{(5)}}"],
      ["a capitalised method name", "price {{Total(5)}}"],
    ])("accepts %s, which faker leaves as literal text", (_, template) => {
      expect(() => fakerPlugin({ schema: fakeString(template) })).not.toThrow();
    });

    it("generates literal braces around an evaluated placeholder", async () => {
      const generated = await generateOnce(fakeString("{{{string.alpha(5)}}}"));

      expect(generated).toMatch(/^\{[A-Za-z]{5}\}$/);
    });

    it.each([
      ["a newline before the argument", "{{string.alpha(\n5000000)}}"],
      [
        "a {{ that faker drops from the expression",
        "{{string.alpha({{5000000)}}",
      ],
      ["text after the closing parenthesis", "{{string.alpha(5000000).x)}}"],
    ])("checks a placeholder with %s", (_, template) => {
      expectResource(
        captureFailure(() => fakerPlugin({ schema: fakeString(template) })),
        { resource: "string_length", actual: 5_000_000 },
      );
    });

    it("charges a placeholder's certain length and the literal text around it", () => {
      const schema = rowsOf(fakeString("ab{{string.alpha(60000)}}"), 300);

      expectResource(
        captureFailure(() => fakerPlugin({ schema })),
        { resource: "generated_chars", actual: 18_000_600 },
      );
    });

    it("charges the shortest of several templates", () => {
      const schema = rowsOf(
        fakeString(["{{string.alpha(60000)}}", "{{string.numeric(1)}}"]),
        300,
      );

      expect(() => fakerPlugin({ schema })).not.toThrow();
    });
  });

  describe("references json-schema-faker cannot follow itself", () => {
    const uuid: JSONSchema7 = { type: "string", format: "uuid" };
    const UUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    /** An object whose required `n` reaches a uuid schema through `n`. */
    function uuidThrough(
      n: JSONSchema7,
      definitions: Record<string, JSONSchema7>,
      root: JSONSchema7 = {},
    ): JSONSchema7 {
      return {
        ...root,
        type: "object",
        properties: { n },
        required: ["n"],
        ...definitions,
      };
    }

    it.each([
      [
        "a $ref to an $anchor",
        uuidThrough(
          { $ref: "#sid" },
          { $defs: { S: withKeywords({ ...uuid }, { $anchor: "sid" }) } },
        ),
      ],
      [
        "a $ref to a $dynamicAnchor",
        uuidThrough(
          { $ref: "#sid" },
          {
            $defs: { S: withKeywords({ ...uuid }, { $dynamicAnchor: "sid" }) },
          },
        ),
      ],
      [
        "a $ref to an anchor named by an absolute URI",
        uuidThrough(
          { $ref: "https://example.test/root.json#sid" },
          { $defs: { S: withKeywords({ ...uuid }, { $anchor: "sid" }) } },
          { $id: "https://example.test/root.json" },
        ),
      ],
      [
        "a $dynamicRef",
        uuidThrough(withKeywords({}, { $dynamicRef: "#sid" }), {
          $defs: { S: withKeywords({ ...uuid }, { $dynamicAnchor: "sid" }) },
        }),
      ],
      [
        "a draft-07 plain-name $id under definitions",
        uuidThrough(
          { $ref: "#sid" },
          { definitions: { S: { $id: "#sid", ...uuid } } },
        ),
      ],
      [
        "an embedded $id under definitions",
        uuidThrough(
          { $ref: "s.json" },
          { definitions: { S: { $id: "s.json", ...uuid } } },
        ),
      ],
      [
        "a URI resolved against the root $id",
        uuidThrough(
          { $ref: "https://example.test/s.json" },
          { $defs: { S: { $id: "s.json", ...uuid } } },
          { $id: "https://example.test/root.json" },
        ),
      ],
      [
        "a JSON Pointer",
        uuidThrough({ $ref: "#/$defs/S" }, { $defs: { S: uuid } }),
      ],
      [
        "an embedded $id under $defs",
        uuidThrough(
          { $ref: "s.json" },
          { $defs: { S: { $id: "s.json", ...uuid } } },
        ),
      ],
    ] satisfies Array<[string, JSONSchema7]>)(
      "generates through %s",
      async (_, schema) => {
        const generated = await generateOnce(schema);

        expect(generated).toMatchObject({ n: expect.stringMatching(UUID) });
      },
    );

    describe("keywords the target carries", () => {
      /** Every way of naming `$defs.T` that generation merges in itself. */
      function throughEachReference(
        target: JSONSchema7,
      ): Array<[string, JSONSchema7]> {
        return [
          [
            "a $ref to a registered $id",
            uuidThrough(
              { $ref: "https://example.com/t" },
              { $defs: { T: { $id: "https://example.com/t", ...target } } },
            ),
          ],
          [
            "a $ref to an $anchor",
            uuidThrough(
              { $ref: "#t" },
              { $defs: { T: withKeywords({ ...target }, { $anchor: "t" }) } },
            ),
          ],
          [
            "a $dynamicRef",
            uuidThrough(withKeywords({}, { $dynamicRef: "#t" }), {
              $defs: {
                T: withKeywords({ ...target }, { $dynamicAnchor: "t" }),
              },
            }),
          ],
          [
            "a draft-07 plain-name $id",
            uuidThrough(
              { $ref: "#t" },
              { definitions: { T: { $id: "#t", ...target } } },
            ),
          ],
        ];
      }

      async function generatedNs(schema: JSONSchema7): Promise<unknown[]> {
        const values: unknown[] = [];
        for (let seed = 1; seed <= 30; seed += 1) {
          const { response } = await fakerPlugin({ schema, seed }).process(
            context(),
          );
          values.push(Reflect.get(Object(response), "n"));
        }
        return values;
      }

      it.each(
        throughEachReference(
          withKeywords({ type: "string" }, { faker: "string.uuid" }),
        ),
      )("keeps the target's faker through %s", async (_, schema) => {
        for (const n of await generatedNs(schema)) {
          expect(n).toMatch(UUID);
        }
      });

      it.each(
        throughEachReference({
          type: "integer",
          minimum: 1,
          maximum: 3,
          not: { const: 2 },
        }),
      )("keeps the target's not through %s", async (_, schema) => {
        expect(await generatedNs(schema)).not.toContain(2);
      });

      it.each(
        throughEachReference({
          type: "integer",
          minimum: 0,
          maximum: 9,
          if: { minimum: 0 },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
          then: { const: 3 },
        }),
      )("keeps the target's if and then through %s", async (_, schema) => {
        expect(new Set(await generatedNs(schema))).toEqual(new Set([3]));
      });

      it.each(throughEachReference({ type: "string", default: "fixed" }))(
        "keeps the target's default through %s",
        async (_, schema) => {
          expect(new Set(await generatedNs(schema))).toEqual(
            new Set(["fixed"]),
          );
        },
      );
    });

    it("sizes a root array reached through an anchor with count", async () => {
      const plugin = fakerPlugin({
        schema: {
          $ref: "#list",
          $defs: {
            List: withKeywords(
              { type: "array", items: { type: "integer" } },
              { $anchor: "list" },
            ),
          },
        },
        count: 7,
        seed: 5,
      });

      const { response } = await plugin.process(context());

      expect(response).toHaveLength(7);
    });

    it("rejects a $dynamicRef that resolves to nothing at creation", () => {
      const schema = uuidThrough(withKeywords({}, { $dynamicRef: "#sid" }), {
        $defs: { S: uuid },
      });

      expectSchemaError(
        captureFailure(() => fakerPlugin({ schema })),
        "$.properties.n.$dynamicRef",
      );
    });

    it("leaves an unresolvable $dynamicRef in an unreferenced definition alone", () => {
      const schema: JSONSchema7 = {
        type: "string",
        maxLength: 5,
        $defs: { Unused: withKeywords({}, { $dynamicRef: "#nowhere" }) },
      };

      expect(() => fakerPlugin({ schema })).not.toThrow();
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
  });

  describe("count on a root array reached through a wrapper", () => {
    const list: JSONSchema7 = { type: "array", items: { type: "integer" } };

    it.each([
      ["a $ref", { $ref: "#/$defs/List", $defs: { List: list } }],
      [
        "a definitions $ref",
        { $ref: "#/definitions/List", definitions: { List: list } },
      ],
      [
        "a single-entry allOf",
        { description: "Wrapped", allOf: [{ $ref: "#/$defs/List" }] },
      ],
      ["an anyOf null union", { anyOf: [list, { type: "null" }] }],
      ["a oneOf null union", { oneOf: [{ type: "null" }, list] }],
    ] satisfies Array<[string, JSONSchema7]>)(
      "rejects a count above the array limit through %s at creation",
      (_, wrapper) => {
        const schema: JSONSchema7 = { $defs: { List: list }, ...wrapper };

        expectResource(
          captureFailure(() =>
            fakerPlugin({ schema, count: MAX_ARRAY_SIZE + 1 }),
          ),
          { resource: "array_size", actual: MAX_ARRAY_SIZE + 1 },
        );
      },
    );

    it("accepts a count within the limit and generates that many items", async () => {
      const plugin = fakerPlugin({
        schema: { $ref: "#/$defs/List", $defs: { List: list } },
        count: 7,
        seed: 3,
      });

      const { response } = await plugin.process(context());

      expect(response).toHaveLength(7);
    });

    it("leaves a union with a second non-null branch alone", () => {
      const schema: JSONSchema7 = {
        anyOf: [list, { type: "string" }],
      };

      expect(() =>
        fakerPlugin({ schema, count: MAX_ARRAY_SIZE + 1 }),
      ).not.toThrow();
    });
  });

  describe("not bodies generation must honour", () => {
    const status: JSONSchema7 = { enum: ["open", "closed"] };

    it.each([
      ["a not.pattern", { type: "string", not: { pattern: "^test" } }],
      [
        "a not beside allOf",
        { allOf: [{ type: "string" }], not: { const: "a" } },
      ],
      [
        "a not beside oneOf",
        { oneOf: [{ const: "a" }, { const: "b" }], not: { const: "a" } },
      ],
      [
        "a not beside if",
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
        { type: "string", if: { minLength: 1 }, then: {}, not: { const: "" } },
      ],
      [
        "a not.required whose every property is required",
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          not: { required: ["a"] },
        },
      ],
      [
        "a not.type that rejects the node's only type",
        { type: "string", not: { type: "string" } },
      ],
      ["a not.type number on an untyped node", { not: { type: "number" } }],
      [
        "a not beside an explicit faker",
        withKeywords(
          { type: "string", not: { const: "Bob" } },
          { faker: "person.firstName" },
        ),
      ],
      [
        "a not.type beside an enum",
        { enum: ["a", 1], not: { type: "string" } },
      ],
      ["a not of the empty schema outside a property", { not: {} }],
      [
        "a not beside a $ref to a target with oneOf",
        {
          $ref: "#/$defs/S",
          not: { const: "a" },
          $defs: { S: { oneOf: [{ const: "a" }, { const: "b" }] } },
        },
      ],
    ] satisfies Array<[string, JSONSchema7]>)(
      "rejects %s at creation",
      (_, schema) => {
        expectSchemaError(
          captureFailure(() => fakerPlugin({ schema })),
          "$.not",
        );
      },
    );

    const oneToThreeButTwo: JSONSchema7 = {
      type: "integer",
      minimum: 1,
      maximum: 3,
      not: { const: 2 },
    };

    it.each([
      [
        "an allOf entry",
        {
          type: "integer",
          minimum: 1,
          maximum: 3,
          allOf: [{ not: { const: 2 } }],
        },
        "$.allOf[0].not",
      ],
      [
        "an allOf entry with a lone not.type",
        { type: ["string", "integer"], allOf: [{ not: { type: "string" } }] },
        "$.allOf[0].not",
      ],
      [
        "an anyOf branch",
        { anyOf: [oneToThreeButTwo, { type: "string" }] },
        "$.anyOf[0].not",
      ],
      [
        "a oneOf branch",
        { oneOf: [{ type: "string" }, oneToThreeButTwo] },
        "$.oneOf[1].not",
      ],
      [
        "a then",
        {
          type: "integer",
          minimum: 1,
          maximum: 3,
          if: { minimum: 1 },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
          then: { not: { const: 2 } },
        },
        "$.then.not",
      ],
      [
        "an else",
        {
          type: "integer",
          minimum: 1,
          maximum: 3,
          if: { minimum: 5 },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
          then: {},
          else: { not: { const: 2 } },
        },
        "$.else.not",
      ],
      [
        "a definition an allOf entry references",
        { allOf: [{ $ref: "#/$defs/T" }], $defs: { T: oneToThreeButTwo } },
        "$.allOf[0].not",
      ],
      [
        "a definition a property and an allOf entry both reference",
        {
          type: "object",
          properties: {
            a: { $ref: "#/$defs/T" },
            b: { allOf: [{ $ref: "#/$defs/T" }] },
          },
          $defs: { T: oneToThreeButTwo },
        },
        "$.properties.b.allOf[0].not",
      ],
      [
        "the non-null branch of a null union inside an allOf entry",
        { allOf: [{ anyOf: [oneToThreeButTwo, { type: "null" }] }] },
        "$.allOf[0].anyOf[0].not",
      ],
    ] satisfies Array<[string, JSONSchema7, string]>)(
      "rejects a not json-schema-faker drops by merging %s into its parent",
      (_, schema, notPath) => {
        expectSchemaError(
          captureFailure(() => fakerPlugin({ schema })),
          notPath,
        );
      },
    );

    it.each([
      [
        "the non-null branch of an anyOf null union",
        { anyOf: [oneToThreeButTwo, { type: "null" }] },
      ],
      [
        "the non-null branch of a oneOf null union",
        { oneOf: [{ type: "null" }, oneToThreeButTwo] },
      ],
    ] satisfies Array<[string, JSONSchema7]>)(
      "generates around a not on %s, which generation unwraps",
      async (_, schema) => {
        for (let seed = 1; seed <= 30; seed += 1) {
          const { response } = await fakerPlugin({ schema, seed }).process(
            context(),
          );
          expect(response).not.toBe(2);
        }
      },
    );

    it("accepts a not on an allOf entry whose own bound rules its body out", () => {
      const schema: JSONSchema7 = {
        type: "string",
        allOf: [{ type: "string", maxLength: 5, not: { minLength: 10 } }],
      };

      expect(() => fakerPlugin({ schema })).not.toThrow();
    });

    it("accepts a not whose body references a schema the node's type rules out", () => {
      const schema: JSONSchema7 = {
        type: "integer",
        not: { $ref: "#/$defs/S" },
        $defs: { S: { type: "string" } },
      };

      expect(() => fakerPlugin({ schema })).not.toThrow();
    });

    it("generates around a not.const its body references", async () => {
      const schema: JSONSchema7 = {
        type: "integer",
        minimum: 1,
        maximum: 3,
        not: { $ref: "#/$defs/Two" },
        $defs: { Two: { const: 2 } },
      };

      for (let seed = 1; seed <= 30; seed += 1) {
        const { response } = await fakerPlugin({ schema, seed }).process(
          context(),
        );
        expect(response).not.toBe(2);
      }
    });

    it("says why a not.type integer beside type number is rejected", () => {
      const error = captureFailure(() =>
        fakerPlugin({ schema: { type: "number", not: { type: "integer" } } }),
      );

      expectSchemaError(error, "$.not");
      expect(String(error)).toContain("integral number");
    });

    it("generates around a not beside a reference generation inlines", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: { n: { $ref: "#sid", not: { const: 2 } } },
        required: ["n"],
        $defs: {
          S: withKeywords(
            { type: "integer", minimum: 1, maximum: 3 },
            { $anchor: "sid" },
          ),
        },
      };

      for (let seed = 1; seed <= 30; seed += 1) {
        const { response } = await fakerPlugin({ schema, seed }).process(
          context(),
        );
        expect(response).not.toEqual({ n: 2 });
      }
    });

    it.each([
      [
        "a lone not.required, leaving the target's optional property out",
        {
          type: "object",
          properties: { o: { $ref: "#/$defs/Obj", not: { required: ["a"] } } },
          required: ["o"],
          $defs: {
            Obj: {
              type: "object",
              properties: { a: { type: "string" }, b: { type: "string" } },
            },
          },
        },
        (value: unknown) => expect(value).not.toHaveProperty("o.a"),
      ],
      [
        "a lone not.type, narrowing the target's type union",
        {
          type: "object",
          properties: { o: { $ref: "#/$defs/U", not: { type: "string" } } },
          required: ["o"],
          $defs: { U: { type: ["string", "integer"] } },
        },
        (value: unknown) =>
          expect(typeof Reflect.get(Object(value), "o")).not.toBe("string"),
      ],
      [
        "a lone not.type through a chain of JSON Pointers",
        {
          type: "object",
          properties: { o: { $ref: "#/$defs/A", not: { type: "string" } } },
          required: ["o"],
          $defs: {
            A: { $ref: "#/$defs/U" },
            U: { type: ["string", "integer"] },
          },
        },
        (value: unknown) =>
          expect(typeof Reflect.get(Object(value), "o")).not.toBe("string"),
      ],
    ] satisfies Array<[string, JSONSchema7, (value: unknown) => void]>)(
      "honours %s beside a JSON Pointer $ref",
      async (_, schema, check) => {
        for (let seed = 1; seed <= 40; seed += 1) {
          const { response } = await fakerPlugin({ schema, seed }).process(
            context(),
          );
          check(response);
        }
      },
    );

    it.each([
      ["a not.const", { type: "boolean", not: { const: true } }],
      ["a not.enum", { type: "integer", not: { enum: [1, 2] } }],
      [
        "a not.type that narrows a type union",
        { type: ["string", "integer"], not: { type: "string" } },
      ],
      [
        "a not.type the node's type already avoids",
        { type: "string", not: { type: "null" } },
      ],
      ["a not.type on an untyped node", { not: { type: "string" } }],
      [
        "a not.required with an optional property",
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          not: { required: ["a", "b"] },
        },
      ],
      [
        "a not whose length bound the node's own bound rules out",
        { type: "string", maxLength: 20, not: { minLength: 70_000 } },
      ],
      [
        "a not whose numeric bound the node's own bound rules out",
        { type: "integer", minimum: 0, maximum: 10, not: { minimum: 20 } },
      ],
      [
        "a not of the empty schema on a property",
        { type: "object", properties: { gone: { not: {} } } },
      ],
      [
        "a not.const beside a $ref json-schema-faker merges it into",
        {
          type: "object",
          properties: { s: { $ref: "#/$defs/S", not: { const: "open" } } },
          $defs: { S: status },
        },
      ],
      [
        "a not inside a definition nothing references",
        {
          type: "string",
          maxLength: 5,
          $defs: { Unused: { type: "string", not: { pattern: "x" } } },
        },
      ],
    ] satisfies Array<[string, JSONSchema7]>)("accepts %s", (_, schema) => {
      expect(() => fakerPlugin({ schema })).not.toThrow();
    });

    it("generates around a not.const beside a $ref", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: { s: { $ref: "#/$defs/S", not: { const: "open" } } },
        required: ["s"],
        $defs: { S: status },
      };

      for (let seed = 1; seed <= 20; seed += 1) {
        const plugin = fakerPlugin({ schema, seed });
        const { response } = await plugin.process(context());
        expect(response).toEqual({ s: "closed" });
      }
    });

    it("leaves a property whose schema is not of the empty schema out", async () => {
      const generated = await generateOnce({
        type: "object",
        properties: { kept: { type: "integer" }, gone: { not: {} } },
        required: ["kept"],
      });

      expect(generated).not.toHaveProperty("gone");
    });
  });
});
