import fc from "fast-check";
import type { JSONSchema7 } from "json-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_FIELD_MAPPINGS } from "./field-mappings";
import { findBestMapping, tokenizeFieldName } from "./field-name-matcher";
import * as fakerIndex from "./index";
import { fakerPlugin, generateFromSchema } from "./index";
import { applyOverrides } from "./overrides";

/**
 * Regression tests for the faker-mapping review findings (2026-09-25).
 *
 * The rule under test: an explicit schema keyword (`default`, `format`, `enum`,
 * `const`, `pattern`, `schmockTrueProbability`, `schmockNullable`) always wins
 * over a field-name heuristic.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value;
}

/** Generate `count` objects from `properties` in one seeded call. */
async function sampleObjects(
  properties: Record<string, JSONSchema7>,
  count: number,
  seed = 42,
): Promise<Record<string, unknown>[]> {
  const schema: JSONSchema7 = {
    type: "array",
    items: {
      type: "object",
      properties,
      required: Object.keys(properties),
    },
  };
  const generated = await generateFromSchema({ schema, count, seed });
  return asArray(generated).map(asRecord);
}

describe("#18 type unions keep every type and constraint guard", () => {
  it("does not map an integer-or-null `version` to system.semver", () => {
    const match = findBestMapping("version", {
      type: ["integer", "null"],
    } as JSONSchema7);
    expect(match?.mapping.fakerMethod).not.toBe("system.semver");
  });

  it("skips string mappings when a string-or-null field has maxLength", () => {
    expect(
      findBestMapping("description", {
        type: ["string", "null"],
        maxLength: 10,
      } as JSONSchema7),
    ).toBeUndefined();
    expect(
      findBestMapping("name", {
        type: ["string", "null"],
        minLength: 50,
      } as JSONSchema7),
    ).toBeUndefined();
  });

  it("skips numeric mappings when a number-or-null field is constrained", () => {
    expect(
      findBestMapping("price", {
        type: ["number", "null"],
        minimum: 900,
      } as JSONSchema7),
    ).toBeUndefined();
    expect(
      findBestMapping("total", {
        type: ["integer", "null"],
        multipleOf: 1000,
      } as JSONSchema7),
    ).toBeUndefined();
  });

  it("treats a genuine multi-type union as unmappable", () => {
    expect(
      findBestMapping("email", {
        type: ["string", "integer"],
      } as JSONSchema7),
    ).toBeUndefined();
  });

  it("generates integers (never NaN-as-null) for an integer-or-null version", async () => {
    const items = await sampleObjects(
      { version: { type: ["integer", "null"] } as JSONSchema7 },
      100,
    );
    const nonNull = items.map((item) => item.version).filter((v) => v !== null);
    expect(nonNull.length).toBeGreaterThan(80);
    for (const value of nonNull) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("honours maxLength and minimum on native nullable fields", async () => {
    const items = await sampleObjects(
      {
        description: { type: ["string", "null"], maxLength: 10 } as JSONSchema7,
        price: { type: ["number", "null"], minimum: 900 } as JSONSchema7,
      },
      100,
    );
    for (const item of items) {
      if (typeof item.description === "string") {
        expect(item.description.length).toBeLessThanOrEqual(10);
      }
      if (typeof item.price === "number") {
        expect(item.price).toBeGreaterThanOrEqual(900);
      }
    }
  });
});

describe("#70 native nullable unions roll null at ~5%", () => {
  it('rolls `type: [T, "null"]` at the documented rate, not 50/50', async () => {
    const items = await sampleObjects(
      { nick: { type: ["string", "null"] } as JSONSchema7 },
      200,
    );
    const nulls = items.filter((item) => item.nick === null).length;
    expect(nulls).toBeGreaterThan(0);
    expect(nulls).toBeLessThan(40);
  });

  it("rolls a two-branch oneOf with a bare null branch at ~5% (either order)", async () => {
    const target: JSONSchema7 = {
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
    };
    for (const branches of [
      [{ type: "null" }, target],
      [target, { type: "null" }],
    ] as JSONSchema7[][]) {
      const items = await sampleObjects(
        {
          viaOneOf: { oneOf: branches },
          viaAnyOf: { anyOf: branches },
        },
        200,
      );
      for (const key of ["viaOneOf", "viaAnyOf"]) {
        const nulls = items.filter((item) => item[key] === null).length;
        expect(nulls).toBeLessThan(40);
        for (const item of items) {
          if (item[key] !== null) {
            expect(typeof asRecord(item[key]).label).toBe("string");
          }
        }
      }
    }
  });

  it("leaves an explicit schmockNullable: false union to json-schema-faker", async () => {
    const items = await sampleObjects(
      {
        nick: {
          type: ["string", "null"],
          schmockNullable: false,
        } as JSONSchema7,
      },
      200,
    );
    const nulls = items.filter((item) => item.nick === null).length;
    expect(nulls).toBeGreaterThan(40);
  });
});

describe("#20 an explicit default beats every heuristic", () => {
  it("keeps defaults on name-mapped properties", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const generated = asRecord(
        await generateFromSchema({
          seed,
          schema: {
            type: "object",
            properties: {
              status: { type: "string", default: "active" },
              active: { type: "boolean", default: false },
              count: { type: "integer", default: 3 },
              version: { type: "string", default: "v1" },
              nickname: { type: "string", default: "Ace" },
              id: { type: "string", format: "uuid", default: "fixed-id" },
            },
            required: [
              "status",
              "active",
              "count",
              "version",
              "nickname",
              "id",
            ],
          },
        }),
      );
      expect(generated).toEqual({
        status: "active",
        active: false,
        count: 3,
        version: "v1",
        nickname: "Ace",
        id: "fixed-id",
      });
    }
  });

  it("keeps a default on a root string and on array items", async () => {
    await expect(
      generateFromSchema({ schema: { type: "string", default: "root" } }),
    ).resolves.toBe("root");
    await expect(
      generateFromSchema({
        schema: { type: "array", items: { type: "string", default: "item" } },
        count: 3,
      }),
    ).resolves.toEqual(["item", "item", "item"]);
  });

  it("findBestMapping returns nothing for a schema with default or const", () => {
    expect(
      findBestMapping("email", { type: "string", default: "a@b.c" }),
    ).toBeUndefined();
    expect(
      findBestMapping("email", { type: "string", const: "a@b.c" }),
    ).toBeUndefined();
  });
});

