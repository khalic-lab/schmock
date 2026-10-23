import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import type { JSONSchema7 } from "json-schema";
import { expect } from "vitest";
import { generateFromSchema } from "../index";

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
  fits: (value: unknown) => void;
}

const STATUS: JSONSchema7 = {
  type: "string",
  oneOf: [{ const: "open" }, { const: "closed" }],
};

function expectStatus(value: unknown): void {
  expect(["open", "closed"]).toContain(value);
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
];

describeFeature(feature, ({ ScenarioOutline }) => {
  let results: unknown[] = [];
  let current: FidelityCase | undefined;

  async function generateWithSeeds(seeds: number): Promise<void> {
    if (!current) throw new Error("no fidelity schema was chosen");
    results = [];
    for (let seed = 1; seed <= seeds; seed += 1) {
      results.push(await generateFromSchema({ schema: current.schema, seed }));
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
        for (const value of results) fidelityCase(variables.case).fits(value);
      });
    });
  }
});
