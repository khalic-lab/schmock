import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { MAX_GENERATED_CHARS, MAX_STRING_LENGTH } from "./constants";
import { fakerPlugin, generateFromSchema } from "./index";
import { normalizeSchemaForJsf } from "./jsf-config";
import { assertOutputWithinLimits } from "./output-limits";
import { validateFakerMethod, validateSchema } from "./validation";

function captureFailure(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectResource(error: unknown, resource: string): void {
  expect(error).toBeInstanceOf(ResourceLimitError);
  expect(error).toMatchObject({ context: { resource } });
}

function withFaker(faker: unknown): JSONSchema7 {
  const schema: JSONSchema7 = { type: "string" };
  Reflect.set(schema, "faker", faker);
  return schema;
}

describe("review: aggregate output budget (finding 77)", () => {
  it("rejects generated strings whose total length passes the budget", () => {
    const value = "a".repeat(MAX_STRING_LENGTH);
    const items = Math.floor(MAX_GENERATED_CHARS / MAX_STRING_LENGTH) + 1;
    const error = captureFailure(() =>
      assertOutputWithinLimits(Array.from({ length: items }, () => value)),
    );
    expectResource(error, "generated_chars");
  });

  it("counts object keys toward the budget", () => {
    const longKey = "k".repeat(MAX_STRING_LENGTH);
    const entries = Math.floor(MAX_GENERATED_CHARS / MAX_STRING_LENGTH);
    const value = Array.from({ length: entries }, () => ({
      [longKey]: "v",
    }));
    const error = captureFailure(() => assertOutputWithinLimits(value));
    expectResource(error, "generated_chars");
  });

  it("accepts output exactly at the budget", () => {
    const value = "a".repeat(MAX_STRING_LENGTH);
    const items = Math.floor(MAX_GENERATED_CHARS / MAX_STRING_LENGTH);
    expect(() =>
      assertOutputWithinLimits(Array.from({ length: items }, () => value)),
    ).not.toThrow();
  });

  it("charges only minLength at construction, never maxLength", () => {
    expect(() =>
      validateSchema({
        type: "array",
        minItems: 10_000,
        maxItems: 10_000,
        items: { type: "string", maxLength: 5_000 },
      }),
    ).not.toThrow();
  });

  it("charges a root array only for the items it is certain to hold", () => {
    const wideString: JSONSchema7 = {
      type: "string",
      minLength: MAX_STRING_LENGTH,
      maxLength: MAX_STRING_LENGTH,
    };
    // The root is resized per request from minItems up, so 1 item is certain.
    expect(() =>
      validateSchema({
        type: "array",
        minItems: 1,
        maxItems: 300,
        items: wideString,
      }),
    ).not.toThrow();
    // A nested array is always filled to maxItems.
    expectResource(
      captureFailure(() =>
        validateSchema({
          type: "object",
          properties: {
            list: { type: "array", maxItems: 300, items: wideString },
          },
        }),
      ),
      "generated_chars",
    );
    // An explicit count is exact.
    expectResource(
      captureFailure(() =>
        validateSchema({ type: "array", items: wideString }, "$", 300),
      ),
      "generated_chars",
    );
  });
});

describe("review: faker allocation ceilings (finding 78)", () => {
  it("bounds word, sentence and paragraph counts by what could fit in one string", () => {
    for (const faker of [
      { "lorem.words": [40_000] },
      { "word.words": [{ count: 40_000 }] },
      { "lorem.sentence": [40_000] },
      { "lorem.sentences": [10_000] },
      { "lorem.lines": [{ min: 1, max: 10_000 }] },
      { "lorem.paragraph": [10_000] },
      { "lorem.paragraphs": [5_000] },
    ]) {
      expectResource(
        captureFailure(() => validateSchema(withFaker(faker))),
        "string_length",
      );
    }
  });

  it("keeps ordinary counts valid", () => {
    for (const faker of [
      { "lorem.words": [12] },
      { "lorem.sentences": [4] },
      { "lorem.paragraphs": [3] },
      { "helpers.fake": ["{{person.firstName}} {{lorem.words(3)}}"] },
      { "helpers.fake": [["{{lorem.word}}", "{{location.city}}"]] },
      { "helpers.fromRegExp": ["[A-Z]{3}-[0-9]{4}"] },
      { "helpers.mustache": ["Hi {{name}}", { name: "Ada" }] },
    ]) {
      expect(() => validateSchema(withFaker(faker))).not.toThrow();
    }
  });

  it("checks every template in an array-form helpers.fake", () => {
    expectResource(
      captureFailure(() =>
        validateSchema(
          withFaker({
            "helpers.fake": [["{{lorem.word}}", "{{lorem.paragraphs(9999)}}"]],
          }),
        ),
      ),
      "string_length",
    );
  });

  it("bounds helpers.fromRegExp by its explicit upper quantifier", () => {
    expectResource(
      captureFailure(() =>
        validateSchema(withFaker({ "helpers.fromRegExp": ["a{0,100000}"] })),
      ),
      "string_length",
    );
  });

  it("bounds a schema pattern by the shortest string it can match", () => {
    expectResource(
      captureFailure(() =>
        validateSchema({ type: "string", pattern: "^a{70000}$" }),
      ),
      "string_length",
    );
    // json-schema-faker caps the upper bound of a range quantifier, so only
    // the lower bound is charged.
    expect(() =>
      validateSchema({ type: "string", pattern: "^[a-z]{1,100000}$" }),
    ).not.toThrow();
    expect(() =>
      validateSchema({ type: "string", pattern: "^(?:ab|c{70000})$" }),
    ).not.toThrow();
  });
});

describe("review: non-generating subschemas (finding 79)", () => {
  it("still charges then/else branches, which do generate", () => {
    expectResource(
      captureFailure(() =>
        validateSchema({
          type: "array",
          items: { type: "integer" },
          if: { maxItems: 1 },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is named "then"
          then: { minItems: 20_000 },
        }),
      ),
      "array_max_items",
    );
  });
});

describe("review: faker method resolution (finding 83)", () => {
  it("rejects inherited Object.prototype members and private members", () => {
    for (const method of [
      "person.toString",
      "person.constructor",
      "helpers.hasOwnProperty",
      "person.valueOf",
      "person.__proto__",
    ]) {
      expect(() => validateFakerMethod(method)).toThrow(SchemaValidationError);
    }
  });

  it("keeps real methods valid", () => {
    for (const method of [
      "person.firstName",
      "helpers.arrayElement",
      "string.uuid",
      "lorem.words",
    ]) {
      expect(() => validateFakerMethod(method)).not.toThrow();
    }
  });
});

describe("review: lone numeric bounds (finding 19)", () => {
  it("adds a finite opposite bound to the JSF copy only", () => {
    const schema: JSONSchema7 = { type: "integer", minimum: 5_000 };
    const normalized = normalizeSchemaForJsf(schema);
    expect(normalized.maximum).toBeGreaterThan(5_000);
    expect(schema).toEqual({ type: "integer", minimum: 5_000 });
  });

  it("leaves bounds json-schema-faker already handles alone", () => {
    for (const schema of [
      { type: "integer", minimum: 5_000, maximum: 6_000 },
      { type: "integer", minimum: 5_000, multipleOf: 10 },
      { type: "integer", minimum: 500 },
      { type: "integer", maximum: -500 },
    ] satisfies JSONSchema7[]) {
      expect(normalizeSchemaForJsf(schema)).toEqual(schema);
    }
  });

  it("ignores OpenAPI 3.0 boolean exclusive bounds", () => {
    const schema: JSONSchema7 = { type: "number" };
    Reflect.set(schema, "exclusiveMinimum", true);
    expect(normalizeSchemaForJsf(schema)).toEqual(schema);
  });

  it("generates year and epoch fields inside their declared range", async () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        year: { type: "integer", minimum: 1900 },
        createdAt: { type: "integer", minimum: 1_600_000_000 },
      },
      required: ["year", "createdAt"],
    };
    for (let seed = 0; seed < 30; seed += 1) {
      const value = await generateFromSchema({ schema, seed });
      expect(value).toMatchObject({
        year: expect.any(Number),
        createdAt: expect.any(Number),
      });
      expect(Reflect.get(Object(value), "year")).toBeGreaterThanOrEqual(1900);
      expect(Reflect.get(Object(value), "createdAt")).toBeGreaterThanOrEqual(
        1_600_000_000,
      );
    }
  });
});

describe("review: memory heuristics removed (finding 24)", () => {
  it("accepts a depth-4 array of 1000 strings, well inside the node budget", async () => {
    const plugin = fakerPlugin({
      schema: {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: {
                    type: "array",
                    items: { type: "string" },
                    maxItems: 1000,
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(plugin.name).toBe("faker");
  });
});

describe("review: package manifest (finding 137)", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
  );

  function section(name: string): Record<string, string> {
    const value = Reflect.get(Object(manifest), name);
    return typeof value === "object" && value !== null ? { ...value } : {};
  }

  it("ships no json-schema-faker to consumers, since the build bundles it", () => {
    const dependencies = section("dependencies");
    expect(dependencies).not.toHaveProperty("json-schema-faker");
    expect(dependencies).not.toHaveProperty("json-schema-faker-private");
    expect(section("devDependencies")).toMatchObject({
      "json-schema-faker-private": "npm:json-schema-faker@0.6.3",
    });
  });

  it("declares no URL or git dependency anywhere", () => {
    for (const name of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const spec of Object.values(section(name))) {
        expect(spec).not.toMatch(/^(?:https?:|git[+:]|github:|file:)/);
      }
    }
  });
});