describe("#21 date mappings emit time-zone independent ISO strings", () => {
  const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
  const dateFields: Record<string, JSONSchema7> = {
    timestamp: { type: "string" },
    birthDate: { type: "string" },
    birthday: { type: "string" },
    startDate: { type: "string" },
    endDate: { type: "string" },
    dueDate: { type: "string" },
    deadline: { type: "string" },
  };
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  async function generateUnder(timeZone: string, expectedOffset: number) {
    process.env.TZ = timeZone;
    // Self-check: the switch must actually reach Date, or the test is vacuous.
    expect(new Date(0).getTimezoneOffset()).toBe(expectedOffset);
    return sampleObjects(dateFields, 5, 7);
  }

  it("every date.* mapping declares format date-time", () => {
    const dateMappings = ALL_FIELD_MAPPINGS.filter((mapping) =>
      mapping.fakerMethod.startsWith("date."),
    );
    expect(dateMappings.length).toBeGreaterThan(0);
    for (const mapping of dateMappings) {
      expect(mapping.format, mapping.keywords.join(",")).toBe("date-time");
    }
  });

  it("stays ISO when the field declares a format nothing can generate", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        created_at: { type: "string", format: "datetime" },
        timestamp: { type: "string", format: "unix-ish" },
      },
      required: ["created_at", "timestamp"],
    };
    process.env.TZ = "Asia/Tokyo";
    expect(new Date(0).getTimezoneOffset()).toBe(-540);
    const tokyo = asRecord(await generateFromSchema({ schema, seed: 3 }));
    process.env.TZ = "UTC";
    expect(new Date(0).getTimezoneOffset()).toBe(0);
    const utc = asRecord(await generateFromSchema({ schema, seed: 3 }));
    expect(tokyo).toEqual(utc);
    expect(utc.created_at).toMatch(ISO_DATE_TIME);
    expect(utc.timestamp).toMatch(ISO_DATE_TIME);
  });

  it("produces identical ISO output under UTC and Asia/Tokyo", async () => {
    const tokyo = await generateUnder("Asia/Tokyo", -540);
    const utc = await generateUnder("UTC", 0);
    expect(tokyo).toEqual(utc);
    for (const item of utc) {
      for (const field of Object.keys(dateFields)) {
        expect(item[field], field).toMatch(ISO_DATE_TIME);
      }
    }
  });
});

