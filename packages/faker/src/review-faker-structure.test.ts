import { SchemaValidationError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { generateWithJsf, normalizeSchemaForJsf } from "./jsf-config";
import {
  collectSchemaChildren,
  mapSchemaChildren,
  SCHEMA_KEYWORDS,
} from "./schema-children";
import { enhanceSchemaWithSmartMapping } from "./schema-enhancement";
import { isJSONSchema7, isRecord } from "./utils";
import { validateSchema } from "./validation";

/** Build a schema from keywords the JSONSchema7 type does not declare. */
function schemaWith(entries: Record<string, unknown>): JSONSchema7 {
  const schema: JSONSchema7 = {};
  for (const [keyword, value] of Object.entries(entries)) {
    Reflect.set(schema, keyword, value);
  }
  return schema;
}

/** An object whose only keys match `^<prefix>_[a-z]{3}$`. */
function patternMap(prefix: string, type: "string" | "integer"): JSONSchema7 {
  return {
    type: "object",
    patternProperties: { [`^${prefix}_[a-z]{3}$`]: { type } },
  };
}

function validationFailure(schema: JSONSchema7): SchemaValidationError {
  try {
    validateSchema(schema);
  } catch (error) {
    if (error instanceof SchemaValidationError) return error;
    throw error;
  }
  throw new Error("Expected validateSchema to throw");
}

/** Put `child` under `keyword` in the shape the keyword takes. */
function holding(keyword: string, child: JSONSchema7): JSONSchema7 {
  const descriptor = SCHEMA_KEYWORDS.find((entry) => entry.keyword === keyword);
  if (!descriptor) throw new Error(`Unknown keyword ${keyword}`);
  const value =
    descriptor.shape === "array"
      ? [child]
      : descriptor.shape === "map"
        ? { zzqx: child }
        : child;
  // `additionalItems` constrains nothing without a sibling `items`.
  return keyword === "additionalItems"
    ? schemaWith({ items: true, additionalItems: value })
    : schemaWith({ [keyword]: value });
}

function childOf(container: unknown, keyword: string): unknown {
  if (!isRecord(container)) return undefined;
  const value = container[keyword];
  if (Array.isArray(value)) return value[0];
  if (isRecord(value) && Object.hasOwn(value, "zzqx")) return value.zzqx;
  return value;
}

describe("review R14: one keyword table for the three walkers", () => {
  it("lists every schema-bearing keyword once", () => {
    const keywords = SCHEMA_KEYWORDS.map((entry) => entry.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(keywords).toEqual([
      "properties",
      "definitions",
      "$defs",
      "patternProperties",
      "items",
      "additionalItems",
      "prefixItems",
      "allOf",
      "anyOf",
      "oneOf",
      "additionalProperties",
      "contains",
      "not",
      "if",
      "then",
      "else",
      "propertyNames",
      "dependencies",
      "contentSchema",
      "dependentSchemas",
      "containsAll",
    ]);
  });

  describe.each(SCHEMA_KEYWORDS.map((entry) => entry.keyword))(
    "%s",
    (keyword) => {
      it("is validated: collectSchemaChildren reaches its child", () => {
        const child: JSONSchema7 = { type: "string" };
        const children = collectSchemaChildren(holding(keyword, child), "$");
        expect(children).toHaveLength(1);
        expect(children[0].schema).toBe(child);
        expect(children[0].path.startsWith(`$.${keyword}`)).toBe(true);
      });

      it("is normalized: JSF keeps the keyword and descends into it", () => {
        const child = schemaWith({ type: "string", consumerOnlyKeyword: 1 });
        const normalized = normalizeSchemaForJsf(holding(keyword, child));
        const normalizedChild = childOf(normalized, keyword);
        expect(normalizedChild).toEqual({ type: "string" });
      });

      it("is enhanced: smart mapping rewrites its child", () => {
        const enhanced = enhanceSchemaWithSmartMapping(
          holding(keyword, { type: "string" }),
        );
        expect(childOf(enhanced, keyword)).toEqual({
          type: "string",
          faker: "lorem.word",
        });
      });
    },
  );

  it("leaves unevaluatedProperties/unevaluatedItems out of every walker (documented gap)", () => {
    const child: JSONSchema7 = { type: "string" };
    const schema = schemaWith({
      unevaluatedProperties: child,
      unevaluatedItems: child,
    });
    expect(collectSchemaChildren(schema, "$")).toEqual([]);
    expect(normalizeSchemaForJsf(schema)).toEqual({});
    const enhanced = enhanceSchemaWithSmartMapping(schema);
    expect(Reflect.get(enhanced, "unevaluatedProperties")).toBe(child);
    expect(Reflect.get(enhanced, "unevaluatedItems")).toBe(child);
  });
});

describe("review R14: mapSchemaChildren", () => {
  it("maps lazily, one keyword per step, in table order", () => {
    const seen: string[] = [];
    const schema: JSONSchema7 = {
      not: { type: "string" },
      properties: { a: { type: "string" } },
      items: { type: "string" },
    };
    const mapped = mapSchemaChildren(schema, (child, slot) => {
      seen.push(slot.keyword);
      return child;
    });
    expect(seen).toEqual([]);
    const first = mapped.next();
    if (first.done) throw new Error("Expected a mapped keyword");
    expect(first.value.keyword).toBe("properties");
    expect(seen).toEqual(["properties"]);
    expect([...mapped].map((entry) => entry.keyword)).toEqual(["items", "not"]);
    expect(seen).toEqual(["properties", "items", "not"]);
  });

  it("returns fresh containers and leaves the schema untouched", () => {
    const properties = {
      a: { type: "string" },
    } satisfies JSONSchema7["properties"];
    const allOf: JSONSchema7[] = [{ type: "string" }];
    const schema: JSONSchema7 = { properties, allOf };
    const results = [...mapSchemaChildren(schema, (child) => child)];
    expect(results).toHaveLength(2);
    for (const { value } of results) {
      expect(value === properties || value === allOf).toBe(false);
    }
    expect(schema).toEqual({ properties, allOf });
    expect(schema.properties).toBe(properties);
  });

  it("drops a list or map entry mapped to undefined, and skips a single keyword", () => {
    const schema: JSONSchema7 = {
      allOf: [{ type: "string" }, { type: "integer" }],
      properties: { a: { type: "string" }, b: { type: "integer" } },
      not: { type: "integer" },
    };
    const results = [
      ...mapSchemaChildren(schema, (child) =>
        isJSONSchema7(child) && child.type === "integer" ? undefined : child,
      ),
    ];
    expect(results).toEqual([
      { keyword: "properties", form: "map", value: { a: { type: "string" } } },
      { keyword: "allOf", form: "array", value: [{ type: "string" }] },
    ]);
  });

  it("keeps a __proto__ entry as data", () => {
    const properties: Record<string, JSONSchema7> = {};
    Object.defineProperty(properties, "__proto__", {
      value: { type: "string" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const [result] = [
      ...mapSchemaChildren({ properties }, () => ({ type: "integer" })),
    ];
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.keys(result.value)).toEqual(["__proto__"]);
  });
});

/**
 * Seeded pattern keys are drawn in walk order, so each case below would invent
 * different keys under a different keyword order. Expected values were
 * captured from the pre-refactor normalizer.
 */
describe("review R14: seeded JSF normalization is unchanged", () => {
  const seed = { patternKeySeed: 42 };

  it("definitions before items", () => {
    const schema: JSONSchema7 = {
      type: "array",
      items: patternMap("i", "string"),
      definitions: { X: patternMap("d", "integer") },
    };
    expect(normalizeSchemaForJsf(schema, seed)).toEqual({
      type: "array",
      items: {
        type: "object",
        patternProperties: { "^i_[a-z]{3}$": { type: "string" } },
        properties: { i_xap: { type: "string" } },
        required: ["i_xap"],
      },
      definitions: {
        X: {
          type: "object",
          patternProperties: { "^d_[a-z]{3}$": { type: "integer" } },
          properties: { d_yjr: { type: "integer" } },
          required: ["d_yjr"],
        },
      },
    });
  });

  it("a node's own pattern keys before its additionalProperties and allOf", () => {
    const additional: JSONSchema7 = {
      ...patternMap("a", "string"),
      additionalProperties: patternMap("b", "integer"),
    };
    expect(normalizeSchemaForJsf(additional, seed)).toEqual({
      type: "object",
      patternProperties: { "^a_[a-z]{3}$": { type: "string" } },
      additionalProperties: {
        type: "object",
        patternProperties: { "^b_[a-z]{3}$": { type: "integer" } },
        properties: { b_xap: { type: "integer" } },
        required: ["b_xap"],
      },
      properties: { a_yjr: { type: "string" } },
      required: ["a_yjr"],
    });

    const composed: JSONSchema7 = {
      ...patternMap("a", "string"),
      allOf: [patternMap("c", "integer")],
    };
    expect(normalizeSchemaForJsf(composed, seed)).toEqual({
      type: "object",
      patternProperties: { "^a_[a-z]{3}$": { type: "string" } },
      allOf: [
        {
          type: "object",
          patternProperties: { "^c_[a-z]{3}$": { type: "integer" } },
          properties: { c_xap: { type: "integer" } },
          required: ["c_xap"],
        },
      ],
      properties: { a_yjr: { type: "string" } },
      required: ["a_yjr"],
    });
  });

  it("a Draft-7 tuple: prefixItems from items, items from additionalItems, native prefixItems ignored", () => {
    const schema = schemaWith({
      type: "array",
      items: [patternMap("t", "string")],
      additionalItems: patternMap("x", "integer"),
      prefixItems: [patternMap("n", "string")],
    });
    const normalized = normalizeSchemaForJsf(schema, seed);
    expect(normalized).toEqual({
      type: "array",
      items: {
        type: "object",
        patternProperties: { "^x_[a-z]{3}$": { type: "integer" } },
        properties: { x_xap: { type: "integer" } },
        required: ["x_xap"],
      },
      prefixItems: [
        {
          type: "object",
          patternProperties: { "^t_[a-z]{3}$": { type: "string" } },
          properties: { t_yjr: { type: "string" } },
          required: ["t_yjr"],
        },
      ],
    });
    expect(Object.keys(normalized)).toEqual(["type", "items", "prefixItems"]);
  });

  it("native prefixItems after items", () => {
    const schema = schemaWith({
      type: "array",
      prefixItems: [patternMap("p", "string")],
      items: patternMap("q", "integer"),
    });
    expect(normalizeSchemaForJsf(schema, seed)).toEqual({
      type: "array",
      prefixItems: [
        {
          type: "object",
          patternProperties: { "^p_[a-z]{3}$": { type: "string" } },
          properties: { p_xap: { type: "string" } },
          required: ["p_xap"],
        },
      ],
      items: {
        type: "object",
        patternProperties: { "^q_[a-z]{3}$": { type: "integer" } },
        properties: { q_yjr: { type: "integer" } },
        required: ["q_yjr"],
      },
    });
  });

  it("additionalItems without items keeps its raw copy", () => {
    const additionalItems = schemaWith({
      ...patternMap("o", "string"),
      bogusKeyword: 1,
    });
    const schema: JSONSchema7 = { type: "array", additionalItems };
    expect(normalizeSchemaForJsf(schema, seed)).toEqual({
      type: "array",
      additionalItems,
    });
  });

  it("a shared subschema is normalized once and stays aliased", () => {
    const shared = patternMap("sh", "string");
    const normalized = normalizeSchemaForJsf(
      {
        type: "object",
        properties: { a: shared, b: shared },
        allOf: [{ type: "object", properties: { c: shared } }],
        definitions: { S: shared },
      },
      { patternKeySeed: 7 },
    );
    const properties = normalized.properties;
    if (!isRecord(properties)) throw new Error("Expected properties");
    expect(properties.a).toBe(properties.b);
    expect(properties.a).toEqual({
      type: "object",
      patternProperties: { "^sh_[a-z]{3}$": { type: "string" } },
      properties: { sh_gfl: { type: "string" } },
      required: ["sh_gfl"],
    });
  });

  it("generates the same seeded values as before", async () => {
    const refDate = "2025-01-01T00:00:00.000Z";
    await expect(
      generateWithJsf(
        {
          type: "array",
          items: patternMap("i", "string"),
          definitions: { X: patternMap("d", "integer") },
        },
        42,
        refDate,
      ),
    ).resolves.toEqual([
      { i_xap: "B0PkGq" },
      { i_xap: "1Dp2Ut" },
      { i_xap: "FQ" },
    ]);
    await expect(
      generateWithJsf(
        { ...patternMap("a", "string"), allOf: [patternMap("c", "integer")] },
        42,
        refDate,
      ),
    ).resolves.toEqual({ a_yjr: "B0PkGq", c_xap: 250 });
    await expect(
      generateWithJsf(
        schemaWith({
          type: "array",
          items: [patternMap("t", "string")],
          additionalItems: patternMap("x", "integer"),
        }),
        42,
        refDate,
      ),
    ).resolves.toEqual([{ t_yjr: "B0PkGq" }, { x_xap: 250 }, { x_xap: 731 }]);
  });
});

/**
 * Behaviour changes pinned: malformed children now follow one rule in JSF
 * normalization (drop a list/map entry, keep a single keyword's raw copy)
 * where the typed keywords used to throw a TypeError.
 */
describe("review R14: malformed children in JSF normalization", () => {
  it("drops malformed list and map entries instead of throwing", () => {
    expect(
      normalizeSchemaForJsf(
        schemaWith({
          type: "object",
          properties: { a: 5, b: { type: "string" }, c: null },
          allOf: [5, { type: "string" }],
          prefixItems: [5, { type: "string" }],
        }),
      ),
    ).toEqual({
      type: "object",
      properties: { b: { type: "string" } },
      allOf: [{ type: "string" }],
      prefixItems: [{ type: "string" }],
    });
  });

  it("keeps a malformed single-schema keyword as its raw copy", () => {
    expect(
      normalizeSchemaForJsf(
        schemaWith({ type: "array", items: 5, not: "x", contentSchema: 5 }),
      ),
    ).toEqual({ type: "array", items: 5, not: "x", contentSchema: 5 });
    expect(
      normalizeSchemaForJsf(schemaWith({ type: "array", items: null })),
    ).toEqual({ type: "array", items: null });
  });

  it("turns a malformed tuple additionalItems into items: true", () => {
    expect(
      normalizeSchemaForJsf(
        schemaWith({
          type: "array",
          items: [5, { type: "string" }],
          additionalItems: 7,
        }),
      ),
    ).toEqual({
      type: "array",
      items: true,
      prefixItems: [{ type: "string" }],
    });
  });

  it("copies dependency property lists and drops malformed dependencies", () => {
    const list = ["b"];
    const normalized = normalizeSchemaForJsf(
      schemaWith({ dependencies: { a: list, c: 5, d: { type: "string" } } }),
    );
    expect(normalized.dependencies).toEqual({
      a: ["b"],
      d: { type: "string" },
    });
    expect(normalized.dependencies?.a).not.toBe(list);
  });

  it("passes a wrongly shaped container through untouched", () => {
    const allOf = { type: "string" };
    expect(normalizeSchemaForJsf(schemaWith({ allOf }))).toEqual({ allOf });
    expect(enhanceSchemaWithSmartMapping(schemaWith({ allOf }))).toEqual({
      allOf,
    });
  });
});

/**
 * Behaviour change pinned: validation now walks keywords in the table's order,
 * so when a schema has several faults the one reported can differ. Pass/fail
 * is unchanged.
 */
describe("review R14: validation reports the first fault in table order", () => {
  /** A string schema whose faker method does not exist. */
  const badFaker = (method: string): JSONSchema7 =>
    schemaWith({ type: "string", faker: method });

  it("reports a definition before the items that reference it", () => {
    const error = validationFailure({
      type: "array",
      items: { $ref: "#/definitions/X" },
      definitions: { X: badFaker("nope.missing") },
    });
    expect(error.message).toContain("$.definitions.X.faker");
  });

  it("reports properties before items, and allOf before contains", () => {
    expect(
      validationFailure({
        type: ["object", "array"],
        items: badFaker("nope.items"),
        properties: { a: badFaker("nope.properties") },
      }).message,
    ).toContain("$.properties.a.faker");
    expect(
      validationFailure({
        contains: badFaker("nope.contains"),
        allOf: [badFaker("nope.allOf")],
      }).message,
    ).toContain("$.allOf[0].faker");
  });

  it("still walks an array-valued map by index", () => {
    const schema = schemaWith({
      patternProperties: [{ type: "string", faker: "nope.pattern" }],
    });
    expect(validationFailure(schema).message).toContain(
      "$.patternProperties.0.faker",
    );
  });
});

/**
 * Behaviour change pinned: every map keyword now accepts any object, arrays
 * included. `definitions`, `$defs` and `dependentSchemas` used to be skipped
 * when array-valued by validation and smart mapping (and `dependentSchemas` by
 * JSF normalization too); all three walkers now read them by index.
 */
describe("review R14: array-valued maps are walked by every walker", () => {
  it("validation rejects a bad child of an array-valued definitions", () => {
    const schema = schemaWith({
      definitions: [{ type: "string", faker: "nope.defs" }],
    });
    expect(validationFailure(schema).message).toContain(
      "$.definitions.0.faker",
    );
  });

  it("smart mapping enhances array-valued maps as index-keyed maps", () => {
    for (const keyword of [
      "patternProperties",
      "definitions",
      "$defs",
      "dependentSchemas",
    ]) {
      const enhanced = enhanceSchemaWithSmartMapping(
        schemaWith({ [keyword]: [{ type: "string" }] }),
      );
      expect(Reflect.get(enhanced, keyword)).toEqual({
        0: { type: "string", faker: "lorem.word" },
      });
    }
  });

  it("JSF normalization turns an array-valued dependentSchemas into a map", () => {
    expect(
      normalizeSchemaForJsf(
        schemaWith({ dependentSchemas: [{ type: "string", extra: 1 }] }),
      ),
    ).toEqual({ dependentSchemas: { 0: { type: "string" } } });
  });

  it("smart mapping drops a map entry whose value is undefined", () => {
    const enhanced = enhanceSchemaWithSmartMapping(
      schemaWith({
        type: "object",
        properties: { a: undefined, b: { type: "string", format: "email" } },
      }),
    );
    expect(Object.keys(enhanced.properties ?? {})).toEqual(["b"]);
  });
});

describe("review R15: one isRecord / isJSONSchema7", () => {
  it("accepts plain objects only", () => {
    for (const guard of [isRecord, isJSONSchema7]) {
      expect(guard({})).toBe(true);
      expect(guard(Object.create(null))).toBe(true);
      expect(guard([])).toBe(false);
      expect(guard(null)).toBe(false);
      expect(guard(true)).toBe(false);
      expect(guard("x")).toBe(false);
    }
  });
});
