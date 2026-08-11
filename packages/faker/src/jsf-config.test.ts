import type { JSONSchema7 } from "json-schema";
import { registerFormat } from "json-schema-faker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_NESTING_DEPTH } from "./constants.js";
import { generateFromSchema } from "./index.js";
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
