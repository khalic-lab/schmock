import type { JSONSchema7 } from "json-schema";
import { registerFormat } from "json-schema-faker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_NESTING_DEPTH } from "./constants.js";
import { generateFromSchema } from "./index.js";
import {
  createFakerInstance,
  DETERMINISTIC_REF_DATE,
  normalizeSchemaForJsf,
} from "./jsf-config.js";

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

describe("seeded reference date", () => {
  const datedSchema = {
    type: "object",
    properties: {
      zzWhen: { type: "string", format: "date-time", faker: "date.recent" },
    },
    required: ["zzWhen"],
  } as unknown as JSONSchema7;

  function generatedYear(value: unknown): number {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected generated data to be an object");
    }
    const when = Reflect.get(value, "zzWhen");
    if (typeof when !== "string") {
      throw new Error("Expected zzWhen to be a string");
    }
    const parsed = new Date(when);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    return parsed.getUTCFullYear();
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reproduces the same dates for one seed regardless of wall-clock time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    const first = await generateFromSchema({ schema: datedSchema, seed: 42 });

    vi.setSystemTime(new Date("2031-09-15T12:00:00.000Z"));
    const second = await generateFromSchema({ schema: datedSchema, seed: 42 });

    expect(second).toEqual(first);
  });

  it("keeps unseeded generation anchored to the wall clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    const first = await generateFromSchema({ schema: datedSchema });

    vi.setSystemTime(new Date("2031-09-15T12:00:00.000Z"));
    const second = await generateFromSchema({ schema: datedSchema });

    expect(generatedYear(first)).toBe(2026);
    expect(generatedYear(second)).toBe(2031);
  });
});

describe("schema-owned references", () => {
  function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected a plain object");
    }
    return value as Record<string, unknown>;
  }

  it("never hands back the schema's own default value", async () => {
    const defaultPrefs = { theme: "dark" };
    const schema: JSONSchema7 = {
      type: "object",
      properties: { prefs: { type: "object", default: defaultPrefs } },
      required: ["prefs"],
    };

    const generated = asRecord(await generateFromSchema({ schema, seed: 3 }));
    expect(generated.prefs).toEqual({ theme: "dark" });
    expect(generated.prefs).not.toBe(defaultPrefs);

    asRecord(generated.prefs).theme = "MUTATED";
    expect(defaultPrefs.theme).toBe("dark");

    const regenerated = asRecord(await generateFromSchema({ schema, seed: 3 }));
    expect(regenerated.prefs).toEqual({ theme: "dark" });
  });

  it("gives each generated array item its own copy of a default", async () => {
    const schema: JSONSchema7 = {
      type: "array",
      items: {
        type: "object",
        properties: { cfg: { type: "object", default: { retries: 1 } } },
        required: ["cfg"],
      },
    };

    const generated = await generateFromSchema({ schema, count: 3, seed: 3 });
    if (!Array.isArray(generated)) {
      throw new Error("Expected an array");
    }

    const first = asRecord(generated[0]).cfg;
    const second = asRecord(generated[1]).cfg;
    const third = asRecord(generated[2]).cfg;
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
  });

  it("keeps generating when a default value cannot be structurally cloned", async () => {
    const callback = () => "unclonable";
    const schema = {
      type: "object",
      properties: { hook: { default: callback } },
      required: ["hook"],
    } as unknown as JSONSchema7;

    const generated = asRecord(await generateFromSchema({ schema, seed: 3 }));
    expect(generated.hook).toBe(callback);
  });
});