describe("#22 an explicit schmockTrueProbability wins over the name heuristic", () => {
  it("keeps 0 on `active` and 1 on `deleted`", async () => {
    const items = await sampleObjects(
      {
        active: { type: "boolean", schmockTrueProbability: 0 } as JSONSchema7,
        deleted: { type: "boolean", schmockTrueProbability: 1 } as JSONSchema7,
      },
      200,
    );
    for (const item of items) {
      expect(item.active).toBe(false);
      expect(item.deleted).toBe(true);
    }
  });
});

describe("#23 weighting and nullable rolls reach every generated node", () => {
  const base: JSONSchema7 = {
    type: "object",
    properties: {
      isDeleted: { type: "boolean" },
      nick: { type: "string", schmockNullable: true } as JSONSchema7,
    },
    required: ["isDeleted", "nick"],
  };

  function rates(values: unknown[]) {
    const records = values.map(asRecord);
    return {
      trueRate:
        records.filter((record) => record.isDeleted === true).length /
        records.length,
      nulls: records.filter((record) => record.nick === null).length,
    };
  }

  it("applies isDeleted weighting and nullable rolls inside allOf", async () => {
    const generated = await generateFromSchema({
      seed: 3,
      count: 400,
      schema: { type: "array", items: { allOf: [base, { type: "object" }] } },
    });
    const { trueRate, nulls } = rates(asArray(generated));
    expect(trueRate).toBeLessThan(0.2);
    expect(nulls).toBeGreaterThan(0);
    expect(nulls).toBeLessThan(60);
  });

  it("applies them through a $ref", async () => {
    const generated = await generateFromSchema({
      seed: 3,
      count: 400,
      schema: {
        definitions: { Base: base },
        type: "array",
        items: { $ref: "#/definitions/Base" },
      },
    });
    const { trueRate, nulls } = rates(asArray(generated));
    expect(trueRate).toBeLessThan(0.2);
    expect(nulls).toBeGreaterThan(0);
  });

  it("applies them to additionalProperties values", async () => {
    const trueCounts: number[] = [];
    let nullCount = 0;
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const generated = asRecord(
        await generateFromSchema({
          seed,
          schema: {
            type: "object",
            properties: {
              isDeleted: { type: "boolean" },
              byName: {
                type: "object",
                additionalProperties: base,
                minProperties: 5,
              },
            },
            required: ["isDeleted", "byName"],
          },
        }),
      );
      for (const value of Object.values(asRecord(generated.byName))) {
        const record = asRecord(value);
        total++;
        if (record.isDeleted === true) trueCounts.push(1);
        if (record.nick === null) nullCount++;
      }
    }
    expect(total).toBeGreaterThan(100);
    expect(trueCounts.length / total).toBeLessThan(0.2);
    expect(nullCount).toBeGreaterThan(0);
  });

  it("applies them inside the single anyOf branch the value matches", async () => {
    const generated = await generateFromSchema({
      seed: 3,
      count: 400,
      schema: {
        type: "array",
        items: { anyOf: [base, { type: "string" }] },
      },
    });
    const objects = asArray(generated).filter(isRecord);
    expect(objects.length).toBeGreaterThan(100);
    const { trueRate, nulls } = rates(objects);
    expect(trueRate).toBeLessThan(0.2);
    expect(nulls).toBeGreaterThan(0);
  });

  it("never nulls a field that another allOf branch declares non-nullable", async () => {
    const generated = await generateFromSchema({
      seed: 5,
      count: 400,
      schema: {
        type: "array",
        items: {
          allOf: [
            base,
            {
              type: "object",
              properties: { nick: { type: "string" } },
            },
          ],
        },
      },
    });
    for (const item of asArray(generated)) {
      expect(asRecord(item).nick).not.toBeNull();
    }
  });
});

