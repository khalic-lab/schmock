import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
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

    it("replaces an anchor $ref with its target as an allOf entry", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: { n: { $ref: "#sid", description: "An id" } },
        $defs: { S: target },
      };

      const inlined = inlineUnfollowedReferences(schema);

      const n = propertyOf(inlined, "n");
      expect(n).not.toHaveProperty("$ref");
      expect(n.description).toBe("An id");
      expect(n.allOf).toHaveLength(1);
      expect(n.allOf?.[0]).toBe(inlined.$defs?.S);
      expect(n.allOf?.[0]).toEqual(target);
    });

    it("replaces a $dynamicRef and appends to an allOf already there", () => {
      const existing: JSONSchema7 = { minLength: 1 };
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          n: withKeywords({ allOf: [existing] }, { $dynamicRef: "#sid" }),
        },
        $defs: {
          S: withKeywords({ type: "string" }, { $dynamicAnchor: "sid" }),
        },
      };

      const n = propertyOf(inlineUnfollowedReferences(schema), "n");

      expect(n).not.toHaveProperty("$dynamicRef");
      expect(n.allOf).toEqual([
        existing,
        withKeywords({ type: "string" }, { $dynamicAnchor: "sid" }),
      ]);
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
});