describe("generation depth", () => {
  function asRecord(value: unknown, where: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Expected an object at ${where}, got ${String(value)}`);
    }
    return value as Record<string, unknown>;
  }

  const leafObject: JSONSchema7 = {
    type: "object",
    properties: { leaf: { type: "string" } },
    required: ["leaf"],
  };

  /** A chain of `levels` required objects, ending in a required string. */
  function objectChain(levels: number): JSONSchema7 {
    let schema = leafObject;
    for (let level = 1; level < levels; level++) {
      schema = {
        type: "object",
        properties: { nested: schema },
        required: ["nested"],
      };
    }
    return schema;
  }

  /** `pairs` alternations of object -> single-element array -> object. */
  function alternatingChain(pairs: number): JSONSchema7 {
    let schema = leafObject;
    for (let pair = 0; pair < pairs; pair++) {
      schema = {
        type: "object",
        properties: {
          rows: { type: "array", items: schema, minItems: 1, maxItems: 1 },
        },
        required: ["rows"],
      };
    }
    return schema;
  }

  /** The same chain expressed as `$defs` linked by `$ref`. */
  function refChain(levels: number): JSONSchema7 {
    const defs: Record<string, JSONSchema7> = {};
    for (let level = 0; level < levels; level++) {
      defs[`L${level}`] =
        level === levels - 1
          ? leafObject
          : {
              type: "object",
              properties: { nested: { $ref: `#/$defs/L${level + 1}` } },
              required: ["nested"],
            };
    }
    return { $ref: "#/$defs/L0", $defs: defs } as JSONSchema7;
  }

  // Derived from the constant, not a literal: JSF_MAX_DEPTH exists so that
  // json-schema-faker never truncates a chain validation admits, and the pair
  // must stay tied when either moves.
  it("generates every required property of a MAX_NESTING_DEPTH-deep object chain", async () => {
    const generated = await generateFromSchema({
      schema: objectChain(MAX_NESTING_DEPTH),
      seed: 11,
    });

    let node = asRecord(generated, "$");
    for (let level = 1; level < MAX_NESTING_DEPTH; level++) {
      node = asRecord(node.nested, `$${".nested".repeat(level)}`);
    }
    expect(node.leaf).toBeTypeOf("string");
  });

  it("generates through alternating objects and arrays of objects", async () => {
    const generated = await generateFromSchema({
      schema: alternatingChain(4),
      seed: 11,
    });

    let node = asRecord(generated, "$");
    for (let pair = 0; pair < 4; pair++) {
      const rows = node.rows;
      expect(Array.isArray(rows)).toBe(true);
      const items = rows as unknown[];
      expect(items).toHaveLength(1);
      node = asRecord(items[0], `$${".rows[0]".repeat(pair + 1)}`);
    }
    expect(node.leaf).toBeTypeOf("string");
  });

  it("generates through a $defs chain linked by $ref", async () => {
    const generated = await generateFromSchema({
      schema: refChain(10),
      seed: 11,
    });

    let node = asRecord(generated, "$");
    for (let level = 1; level < 10; level++) {
      node = asRecord(node.nested, `$${".nested".repeat(level)}`);
    }
    expect(node.leaf).toBeTypeOf("string");
  });
});

describe("format registry isolation", () => {
  const DOTTED_QUAD = /^\d{1,3}(\.\d{1,3}){3}$/;

  const ipSchema = {
    type: "object",
    properties: { zqx: { type: "string", format: "ipv4" } },
    required: ["zqx"],
  } as JSONSchema7;

  async function generateIp(): Promise<string> {
    const value = await generateFromSchema({ schema: ipSchema, seed: 7 });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected generated data to be an object");
    }
    const zqx = Reflect.get(value, "zqx");
    if (typeof zqx !== "string") {
      throw new Error("Expected zqx to be a string");
    }
    return zqx;
  }

  it("ignores consumer registerFormat calls on the shared json-schema-faker module", async () => {
    // Guards against a vacuous pass: if the format registry were never
    // consulted the baseline would not be a dotted quad.
    expect(await generateIp()).toMatch(DOTTED_QUAD);

    registerFormat("ipv4", () => "9.9.9.9");

    const afterRegistration = await generateIp();
    expect(afterRegistration).not.toBe("9.9.9.9");
    expect(afterRegistration).toMatch(DOTTED_QUAD);
  });
});

/** `schema` with `extra` set as plain keys, for keywords JSONSchema7 lacks. */
function withKeys(
  schema: JSONSchema7,
  extra: Record<string, unknown>,
): JSONSchema7 {
  const copy: JSONSchema7 = { ...schema };
  for (const [key, value] of Object.entries(extra)) {
    Reflect.set(copy, key, value);
  }
  return copy;
}

async function generateSeeds(
  schema: JSONSchema7,
  seeds = 40,
): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let seed = 1; seed <= seeds; seed += 1) {
    values.push(await generateFromSchema({ schema, seed }));
  }
  return values;
}

function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