describe("#73 dotted override paths through arrays", () => {
  const data = {
    addresses: [
      { city: "Lyon", zip: "69000" },
      { city: "Nice", zip: "06000" },
    ],
    tags: ["a", "b"],
    name: "x",
  };

  it("descends into an array by canonical index", () => {
    const result = asRecord(
      applyOverrides(data, { "addresses.0.city": "Paris" }),
    );
    expect(result.addresses).toEqual([
      { city: "Paris", zip: "69000" },
      { city: "Nice", zip: "06000" },
    ]);
    const flat = asRecord(applyOverrides(data, { tags: { 1: "z" } }));
    expect(flat.tags).toEqual(["a", "z"]);
    const nestedFlat = asRecord(
      applyOverrides(data, { addresses: { 1: { city: "Nantes" } } }),
    );
    expect(nestedFlat.addresses).toEqual([
      { city: "Lyon", zip: "69000" },
      { city: "Nantes", zip: "06000" },
    ]);
  });

  it("never turns an array or a primitive into an object", () => {
    for (const overrides of [
      { "addresses.city": "Paris" },
      { "addresses.5.city": "Paris" },
      { "addresses.01.city": "Paris" },
      { "tags.x": "y" },
      { "name.first": "y" },
      { tags: { first: "y" } },
      { name: { first: "y" } },
    ]) {
      const result = asRecord(applyOverrides(data, overrides));
      expect(result, JSON.stringify(overrides)).toEqual(data);
    }
  });

  it("still creates missing intermediate objects", () => {
    const result = asRecord(applyOverrides(data, { "meta.page.size": 10 }));
    expect(result.meta).toEqual({ page: { size: 10 } });
  });
});

describe("#74 substring matches stay inside token boundaries", () => {
  it.each([
    ["latency", "number", "location.latitude"],
    ["latencyMs", "number", "location.latitude"],
    ["population", "number", "location.latitude"],
    ["inflationRate", "number", "location.latitude"],
    ["collateralValue", "number", "location.latitude"],
    ["longestStreak", "number", "location.longitude"],
    ["phoneType", "string", "phone.number"],
    ["addressType", "string", "location.streetAddress"],
    ["emailStatus", "string", "internet.email"],
    ["jobStatus", "string", "person.jobTitle"],
    ["nameFormat", "string", "person.fullName"],
    ["namespace", "string", "person.fullName"],
    ["cityCode", "string", "location.city"],
  ])("%s (%s) does not map to %s", (name, type, method) => {
    const match = findBestMapping(name, { type } as JSONSchema7);
    expect(match?.mapping.fakerMethod).not.toBe(method);
  });

  it("still maps real matches", () => {
    for (const [name, type, method] of [
      ["latitude", "number", "location.latitude"],
      ["lat", "number", "location.latitude"],
      ["userLat", "number", "location.latitude"],
      ["myemailfield", "string", "internet.email"],
      ["userEmail", "string", "internet.email"],
      ["phoneNumber", "string", "phone.number"],
      ["homeCity", "string", "location.city"],
    ] as const) {
      expect(findBestMapping(name, { type })?.mapping.fakerMethod, name).toBe(
        method,
      );
    }
  });
});

