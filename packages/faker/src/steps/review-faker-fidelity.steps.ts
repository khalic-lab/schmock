import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import type { JSONSchema7 } from "json-schema";
import { expect } from "vitest";
import { generateFromSchema } from "../index";
import { createFakerInstance, DETERMINISTIC_REF_DATE } from "../jsf-config";

const feature = await loadFeature(
  "../../features/review-faker-fidelity.feature",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected an object, got ${value}`);
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected an array, got ${value}`);
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected a string: ${value}`);
  return value;
}

function numeric(value: unknown): number {
  if (typeof value !== "number") throw new Error(`expected a number: ${value}`);
  return value;
}

/** A schema, and what every value generated from it must satisfy. */
interface FidelityCase {
  schema: JSONSchema7;
  /** The `count` option to generate with, if any. */
  count?: number;
  /** Checks one value; `seed` is the seed it was generated with. */
  fits: (value: unknown, seed: number) => void;
}

const STATUS: JSONSchema7 = {
  type: "string",
  oneOf: [{ const: "open" }, { const: "closed" }],
};

function expectStatus(value: unknown): void {
  expect(["open", "closed"]).toContain(value);
}

const PET_BASE: JSONSchema7 = {
  type: "object",
  properties: { id: { type: "integer" } },
  required: ["id"],
};

function petKind(kind: string): JSONSchema7 {
  return { properties: { kind: { const: kind } }, required: ["kind"] };
}

/** ajv-formats' `byte` format: padded base64. */
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** ajv-formats' `duration` format. */
const ISO_DURATION =
  /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/;

function expectBase64Within(value: unknown, min: number, max: number): void {
  const encoded = text(value);
  expect(encoded).toMatch(BASE64);
  expect(encoded.length).toBeGreaterThanOrEqual(min);
  expect(encoded.length).toBeLessThanOrEqual(max);
}

const INTEGER_LIST: JSONSchema7 = {
  type: "array",
  items: { type: "integer" },
};

function expectPet(value: unknown): void {
  const pet = record(value);
  expect(Number.isInteger(pet.id)).toBe(true);
  expect(["cat", "dog"]).toContain(pet.kind);
}

/** No generated object holds a key copied from the schema's own keywords. */
function expectNoSchemaKeys(value: unknown): void {
  const generated = record(value);
  for (const key of ["definitions", "dependencies", "example"]) {
    expect(Object.hasOwn(generated, key)).toBe(false);
  }
}

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

const CASES: Record<string, FidelityCase> = {
  "root-string-one-of-const": {
    schema: STATUS,
    fits: expectStatus,
  },
  "defs-status-through-ref": {
    schema: {
      type: "object",
      properties: { status: { $ref: "#/$defs/Status" } },
      required: ["status"],
      $defs: { Status: STATUS },
    },
    fits: (value) => expectStatus(record(value).status),
  },
  "array-items-any-of-const": {
    schema: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "string", anyOf: [{ const: "a" }, { const: "b" }] },
    },
    fits: (value) => {
      for (const item of list(value)) expect(["a", "b"]).toContain(item);
    },
  },
  "additional-properties-all-of": {
    schema: {
      type: "object",
      minProperties: 1,
      additionalProperties: { type: "string", allOf: [{ minLength: 15 }] },
    },
    fits: (value) => {
      for (const entry of Object.values(record(value))) {
        expect(text(entry).length).toBeGreaterThanOrEqual(15);
      }
    },
  },
  "property-if-then-pattern": {
    schema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          if: { minLength: 1 },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
          then: { pattern: "^[A-Z]{3}$" },
        },
      },
      required: ["code"],
    },
    fits: (value) => {
      const code = text(record(value).code);
      if (code.length >= 1) expect(code).toMatch(/^[A-Z]{3}$/);
    },
  },
  "boolean-not-const-true": {
    schema: {
      type: "object",
      properties: { active: { type: "boolean", not: { const: true } } },
      required: ["active"],
    },
    fits: (value) => expect(record(value).active).toBe(false),
  },
  "untyped-name-max-length": {
    schema: {
      type: "object",
      properties: { name: { maxLength: 4 } },
      required: ["name"],
    },
    fits: (value) => {
      expect(text(record(value).name).length).toBeLessThanOrEqual(4);
    },
  },
  "untyped-address-object": {
    schema: {
      type: "object",
      properties: {
        address: {
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      required: ["address"],
    },
    fits: (value) => {
      expect(typeof record(record(value).address).city).toBe("string");
    },
  },
  "untyped-emails-array": {
    schema: {
      type: "object",
      properties: { emails: { items: { format: "email" }, minItems: 1 } },
      required: ["emails"],
    },
    fits: (value) => {
      expect(list(record(value).emails).length).toBeGreaterThanOrEqual(1);
    },
  },
  "untyped-price-bounds": {
    schema: {
      type: "object",
      properties: { price: { minimum: 1, maximum: 5 } },
      required: ["price"],
    },
    fits: (value) => {
      const price = record(value).price;
      expect(typeof price).toBe("number");
      expect(price).toBeGreaterThanOrEqual(1);
      expect(price).toBeLessThanOrEqual(5);
    },
  },
  "map-with-definitions": {
    schema: {
      type: "object",
      additionalProperties: { $ref: "#/definitions/Item" },
      definitions: { Item: { type: "integer" } },
    },
    fits: (value) => {
      expectNoSchemaKeys(value);
      for (const entry of Object.values(record(value))) {
        expect(Number.isInteger(entry)).toBe(true);
      }
    },
  },
  "closed-object-with-example": {
    schema: withKeys(
      { type: "object", additionalProperties: false },
      { example: {} },
    ),
    fits: (value) => expect(value).toEqual({}),
  },
  "map-with-dependencies": {
    schema: {
      type: "object",
      additionalProperties: { type: "string" },
      dependencies: { a: ["b"] },
    },
    fits: expectNoSchemaKeys,
  },
  "multiple-of-lone-maximum": {
    schema: { type: "integer", multipleOf: 5, maximum: -5000 },
    fits: (value) => {
      expect(numeric(value)).toBeLessThanOrEqual(-5000);
      expect(Math.abs(numeric(value) % 5)).toBe(0);
    },
  },
  "multiple-of-wide-step-lone-maximum": {
    schema: { type: "integer", multipleOf: 4000, maximum: -5000 },
    fits: (value) => {
      expect(numeric(value)).toBeLessThanOrEqual(-5000);
      expect(Math.abs(numeric(value) % 4000)).toBe(0);
    },
  },
  "inclusive-minimum-tighter-than-exclusive": {
    schema: { type: "integer", minimum: 10, exclusiveMinimum: 0, maximum: 20 },
    fits: (value) => {
      expect(numeric(value)).toBeGreaterThanOrEqual(10);
      expect(numeric(value)).toBeLessThanOrEqual(20);
    },
  },
  "not-required-pair": {
    schema: {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      not: { required: ["a", "b"] },
    },
    fits: (value) => {
      const pair = record(value);
      expect(Object.hasOwn(pair, "a") && Object.hasOwn(pair, "b")).toBe(false);
    },
  },
  "not-type-in-union": {
    schema: { type: ["string", "integer"], not: { type: "string" } },
    fits: (value) => expect(Number.isInteger(value)).toBe(true),
  },
  "not-const-empty-string": {
    schema: {
      type: "object",
      properties: { nickname: { type: "string", not: { const: "" } } },
      required: ["nickname"],
    },
    fits: (value) => expect(text(record(value).nickname)).not.toBe(""),
  },
  "all-of-max-length-on-mapped-email": {
    schema: {
      type: "object",
      allOf: [
        { properties: { email: { type: "string" } }, required: ["email"] },
        { properties: { email: { maxLength: 12 } } },
      ],
    },
    fits: (value) => {
      expect(text(record(value).email).length).toBeLessThanOrEqual(12);
    },
  },
  "all-of-max-length-on-nested-email": {
    schema: {
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
    },
    fits: (value) => {
      const email = text(record(record(value).user).email);
      expect(email.length).toBeLessThanOrEqual(12);
    },
  },
  "all-of-enum-on-ref-target-email": {
    schema: {
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
    },
    fits: (value) =>
      expect(["a@x.io", "b@x.io"]).toContain(record(value).email),
  },
  "then-pattern-on-zip": {
    schema: {
      type: "object",
      properties: { zip: { type: "string" } },
      required: ["zip"],
      if: { required: ["zip"] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
      then: { properties: { zip: { pattern: "^[0-9]{5}$" } } },
    },
    fits: (value) => expect(text(record(value).zip)).toMatch(/^[0-9]{5}$/),
  },
  "all-of-min-length-on-unmapped-string": {
    schema: {
      type: "object",
      allOf: [
        { properties: { zzqx: { type: "string" } }, required: ["zzqx"] },
        { properties: { zzqx: { minLength: 20 } } },
      ],
    },
    fits: (value) => {
      expect(text(record(value).zzqx).length).toBeGreaterThanOrEqual(20);
    },
  },
  "all-of-with-sibling-one-of": {
    schema: { allOf: [PET_BASE], oneOf: [petKind("cat"), petKind("dog")] },
    fits: expectPet,
  },
  "all-of-with-sibling-any-of": {
    schema: { allOf: [PET_BASE], anyOf: [petKind("cat"), petKind("dog")] },
    fits: expectPet,
  },
  "all-of-entry-one-of-with-sibling-one-of": {
    schema: {
      allOf: [
        {
          ...PET_BASE,
          oneOf: [{ properties: { tag: { const: "t" } }, required: ["tag"] }],
        },
      ],
      oneOf: [petKind("cat"), petKind("dog")],
    },
    fits: (value) => {
      expectPet(value);
      expect(record(value).tag).toBe("t");
    },
  },
  "defs-base-with-sibling-one-of-refs": {
    schema: {
      allOf: [{ $ref: "#/$defs/Base" }],
      oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }],
      $defs: { Base: PET_BASE, Cat: petKind("cat"), Dog: petKind("dog") },
    },
    fits: expectPet,
  },
  "all-of-with-sibling-if-then": {
    schema: {
      allOf: [PET_BASE],
      if: { required: ["id"] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
      then: {
        properties: { tag: { type: "string", const: "tagged" } },
        required: ["tag"],
      },
    },
    fits: (value) => {
      expect(Number.isInteger(record(value).id)).toBe(true);
      expect(record(value).tag).toBe("tagged");
    },
  },
  "byte-max-length-10": {
    schema: { type: "string", format: "byte", maxLength: 10 },
    fits: (value) => expectBase64Within(value, 0, 10),
  },
  "byte-min-length-80": {
    schema: { type: "string", format: "byte", minLength: 80 },
    fits: (value) => expectBase64Within(value, 80, Number.POSITIVE_INFINITY),
  },
  "byte-length-5-to-30": {
    schema: { type: "string", format: "byte", minLength: 5, maxLength: 30 },
    fits: (value) => expectBase64Within(value, 5, 30),
  },
  "duration-property": {
    schema: {
      type: "object",
      properties: { ttl: { type: "string", format: "duration" } },
      required: ["ttl"],
    },
    fits: (value) => expect(text(record(value).ttl)).toMatch(ISO_DURATION),
  },
  "explicit-faker-date": {
    schema: withKeys(
      { type: "string", format: "date" },
      { faker: "date.past" },
    ),
    fits: (value, seed) => {
      // Generation is seeded, so faker's first call returns the same instant.
      const faker = createFakerInstance(seed, DETERMINISTIC_REF_DATE);
      expect(value).toBe(faker.date.past().toISOString().slice(0, 10));
    },
  },
  "decimal-step-tenths": {
    schema: { type: "number", minimum: 0, maximum: 10, multipleOf: 0.1 },
    fits: (value) => {
      const decimals = String(numeric(value)).split(".")[1] ?? "";
      expect(decimals.length).toBeLessThanOrEqual(1);
      expect(Number.isInteger(numeric(value) / 0.1)).toBe(true);
    },
  },
  "decimal-step-cents": {
    schema: { type: "number", minimum: 0, maximum: 1000, multipleOf: 0.01 },
    fits: (value) => {
      const decimals = String(numeric(value)).split(".")[1] ?? "";
      expect(decimals.length).toBeLessThanOrEqual(2);
      expect(Number.isInteger(numeric(value) / 0.01)).toBe(true);
    },
  },
  "integer-with-half-step": {
    schema: { type: "integer", minimum: 0, maximum: 10, multipleOf: 0.5 },
    fits: (value) => expect(Number.isInteger(value)).toBe(true),
  },
  "unique-nullable-integers": {
    schema: {
      type: "array",
      items: { type: ["integer", "null"] },
      uniqueItems: true,
      minItems: 20,
      maxItems: 20,
    },
    fits: (value) => {
      const nulls = list(value).filter((item) => item === null);
      expect(nulls.length).toBeLessThanOrEqual(1);
    },
  },
  "unique-nullable-any-of": {
    schema: {
      type: "array",
      items: { anyOf: [{ type: "integer" }, { type: "null" }] },
      uniqueItems: true,
      minItems: 20,
      maxItems: 20,
    },
    fits: (value) => {
      const nulls = list(value).filter((item) => item === null);
      expect(nulls.length).toBeLessThanOrEqual(1);
    },
  },
  "type-union-with-all-of-ref": {
    schema: {
      type: "object",
      properties: {
        foo: withKeys(
          { type: ["object", "null"], allOf: [{ $ref: "#/$defs/Foo" }] },
          { schmockNullable: true },
        ),
      },
      required: ["foo"],
      $defs: {
        Foo: { type: "object", properties: { a: { type: "string" } } },
      },
    },
    fits: (value) => expect(record(record(value).foo)).toBeDefined(),
  },
  "count-through-ref-root": {
    schema: { $ref: "#/$defs/List", $defs: { List: INTEGER_LIST } },
    count: 10,
    fits: (value) => expect(list(value)).toHaveLength(10),
  },
  "count-through-all-of-root": {
    schema: { allOf: [INTEGER_LIST] },
    count: 10,
    fits: (value) => expect(list(value)).toHaveLength(10),
  },
  "count-through-null-union-root": {
    schema: { anyOf: [INTEGER_LIST, { type: "null" }] },
    count: 10,
    // The union may roll the root itself to null.
    fits: (value) => {
      if (value !== null) expect(list(value)).toHaveLength(10);
    },
  },
  "inclusive-maximum-tighter-than-exclusive": {
    schema: { type: "number", minimum: 0, maximum: 5, exclusiveMaximum: 100 },
    fits: (value) => {
      expect(numeric(value)).toBeGreaterThanOrEqual(0);
      expect(numeric(value)).toBeLessThanOrEqual(5);
    },
  },
};

function fidelityCase(name: string): FidelityCase {
  const found = CASES[name];
  if (!found) throw new Error(`Unknown fidelity case: ${name}`);
  return found;
}

/** Every outline in the feature runs the same three steps over a case. */
const OUTLINES = [
  "A composed node is generated from its composition",
  "An untyped node keeps the shape and bounds its keywords declare",
  "An object without properties never echoes schema keywords into the body",
  "Numeric bounds hold beside multipleOf and a second bound on the same side",
  "A not keyword rejects the values it names",
  "A property declared by several merged schemas honours every declaration",
  "Composition beside allOf is generated with it",
  "A byte string with length bounds is valid padded base64 within them",
  "A duration string is a valid ISO 8601 duration",
  "An explicit faker date is the UTC calendar date on every machine",
  "A decimal multipleOf yields exact multiples without float noise",
  "A uniqueItems array never receives two rolled nulls",
  "A nullable type union rolls no null its own composition rejects",
  "count sizes a root array reached through $ref, allOf or a null union",
];

describeFeature(feature, ({ ScenarioOutline }) => {
  let results: unknown[] = [];
  let current: FidelityCase | undefined;

  async function generateWithSeeds(seeds: number): Promise<void> {
    if (!current) throw new Error("no fidelity schema was chosen");
    results = [];
    const { schema, count } = current;
    for (let seed = 1; seed <= seeds; seed += 1) {
      results.push(await generateFromSchema({ schema, count, seed }));
    }
  }

  for (const title of OUTLINES) {
    ScenarioOutline(title, ({ Given, When, Then }, variables) => {
      Given("the fidelity schema {string}", () => {
        current = fidelityCase(variables.case);
      });
      When("I generate it with {int} different seeds", async (_, seeds) => {
        await generateWithSeeds(seeds);
      });
      Then("every generated value fits {string}", () => {
        const { fits } = fidelityCase(variables.case);
        results.forEach((value, index) => {
          fits(value, index + 1);
        });
      });
    });
  }
});