describe("object nodes without properties (faker-6)", () => {
  it("gives an object node without properties an empty properties map", () => {
    for (const schema of [
      { type: "object", additionalProperties: false },
      { type: ["object", "null"], additionalProperties: { type: "string" } },
      { additionalProperties: { type: "integer" } },
      { minProperties: 1 },
    ] satisfies JSONSchema7[]) {
      expect(normalizeSchemaForJsf(schema).properties).toEqual({});
    }
  });

  it("leaves nodes that are not objects, or already declare properties, alone", () => {
    for (const schema of [
      { type: "string" },
      { type: "array", items: { type: "string" } },
      { $ref: "#/$defs/A", $defs: { A: { type: "string" } } },
      {},
    ] satisfies JSONSchema7[]) {
      expect(normalizeSchemaForJsf(schema).properties).toBeUndefined();
    }
    const declared = normalizeSchemaForJsf({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(Object.keys(Object(declared.properties))).toEqual(["a"]);
  });

  it("never emits definitions, dependencies or example as generated keys", async () => {
    const cases: JSONSchema7[] = [
      {
        type: "object",
        additionalProperties: { $ref: "#/definitions/Item" },
        definitions: { Item: { type: "integer" } },
      },
      withKeys(
        { type: "object", additionalProperties: false },
        { example: {} },
      ),
      withKeys(
        { type: "object", additionalProperties: { type: "string" } },
        { example: { a: 1 } },
      ),
      {
        type: "object",
        additionalProperties: { type: "string" },
        dependencies: { a: ["b"] },
      },
    ];
    for (const schema of cases) {
      for (const value of await generateSeeds(schema)) {
        const generated = objectOf(value);
        for (const key of ["definitions", "dependencies", "example"]) {
          expect(Object.hasOwn(generated, key)).toBe(false);
        }
      }
    }
  });

  it("keeps an untyped node's object example out of the body", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        meta: withKeys({ description: "Free-form" }, { example: { k: "v" } }),
      },
      required: ["meta"],
    };
    for (const value of await generateSeeds(schema)) {
      const { meta } = objectOf(value);
      expect(meta).not.toEqual({ example: { k: "v" } });
      if (typeof meta === "object" && meta !== null) {
        expect(Object.hasOwn(meta, "example")).toBe(false);
      }
    }
  });

  it("keeps a nested map's example out of the body", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        meta: withKeys(
          { type: "object", additionalProperties: { type: "string" } },
          { example: { k: "v" } },
        ),
      },
      required: ["meta"],
    };
    for (const value of await generateSeeds(schema)) {
      const meta = objectOf(objectOf(value).meta);
      expect(Object.hasOwn(meta, "example")).toBe(false);
      for (const entry of Object.values(meta)) {
        expect(typeof entry).toBe("string");
      }
    }
  });
});

describe("not bodies json-schema-faker misses (faker-2)", () => {
  it("narrows a type union by not.type and drops the not", () => {
    expect(
      normalizeSchemaForJsf({
        type: ["string", "integer"],
        not: { type: "string" },
      }),
    ).toEqual({ type: "integer" });
    expect(
      normalizeSchemaForJsf({
        type: ["number", "string", "boolean"],
        not: { type: ["number"] },
      }),
    ).toEqual({ type: ["string", "boolean"] });
    // Every integer is a number, so not.type number rejects integers too.
    expect(
      normalizeSchemaForJsf({
        type: ["integer", "string"],
        not: { type: "number" },
      }),
    ).toEqual({ type: "string" });
  });

  it("leaves a not.type it cannot narrow by to json-schema-faker", () => {
    for (const schema of [
      { type: "string", not: { type: "integer" } },
      { type: ["string", "integer"], not: { type: "boolean" } },
      { type: ["string", "integer"], not: { type: "string", const: "a" } },
    ] satisfies JSONSchema7[]) {
      expect(normalizeSchemaForJsf(schema).not).toBeDefined();
    }
  });

  it("leaves one optional not.required property out of the copy", () => {
    const normalized = normalizeSchemaForJsf({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      not: { required: ["a", "b"] },
    });
    expect(normalized.not).toBeUndefined();
    expect(normalized.properties).toEqual({ a: { type: "string" }, b: false });
  });

  it("leaves not.required alone when every listed property is required", () => {
    const normalized = normalizeSchemaForJsf({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      not: { required: ["a"] },
    });
    expect(normalized.not).toMatchObject({ required: ["a"] });
    expect(normalized.properties).toEqual({ a: { type: "string" } });
  });

  it("generates values the not rejects never", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        pair: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          not: { required: ["a", "b"] },
        },
        id: { type: ["string", "integer"], not: { type: "string" } },
        nickname: { type: "string", not: { const: "" } },
      },
      required: ["pair", "id", "nickname"],
    };
    for (const value of await generateSeeds(schema)) {
      const generated = objectOf(value);
      const pair = objectOf(generated.pair);
      expect(Object.hasOwn(pair, "a") && Object.hasOwn(pair, "b")).toBe(false);
      expect(Number.isInteger(generated.id)).toBe(true);
      expect(generated.nickname).not.toBe("");
    }
  });
});

