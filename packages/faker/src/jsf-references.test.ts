import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { generateFromSchema } from "./index.js";
import { inlineUnfollowedReferences } from "./jsf-references.js";

function withKeywords(
  schema: JSONSchema7,
  keywords: Record<string, unknown>,
): JSONSchema7 {
  for (const [keyword, value] of Object.entries(keywords)) {
    Reflect.set(schema, keyword, value);
  }
  return schema;
}

function propertyOf(schema: JSONSchema7, name: string): JSONSchema7 {
  const property = schema.properties?.[name];
  if (typeof property !== "object") {
    throw new Error(`Expected a schema at properties.${name}`);
  }
  return property;
}

describe("inlineUnfollowedReferences", () => {
  describe("schemas json-schema-faker already follows", () => {
    it.each([
      [
        "only root JSON Pointers",
        {
          type: "object",
          properties: { a: { $ref: "#/$defs/A" }, self: { $ref: "#" } },
          $defs: { A: { type: "string" } },
        },
      ],
      [
        "only root JSON Pointers under a URN $id",
        {
          $id: "urn:example:root",
          type: "object",
          properties: { a: { $ref: "#/$defs/A" }, self: { $ref: "#" } },
          $defs: { A: { type: "string" } },
        },
      ],
      [
        "a reference nothing resolves",
        { type: "object", properties: { a: { $ref: "missing.json" } } },
      ],
      ["no reference at all", { type: "string", maxLength: 3 }],
    ] satisfies Array<[string, JSONSchema7]>)(
      "returns the schema itself when it holds %s",
      (_, schema) => {
        expect(inlineUnfollowedReferences(schema)).toBe(schema);
      },
    );
  });

  describe("references it replaces", () => {
    const target = withKeywords(
      { type: "string", format: "uuid" },
      { $anchor: "sid" },
    );

    it("merges an anchor $ref's target into the node, its own keywords over it", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          n: { $ref: "#sid", format: "date", description: "An id" },
        },
        $defs: { S: target },
      };

      const inlined = inlineUnfollowedReferences(schema);

      expect(propertyOf(inlined, "n")).toEqual({
        type: "string",
        format: "date",
        description: "An id",
      });
      expect(inlined.$defs?.S).toEqual(target);
    });

    it("keeps the target's faker, not, if, then and default", () => {
      const carried = withKeywords(
        {
          type: "integer",
          not: { const: 2 },
          if: { minimum: 0 },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
          then: { maximum: 3 },
          default: 1,
        },
        { faker: "number.int", $anchor: "sid" },
      );
      const schema: JSONSchema7 = {
        type: "object",
        properties: { n: { $ref: "#sid" } },
        $defs: { S: carried },
      };

      const n = propertyOf(inlineUnfollowedReferences(schema), "n");

      const { $anchor: _identifier, ...expected } = carried as JSONSchema7 & {
        $anchor?: string;
      };
      expect(n).toEqual(expected);
    });

    it("merges a $dynamicRef and appends the node's allOf to the target's", () => {
      const existing: JSONSchema7 = { minLength: 1 };
      const inherited: JSONSchema7 = { maxLength: 9 };
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          n: withKeywords({ allOf: [existing] }, { $dynamicRef: "#sid" }),
        },
        $defs: {
          S: withKeywords(
            { type: "string", allOf: [inherited] },
            { $dynamicAnchor: "sid" },
          ),
        },
      };

      const n = propertyOf(inlineUnfollowedReferences(schema), "n");

      expect(n).not.toHaveProperty("$dynamicRef");
      expect(n).toEqual({ type: "string", allOf: [inherited, existing] });
    });

    it("merges a root JSON Pointer beside a not, through a chain", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: { o: { $ref: "#/$defs/A", not: { type: "string" } } },
        $defs: {
          A: { $ref: "#/$defs/U" },
          U: { type: ["string", "integer"] },
        },
      };

      const o = propertyOf(inlineUnfollowedReferences(schema), "o");

      expect(o).toEqual({
        type: ["string", "integer"],
        not: { type: "string" },
      });
    });

    it("merges a root JSON Pointer that is a not body", () => {
      const schema: JSONSchema7 = {
        type: "integer",
        not: { $ref: "#/$defs/Two" },
        $defs: { Two: { const: 2 } },
      };

      expect(inlineUnfollowedReferences(schema).not).toEqual({ const: 2 });
    });

    it("leaves the schema it was given unchanged", () => {
      const reference: JSONSchema7 = { $ref: "#sid" };
      const schema: JSONSchema7 = {
        type: "object",
        properties: { n: reference },
        $defs: { S: target },
      };

      inlineUnfollowedReferences(schema);

      expect(reference).toEqual({ $ref: "#sid" });
      expect(schema.properties?.n).toBe(reference);
    });

    it("copies a node shared by two parents once", () => {
      const shared: JSONSchema7 = { $ref: "#sid" };
      const schema: JSONSchema7 = {
        type: "object",
        properties: { a: shared, b: shared },
        $defs: { S: target },
      };

      const inlined = inlineUnfollowedReferences(schema);

      expect(propertyOf(inlined, "a")).toBe(propertyOf(inlined, "b"));
    });
  });

  describe("generation follows each reference to the schema it names", () => {
    it("follows a percent-encoded root JSON Pointer", async () => {
      const schema: JSONSchema7 = {
        $defs: { "Page<User>": { const: "P" }, "a b": { const: "S" } },
        type: "object",
        required: ["page", "spaced"],
        properties: {
          page: { $ref: "#/$defs/Page%3CUser%3E" },
          spaced: { $ref: "#/$defs/a%20b" },
        },
      };

      await expect(generateFromSchema({ schema })).resolves.toEqual({
        page: "P",
        spaced: "S",
      });
    });

    it("reads a root $defs pointer from the root below a nested $defs of that name", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        required: ["a"],
        $defs: { x: { const: "ROOT" } },
        properties: {
          a: {
            type: "object",
            required: ["b"],
            $defs: { x: { const: 7 } },
            properties: { b: { $ref: "#/$defs/x" } },
          },
        },
      };

      await expect(generateFromSchema({ schema })).resolves.toEqual({
        a: { b: "ROOT" },
      });
    });

    describe("a JSON Pointer inside an embedded $id resource", () => {
      const resource = (rootDefs: JSONSchema7["$defs"]): JSONSchema7 => ({
        type: "object",
        required: ["a"],
        properties: { a: { $ref: "https://ex.com/a.json" } },
        $defs: {
          ...rootDefs,
          A: {
            $id: "https://ex.com/a.json",
            type: "object",
            required: ["b"],
            properties: { b: { $ref: "#/$defs/B" } },
            $defs: { B: { type: "integer", minimum: 7, maximum: 8 } },
          },
        },
      });

      it.each([
        ["no root definition of that name", {}],
        [
          "a root definition of the same name",
          { B: { type: "string", const: "ROOT" } },
        ],
      ] satisfies Array<[string, JSONSchema7["$defs"]]>)(
        "resolves against the resource with %s",
        async (_, rootDefs) => {
          for (let seed = 1; seed <= 5; seed++) {
            const value = await generateFromSchema({
              schema: resource(rootDefs),
              seed,
            });
            expect([{ a: { b: 7 } }, { a: { b: 8 } }]).toContainEqual(value);
          }
        },
      );

      // No nested `$defs` here, so only the pointer's place inside the
      // resource tells it apart from a root pointer.
      it.each([
        ["#/definitions/B", "B"],
        ["#/properties/c", "c"],
      ])(
        "merges %s against the resource when the root reads it differently",
        async (pointer) => {
          const schema: JSONSchema7 = {
            type: "object",
            required: ["a"],
            properties: {
              a: { $ref: "https://ex.com/a.json" },
              c: { type: "string", const: "ROOT" },
            },
            definitions: { B: { type: "string", const: "ROOT" } },
            $defs: {
              A: {
                $id: "https://ex.com/a.json",
                type: "object",
                required: ["b"],
                properties: {
                  b: { $ref: pointer },
                  c: { type: "integer", const: 7 },
                },
                definitions: { B: { type: "integer", const: 7 } },
              },
            },
          };
          const copy = inlineUnfollowedReferences(schema);
          const a = propertyOf(copy, "a");
          expect(propertyOf(a, "b")).toMatchObject({
            type: "integer",
            const: 7,
          });
          expect(propertyOf(a, "b").$ref).toBeUndefined();
          for (let seed = 1; seed <= 3; seed++) {
            const value = await generateFromSchema({ schema, seed });
            expect(value).toMatchObject({ a: { b: 7 } });
          }
        },
      );
    });
  });
});