describe("#75 primitive array items inherit the singular property name", () => {
  it("maps emails/phoneNumbers/userIds items through the singular name", async () => {
    const generated = asRecord(
      await generateFromSchema({
        seed: 1,
        schema: {
          type: "object",
          properties: {
            emails: { type: "array", items: { type: "string" }, minItems: 3 },
            userIds: { type: "array", items: { type: "string" }, minItems: 3 },
            cities: { type: "array", items: { type: "string" }, minItems: 3 },
          },
          required: ["emails", "userIds", "cities"],
        },
      }),
    );
    for (const email of asArray(generated.emails)) {
      expect(email).toMatch(/@/);
    }
    for (const id of asArray(generated.userIds)) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(asArray(generated.cities).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps explicit item keywords over the inherited name", async () => {
    const generated = asRecord(
      await generateFromSchema({
        seed: 1,
        schema: {
          type: "object",
          properties: {
            emails: {
              type: "array",
              items: { type: "string", enum: ["fixed"] },
              minItems: 2,
            },
          },
          required: ["emails"],
        },
      }),
    );
    for (const email of asArray(generated.emails)) {
      expect(email).toBe("fixed");
    }
  });
});

describe("#76 tokenizeFieldName is linear", () => {
  /** The previous regex implementation, kept as the behavioural oracle. */
  function legacyTokenize(name: string): string[] {
    const tokens: string[] = [];
    for (const part of name.split(/[_-]/)) {
      if (!part) continue;
      const camelTokens = part
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .split("_");
      for (const t of camelTokens) {
        if (t) tokens.push(t.toLowerCase());
      }
    }
    return tokens;
  }

  it("matches the legacy tokenizer on arbitrary names", () => {
    const alphabet = fc.constantFrom(..."aAbBzZ09_-éÉ .".split(""), "ǅ", "İ");
    fc.assert(
      fc.property(fc.array(alphabet, { maxLength: 24 }), (chars) => {
        const name = chars.join("");
        expect(tokenizeFieldName(name)).toEqual(legacyTokenize(name));
      }),
      { numRuns: 3000 },
    );
    for (const name of [
      "HTMLParser",
      "userFirstName",
      "created_at",
      "is_active",
      "ABcDEf",
      "v2Name",
      "ID2Value",
      "already-kebab-Case",
    ]) {
      expect(tokenizeFieldName(name)).toEqual(legacyTokenize(name));
    }
  });

  it("tokenizes a 100k-character uppercase run quickly", () => {
    // No lowercase letter follows the run, so the old `([A-Z]+)([A-Z][a-z])`
    // regex backtracked across the whole run from every start position.
    const name = "A".repeat(100_000);
    const started = performance.now();
    const tokens = tokenizeFieldName(name);
    const elapsed = performance.now() - started;
    expect(tokens).toEqual([name.toLowerCase()]);
    // The quadratic regex needed ~4s here; linear work is milliseconds.
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("#84 the plugin validates its immutable schema once", () => {
  afterEach(() => {
    vi.doUnmock("./validation.js");
    vi.resetModules();
  });

  it("does not re-validate on every request", async () => {
    vi.resetModules();
    const validateSpy = vi.fn();
    vi.doMock("./validation.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("./validation")>();
      validateSpy.mockImplementation(original.validateSchema);
      return { ...original, validateSchema: validateSpy };
    });
    const fresh = await import("./index");
    const plugin = fresh.fakerPlugin({
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    });
    const context = {
      path: "/x",
      method: "GET",
      params: {},
      query: {},
      headers: {},
      state: new Map(),
      routeState: {},
      route: {},
    } as unknown as Parameters<typeof plugin.process>[0];
    for (let i = 0; i < 5; i++) {
      const { response } = await plugin.process(context);
      expect(typeof asRecord(response).name).toBe("string");
    }
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  it("the public generateFromSchema still validates every call", async () => {
    const schema: JSONSchema7 = { type: "string" };
    await generateFromSchema({ schema });
    schema.maxLength = 10_000_000;
    await expect(generateFromSchema({ schema })).rejects.toThrow();
  });

  it("a plugin keeps generating from its construction-time snapshot", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: { name: { type: "string", const: "before" } },
      required: ["name"],
    };
    const plugin = fakerPlugin({ schema });
    Reflect.set(asRecord(schema.properties).name as object, "const", "after");
    const context = {
      path: "/x",
      method: "GET",
      params: {},
      query: {},
      headers: {},
      state: new Map(),
      routeState: {},
      route: {},
    } as unknown as Parameters<typeof plugin.process>[0];
    const { response } = await plugin.process(context);
    expect(response).toEqual({ name: "before" });
  });
});

describe("#85 every faker resource limit is exported", () => {
  it("exports the array, nesting, schema-node and generated-node ceilings", () => {
    expect(Reflect.get(fakerIndex, "MAX_ARRAY_SIZE")).toBe(10_000);
    expect(Reflect.get(fakerIndex, "MAX_NESTING_DEPTH")).toBe(15);
    expect(Reflect.get(fakerIndex, "MAX_SCHEMA_NODES")).toBe(50_000);
    expect(Reflect.get(fakerIndex, "MAX_GENERATED_NODES")).toBe(1_000_000);
    expect(fakerIndex.MAX_OBJECT_PROPERTIES).toBe(10_000);
    expect(fakerIndex.MAX_STRING_LENGTH).toBe(65_536);
  });
});