/** The string at `key` of every value generated from `schema`. */
async function stringsAt(schema: JSONSchema7, key: string): Promise<string[]> {
  return (await generateSeeds(schema)).map((value) => {
    const entry = objectOf(value)[key];
    if (typeof entry !== "string") {
      throw new Error(`Expected a string at ${key}, got ${String(entry)}`);
    }
    return entry;
  });
}

describe("a property declared by several merged schemas (faker-4)", () => {
  it("honours a maxLength another allOf branch adds to a mapped property", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      allOf: [
        { properties: { email: { type: "string" } }, required: ["email"] },
        { properties: { email: { maxLength: 12 } } },
      ],
    };
    for (const email of await stringsAt(schema, "email")) {
      expect(email.length).toBeLessThanOrEqual(12);
    }
  });

  it("honours an enum an allOf branch adds to a $ref target's property", async () => {
    const schema: JSONSchema7 = {
      allOf: [
        { $ref: "#/$defs/Base" },
        { properties: { email: { enum: ["a@x.io", "b@x.io"] } } },
      ],
      $defs: {
        Base: {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"],
        },
      },
    };
    for (const email of await stringsAt(schema, "email")) {
      expect(["a@x.io", "b@x.io"]).toContain(email);
    }
  });

  it("honours a pattern a then adds to a base property", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: { zip: { type: "string" } },
      required: ["zip"],
      if: { required: ["zip"] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
      then: { properties: { zip: { pattern: "^[0-9]{5}$" } } },
    };
    for (const zip of await stringsAt(schema, "zip")) {
      expect(zip).toMatch(/^[0-9]{5}$/);
    }
  });

  it("honours a maxLength a oneOf branch adds to a base property", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
      oneOf: [{ properties: { email: { maxLength: 10 } } }],
    };
    for (const email of await stringsAt(schema, "email")) {
      expect(email.length).toBeLessThanOrEqual(10);
    }
  });

  it("drops the lorem fallback when a merged branch bounds the length", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      allOf: [
        { properties: { zzqx: { type: "string" } }, required: ["zzqx"] },
        { properties: { zzqx: { minLength: 20 } } },
      ],
    };
    for (const zzqx of await stringsAt(schema, "zzqx")) {
      expect(zzqx.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("keeps the mapping when the other declarations only annotate", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      allOf: [
        { properties: { email: { type: "string" } }, required: ["email"] },
        { properties: { email: { type: "string", description: "Contact" } } },
      ],
    };
    for (const email of await stringsAt(schema, "email")) {
      expect(email).toContain("@");
    }
  });

  it("keeps an explicit faker beside a merged constraint", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      required: ["name"],
      allOf: [
        {
          properties: {
            name: withKeys({ type: "string" }, { faker: "person.firstName" }),
          },
        },
        { properties: { name: { maxLength: 50 } } },
      ],
    };
    const names = await stringsAt(schema, "name");
    names.forEach((name, index) => {
      const faker = createFakerInstance(index + 1, DETERMINISTIC_REF_DATE);
      expect(name).toBe(faker.person.firstName());
    });
  });

  it("keeps an explicit faker beside a then that adds a constraint", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        code: withKeys({ type: "string" }, { faker: "string.alpha" }),
      },
      required: ["code"],
      if: { required: ["code"] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
      then: { properties: { code: { minLength: 1 } } },
    };
    for (const code of await stringsAt(schema, "code")) {
      expect(code).toMatch(/^[A-Za-z]$/);
    }
  });

  it("honours a maxLength a later allOf entry adds to a nested property", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      allOf: [
        {
          properties: {
            user: {
              type: "object",
              properties: { email: { type: "string" } },
              required: ["email"],
            },
          },
          required: ["user"],
        },
        { properties: { user: { properties: { email: { maxLength: 12 } } } } },
      ],
    };
    for (const value of await generateSeeds(schema)) {
      const email = objectOf(objectOf(value).user).email;
      if (typeof email !== "string") throw new Error("Expected a string");
      expect(email.length).toBeLessThanOrEqual(12);
    }
  });

  it("stops at a declaration that contains itself", () => {
    const loop: JSONSchema7 = { type: "object", properties: {} };
    Reflect.set(Object(loop.properties), "self", loop);
    const normalized = normalizeSchemaForJsf({
      allOf: [{ properties: { node: loop } }, { properties: { node: loop } }],
    });
    expect(normalized.allOf).toHaveLength(2);
  });

  it("strips the faker only from the copy JSF merges first", () => {
    const base: JSONSchema7 = {
      type: "object",
      properties: { email: { type: "string" } },
    };
    // As the enhancer writes a name mapping: marked as its own.
    Reflect.set(Object(base.properties).email, "faker", "internet.email");
    Reflect.set(Object(base.properties).email, "schmockInferredFaker", true);
    const schema: JSONSchema7 = {
      allOf: [
        { $ref: "#/$defs/Base" },
        { properties: { email: { maxLength: 9 } } },
      ],
      $defs: { Base: base },
    };
    const normalized = normalizeSchemaForJsf(schema);
    const first = objectOf(normalized.allOf?.[0]);
    expect(first.$ref).toBeUndefined();
    expect(objectOf(objectOf(first.properties).email).faker).toBeUndefined();
    // The definition itself still maps wherever it is used alone.
    const defs = objectOf(normalized.$defs);
    expect(objectOf(objectOf(objectOf(defs.Base).properties).email).faker).toBe(
      "internet.email",
    );
    expect(Reflect.get(Object(base.properties).email, "faker")).toBe(
      "internet.email",
    );
  });
});

