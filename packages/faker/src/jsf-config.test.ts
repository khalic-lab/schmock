import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { normalizeSchemaForJsf } from "./jsf-config.js";

const tuple: JSONSchema7 = {
  type: "array",
  items: [{ type: "string" }, { type: "integer" }],
  minItems: 2,
  maxItems: 2,
  additionalItems: false,
};

function expectNormalizedTuple(value: unknown): void {
  expect(value).toMatchObject({
    type: "array",
    prefixItems: [{ type: "string" }, { type: "integer" }],
    items: false,
  });
  expect(value).not.toHaveProperty("additionalItems");
}

describe("normalizeSchemaForJsf", () => {
  it("recurses through Draft-7 schema-bearing keywords", () => {
    const normalized = normalizeSchemaForJsf({
      type: "object",
      definitions: { legacy: tuple },
      $defs: { modern: tuple },
      patternProperties: { "^tuple$": tuple },
      contains: tuple,
      not: tuple,
      if: tuple,
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
      then: tuple,
      else: tuple,
    });

    const record: Record<string, unknown> = normalized;
    const definitions = record.definitions;
    const defs = record.$defs;
    const patternProperties = record.patternProperties;

    expect(definitions).toBeTypeOf("object");
    expect(defs).toBeTypeOf("object");
    expect(patternProperties).toBeTypeOf("object");
    if (
      definitions === null ||
      typeof definitions !== "object" ||
      defs === null ||
      typeof defs !== "object" ||
      patternProperties === null ||
      typeof patternProperties !== "object"
    ) {
      throw new Error("Expected normalized schema maps");
    }

    expectNormalizedTuple(Reflect.get(definitions, "legacy"));
    expectNormalizedTuple(Reflect.get(defs, "modern"));
    expectNormalizedTuple(Reflect.get(patternProperties, "^tuple$"));
    expectNormalizedTuple(record.contains);
    expectNormalizedTuple(record.not);
    expectNormalizedTuple(record.if);
    expectNormalizedTuple(record.then);
    expectNormalizedTuple(record.else);
  });
});