describe("composition beside allOf (faker-3)", () => {
  const PET_BASE: JSONSchema7 = {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
  };
  const kind = (value: string): JSONSchema7 => ({
    properties: { kind: { const: value } },
    required: ["kind"],
  });

  it("moves a sibling oneOf/anyOf into the allOf JSF merges", () => {
    const normalized = normalizeSchemaForJsf({
      allOf: [PET_BASE],
      oneOf: [kind("cat"), kind("dog")],
    });
    expect(normalized.oneOf).toBeUndefined();
    expect(normalized.allOf).toHaveLength(2);
    expect(objectOf(normalized.allOf?.[1]).oneOf).toHaveLength(2);

    const withAnyOf = normalizeSchemaForJsf({
      allOf: [PET_BASE],
      anyOf: [kind("cat")],
    });
    expect(withAnyOf.anyOf).toBeUndefined();
    expect(objectOf(withAnyOf.allOf?.[1]).anyOf).toHaveLength(1);
  });

  it("combines a sibling oneOf with the one an allOf entry holds", () => {
    const normalized = normalizeSchemaForJsf({
      allOf: [{ ...PET_BASE, oneOf: [kind("cat"), kind("dog")] }],
      oneOf: [kind("old"), kind("young")],
    });
    expect(normalized.oneOf).toBeUndefined();
    expect(normalized.allOf).toHaveLength(2);
    const combined = objectOf(normalized.allOf?.[1]).oneOf;
    expect(combined).toHaveLength(4);
    expect(objectOf(combined?.[1]).allOf).toEqual([kind("cat"), kind("young")]);
  });

  it("leaves a sibling oneOf alone past the combination limit", () => {
    const many = (prefix: string) =>
      Array.from({ length: 9 }, (_, index) => kind(`${prefix}${index}`));
    const normalized = normalizeSchemaForJsf({
      allOf: [{ ...PET_BASE, oneOf: many("a") }],
      oneOf: many("b"),
    });
    expect(normalized.oneOf).toHaveLength(9);
    expect(normalized.allOf).toHaveLength(1);
  });

  it.each([
    ["inline", { ...PET_BASE, oneOf: [{ $ref: "#/$defs/Tagged" }] }],
    ["behind a $ref", { $ref: "#/$defs/TaggedPet" }],
  ] satisfies [string, JSONSchema7][])(
    "generates both oneOfs when an allOf entry holds one (%s)",
    async (_, entry) => {
      const schema: JSONSchema7 = {
        allOf: [entry],
        oneOf: [kind("cat"), kind("dog")],
        $defs: {
          Tagged: {
            properties: { tag: { const: "t" } },
            required: ["tag"],
          },
          TaggedPet: { ...PET_BASE, oneOf: [{ $ref: "#/$defs/Tagged" }] },
        },
      };
      for (const value of await generateSeeds(schema)) {
        const pet = objectOf(value);
        expect(Number.isInteger(pet.id)).toBe(true);
        expect(pet.tag).toBe("t");
        expect(["cat", "dog"]).toContain(pet.kind);
      }
    },
  );

  it("generates a sibling oneOf or anyOf branch with the allOf", async () => {
    for (const keyword of ["oneOf", "anyOf"] as const) {
      const schema: JSONSchema7 = {
        allOf: [PET_BASE],
        [keyword]: [kind("cat"), kind("dog")],
      };
      for (const value of await generateSeeds(schema)) {
        const pet = objectOf(value);
        expect(Number.isInteger(pet.id)).toBe(true);
        expect(["cat", "dog"]).toContain(pet.kind);
      }
    }
  });

  it("generates allOf + oneOf over $defs references", async () => {
    const schema: JSONSchema7 = {
      allOf: [{ $ref: "#/$defs/Base" }],
      oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }],
      $defs: { Base: PET_BASE, Cat: kind("cat"), Dog: kind("dog") },
    };
    for (const value of await generateSeeds(schema)) {
      const pet = objectOf(value);
      expect(Number.isInteger(pet.id)).toBe(true);
      expect(["cat", "dog"]).toContain(pet.kind);
    }
  });

  it("applies an if/then beside allOf", async () => {
    const schema: JSONSchema7 = {
      allOf: [PET_BASE],
      if: { required: ["id"] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
      then: {
        properties: { tag: { type: "string", const: "tagged" } },
        required: ["tag"],
      },
    };
    for (const value of await generateSeeds(schema)) {
      const pet = objectOf(value);
      expect(Number.isInteger(pet.id)).toBe(true);
      expect(pet.tag).toBe("tagged");
    }
  });

  it("keeps the allOf when only an else sits beside it", async () => {
    const schema: JSONSchema7 = {
      allOf: [PET_BASE],
      if: { required: ["id"] },
      else: { required: ["never"] },
    };
    for (const value of await generateSeeds(schema)) {
      expect(Number.isInteger(objectOf(value).id)).toBe(true);
    }
  });
});

/** ajv-formats' `byte` format: padded base64. */
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

describe("byte strings with length bounds (faker-14)", () => {
  async function bytesFrom(bounds: JSONSchema7): Promise<string[]> {
    const schema: JSONSchema7 = { type: "string", format: "byte", ...bounds };
    return (await generateSeeds(schema)).map((value) => {
      if (typeof value !== "string") throw new Error("Expected a string");
      return value;
    });
  }

  it.each([
    { maxLength: 10 },
    { minLength: 80 },
    { minLength: 5, maxLength: 30 },
    { minLength: 8, maxLength: 8 },
    { maxLength: 3 },
  ] satisfies JSONSchema7[])("is valid base64 within %o", async (bounds) => {
    for (const value of await bytesFrom(bounds)) {
      expect(value).toMatch(BASE64);
      expect(value.length).toBeGreaterThanOrEqual(bounds.minLength ?? 0);
      expect(value.length).toBeLessThanOrEqual(bounds.maxLength ?? 1e9);
    }
  });

  it("generates whole base64 blocks through a pattern in the JSF copy", () => {
    expect(
      normalizeSchemaForJsf({
        type: "string",
        format: "byte",
        minLength: 5,
        maxLength: 30,
      }),
    ).toEqual({
      type: "string",
      minLength: 5,
      maxLength: 30,
      pattern: "^(?:[A-Za-z0-9+/]{4}){2,7}$",
    });
  });

  it("leaves an unbounded, unsatisfiable or patterned byte node alone", () => {
    for (const schema of [
      { type: "string", format: "byte" },
      { type: "string", format: "byte", minLength: 5, maxLength: 7 },
      { type: "string", format: "byte", maxLength: 8, pattern: "^QQ==$" },
    ] satisfies JSONSchema7[]) {
      expect(normalizeSchemaForJsf(schema)).toEqual(schema);
    }
  });
});

describe("an explicit faker under format date (faker-16)", () => {
  const schema = withKeys(
    { type: "string", format: "date" },
    { faker: "date.past" },
  );

  /** Seeded dates generated while the process runs in time zone `zone`. */
  async function datesIn(zone: string): Promise<unknown[]> {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      return await generateSeeds(schema, 50);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  it("generates the same calendar date in every time zone", async () => {
    const utc = await datesIn("UTC");
    expect(await datesIn("Pacific/Kiritimati")).toEqual(utc);
    expect(await datesIn("America/Los_Angeles")).toEqual(utc);
  });

  it("generates the UTC calendar date of the faker value", async () => {
    const dates = await datesIn("Pacific/Kiritimati");
    dates.forEach((date, index) => {
      const faker = createFakerInstance(index + 1, DETERMINISTIC_REF_DATE);
      expect(date).toBe(faker.date.past().toISOString().slice(0, 10));
    });
  });

  it("keeps a non-date faker value as it is", async () => {
    const word = withKeys(
      { type: "string", format: "date" },
      { faker: "lorem.word" },
    );
    const value = await generateFromSchema({ schema: word, seed: 3 });
    const faker = createFakerInstance(3, DETERMINISTIC_REF_DATE);
    expect(value).toBe(faker.lorem.word());
  });

  it("falls back to a valid date when the faker method throws", async () => {
    // `date.between` throws without its `from`/`to` arguments.
    const throwing = withKeys(
      { type: "string", format: "date" },
      { faker: "date.between" },
    );
    for (const value of await generateSeeds(throwing)) {
      if (typeof value !== "string") throw new Error("Expected a string");
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10)).toBe(
        value,
      );
    }
  });
});

describe("a decimal multipleOf (faker-7)", () => {
  async function numbersFrom(schema: JSONSchema7, seeds = 300) {
    const values = await generateSeeds(schema, seeds);
    return values.map((value) => {
      if (typeof value !== "number") throw new Error("Expected a number");
      return value;
    });
  }

  /** Digits after the decimal point in the shortest form of `value`. */
  function places(value: number): number {
    return String(value).split(".")[1]?.length ?? 0;
  }

  it.each([
    [0.1, 0, 10],
    [0.01, 0, 1000],
    [0.05, -50, 50],
  ])(
    "snaps multipleOf %d inside [%d, %d] to clean, exact multiples",
    async (step, minimum, maximum) => {
      for (const value of await numbersFrom({
        type: "number",
        minimum,
        maximum,
        multipleOf: step,
      })) {
        expect(places(value)).toBeLessThanOrEqual(places(step));
        // What AJV computes for multipleOf without multipleOfPrecision.
        expect(Number.isInteger(value / step)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(minimum);
        expect(value).toBeLessThanOrEqual(maximum);
      }
    },
  );

  it("snaps an unbounded decimal step too", async () => {
    for (const value of await numbersFrom({
      type: "number",
      multipleOf: 0.01,
    })) {
      expect(places(value)).toBeLessThanOrEqual(2);
    }
  });

  it("leaves a binary-exact step's values as they were", async () => {
    for (const value of await numbersFrom({
      type: "number",
      minimum: 0,
      maximum: 10,
      multipleOf: 0.25,
    })) {
      expect(Number.isInteger(value * 4)).toBe(true);
    }
  });

  it("generates integers for an integer schema with a fractional step", async () => {
    for (const schema of [
      { type: "integer", minimum: 0, maximum: 10, multipleOf: 0.5 },
      { type: "integer", minimum: 0, maximum: 30, multipleOf: 1.5 },
      { allOf: [{ type: "integer", maximum: 10 }, { multipleOf: 0.5 }] },
    ] satisfies JSONSchema7[]) {
      for (const value of await numbersFrom(schema, 40)) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
    for (const value of await numbersFrom(
      { type: "integer", minimum: 0, maximum: 30, multipleOf: 1.5 },
      40,
    )) {
      expect(value % 3).toBe(0);
    }
  });

  it("rewrites an integer schema's fractional step to its smallest integer multiple", () => {
    expect(
      normalizeSchemaForJsf({ type: "integer", multipleOf: 0.5 }).multipleOf,
    ).toBe(1);
    expect(
      normalizeSchemaForJsf({ type: "integer", multipleOf: 1.5 }).multipleOf,
    ).toBe(3);
    expect(
      normalizeSchemaForJsf({ type: "number", multipleOf: 0.5 }).multipleOf,
    ).toBe(0.5);
  });
});
