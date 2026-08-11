import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { define, generate as generateWithConsumerJsf } from "json-schema-faker";
import { describe, expect, it } from "vitest";
import { MAX_ARRAY_SIZE, MAX_GENERATED_NODES } from "./constants.js";
import * as fakerApi from "./index.js";
import {
  fakerPlugin,
  generateFromSchema,
  MAX_OBJECT_PROPERTIES,
  MAX_STRING_LENGTH,
} from "./index.js";
import { generateWithJsf, normalizeSchemaForJsf } from "./jsf-config.js";

function captureFailure(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

function expectResource(
  error: unknown,
  resource: string,
  actual: number,
): void {
  expect(error).toBeInstanceOf(ResourceLimitError);
  if (!(error instanceof ResourceLimitError)) {
    throw new Error("Expected a resource limit error");
  }
  expect(error.context).toMatchObject({ resource, actual });
}

describe("Faker safety boundaries", () => {
  describe("actual output budgets", () => {
    it("exports and enforces the maximum schema minLength before generation", () => {
      const exportedLimit = Reflect.get(fakerApi, "MAX_STRING_LENGTH");
      expect(exportedLimit).toBeTypeOf("number");
      expect(Number.isSafeInteger(exportedLimit)).toBe(true);
      expect(Number(exportedLimit)).toBeGreaterThan(0);

      const actual = Number.MAX_SAFE_INTEGER;
      const error = captureFailure(() =>
        fakerPlugin({ schema: { type: "string", minLength: actual } }),
      );

      expectResource(error, "string_length", actual);
    });

    it("enforces the maximum schema maxLength before generation", () => {
      const actual = Number.MAX_SAFE_INTEGER;
      const error = captureFailure(() =>
        fakerPlugin({ schema: { type: "string", maxLength: actual } }),
      );

      expectResource(error, "string_length", actual);
    });

    it("generates faker and format strings that satisfy applicable constraints", async () => {
      const fakerSchema: Schmock.Schema = {
        type: "string",
        faker: {
          "string.alpha": [{ length: 8, casing: "lower" }],
        },
        minLength: 8,
        maxLength: 8,
        pattern: "^[a-z]{8}$",
      };
      const formatSchema: JSONSchema7 = {
        type: "string",
        format: "uuid",
        minLength: 36,
        maxLength: 36,
      };

      const [fakerValue, formatValue] = await Promise.all([
        generateFromSchema({ schema: fakerSchema, seed: 42 }),
        generateFromSchema({ schema: formatSchema, seed: 42 }),
      ]);

      expect(fakerValue).toBeTypeOf("string");
      expect(String(fakerValue)).toHaveLength(8);
      expect(fakerValue).toMatch(/^[a-z]{8}$/);
      expect(formatValue).toBeTypeOf("string");
      expect(String(formatValue)).toHaveLength(36);
      expect(formatValue).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it.each([
      "const",
      "default",
      "enum",
    ] as const)("rejects an oversized %s string before generation", (keyword) => {
      const oversized = "x".repeat(MAX_STRING_LENGTH + 1);
      const schema: JSONSchema7 = { type: "string" };
      Reflect.set(
        schema,
        keyword,
        keyword === "enum" ? [oversized] : oversized,
      );

      const error = captureFailure(() => fakerPlugin({ schema }));

      expectResource(error, "string_length", oversized.length);
    });

    it("rejects allocation-bearing object-form faker length arguments", () => {
      const schema: Schmock.Schema = {
        type: "string",
        faker: {
          "string.alpha": [{ length: MAX_STRING_LENGTH + 1 }],
        },
      };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expectResource(error, "string_length", MAX_STRING_LENGTH + 1);
    });

    it("throws instead of truncating if the generation backstop is reached", async () => {
      const schema: Schmock.Schema = {
        type: "string",
        faker: {
          "string.alpha": [{ length: MAX_STRING_LENGTH + 1 }],
        },
      };

      await expect(generateWithJsf(schema, 42)).rejects.toMatchObject({
        code: "RESOURCE_LIMIT_ERROR",
        context: {
          resource: "string_length",
          limit: MAX_STRING_LENGTH,
          actual: MAX_STRING_LENGTH + 1,
        },
      });
    });

    it("rejects an oversized object at the generation backstop", async () => {
      const actual = MAX_OBJECT_PROPERTIES + 1;
      const oversized = Object.fromEntries(
        Array.from({ length: actual }, (_, index) => [`field${index}`, index]),
      );

      await expect(
        generateWithJsf({ type: "object", const: oversized }, 42),
      ).rejects.toMatchObject({
        code: "RESOURCE_LIMIT_ERROR",
        context: {
          resource: "object_properties",
          limit: MAX_OBJECT_PROPERTIES,
          actual,
        },
      });
    });

    it("rejects a const array above the final output limit", async () => {
      const actual = MAX_ARRAY_SIZE + 1;
      const schema: JSONSchema7 = {
        type: "array",
        items: { type: "integer" },
        const: Array.from({ length: actual }, (_, index) => index),
      };

      await expect(
        generateFromSchema({ schema, seed: 42 }),
      ).rejects.toMatchObject({
        code: "RESOURCE_LIMIT_ERROR",
        context: { resource: "array_size", limit: MAX_ARRAY_SIZE, actual },
      });
    });

    it("rejects an oversized string introduced by an override", async () => {
      const oversized = "x".repeat(MAX_STRING_LENGTH + 1);

      await expect(
        generateFromSchema({
          schema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
          overrides: { value: oversized },
          seed: 42,
        }),
      ).rejects.toMatchObject({
        code: "RESOURCE_LIMIT_ERROR",
        context: {
          resource: "string_length",
          limit: MAX_STRING_LENGTH,
          actual: oversized.length,
        },
      });
    });

    it("rejects an oversized object introduced by an override", async () => {
      const actual = MAX_OBJECT_PROPERTIES + 1;
      const oversized = Object.fromEntries(
        Array.from({ length: actual }, (_, index) => [`field${index}`, index]),
      );

      await expect(
        generateFromSchema({
          schema: {
            type: "object",
            properties: { value: { type: "object" } },
          },
          overrides: { value: oversized },
          seed: 42,
        }),
      ).rejects.toMatchObject({
        code: "RESOURCE_LIMIT_ERROR",
        context: {
          resource: "object_properties",
          limit: MAX_OBJECT_PROPERTIES,
          actual,
        },
      });
    });

    it("rejects a final override tree above the total node budget", async () => {
      const sharedRow = Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`field${index}`, index]),
      );
      const oversized = Array.from({ length: MAX_ARRAY_SIZE }, () => sharedRow);

      await expect(
        generateFromSchema({
          schema: {
            type: "object",
            properties: {
              rows: { type: "array", items: { type: "object" } },
            },
          },
          overrides: { rows: oversized },
          seed: 42,
        }),
      ).rejects.toMatchObject({
        code: "RESOURCE_LIMIT_ERROR",
        context: {
          resource: "generated_nodes",
          limit: MAX_GENERATED_NODES,
        },
      });
    });

    it("charges shared output DAG nodes at every clone position", async () => {
      let shared: unknown = "leaf";
      for (let depth = 0; depth < 20; depth += 1) {
        shared = [shared, shared];
      }

      await expect(
        generateWithJsf({ type: "array", const: shared }, 42),
      ).rejects.toMatchObject({
        code: "RESOURCE_LIMIT_ERROR",
        context: {
          resource: "generated_nodes",
          limit: MAX_GENERATED_NODES,
        },
      });
    });

    it("ignores string keywords when the schema cannot generate strings", async () => {
      const schema: JSONSchema7 = {
        type: "integer",
        minimum: 1,
        maximum: 2,
        maxLength: Number.MAX_SAFE_INTEGER,
      };

      await expect(generateFromSchema({ schema, seed: 42 })).resolves.toSatisfy(
        (value: unknown) =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 1 &&
          value <= 2,
      );
    });

    it("includes an explicit top-level count in the generated-node estimate", () => {
      const schema: JSONSchema7 = {
        type: "array",
        items: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 200 }, (_, index) => [
              `field${index}`,
              { type: "string" },
            ]),
          ),
        },
      };

      const error = captureFailure(() =>
        fakerPlugin({ schema, count: 10_000 }),
      );

      expect(error).toBeInstanceOf(ResourceLimitError);
      if (!(error instanceof ResourceLimitError)) {
        throw new Error("Expected a resource limit error");
      }
      expect(error.context).toMatchObject({ resource: "generated_nodes" });
      expect(error.context).toMatchObject({ actual: 2_010_001 });
    });
  });

  describe("local references", () => {
    it("rejects an indirect cycle through a local JSON Pointer", () => {
      const schema: JSONSchema7 = {
        $ref: "#/$defs/node",
        $defs: {
          node: {
            type: "object",
            properties: { child: { $ref: "#/$defs/node" } },
            required: ["child"],
          },
        },
      };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!(error instanceof SchemaValidationError)) {
        throw new Error("Expected a schema validation error");
      }
      expect(error.code).toBe("SCHEMA_VALIDATION_ERROR");
      expect(error.message).toMatch(/circular/i);
    });

    it("counts a shared referenced target at every generated position", () => {
      const properties = Object.fromEntries(
        Array.from({ length: 1_100 }, (_, index) => [
          `row${index}`,
          { $ref: "#/$defs/row" },
        ]),
      );
      const schema: JSONSchema7 = {
        type: "object",
        properties,
        $defs: {
          row: {
            type: "array",
            minItems: 1_000,
            maxItems: 1_000,
            items: { type: "string" },
          },
        },
      };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expect(error).toBeInstanceOf(ResourceLimitError);
      if (!(error instanceof ResourceLimitError)) {
        throw new Error("Expected a resource limit error");
      }
      expect(error.context).toMatchObject({ resource: "generated_nodes" });
    });

    it("rejects a cycle linked through relative embedded resource IDs", () => {
      const schema: JSONSchema7 = {
        $id: "https://example.test/schemas/root.json",
        $ref: "nodes/parent.json",
        $defs: {
          parent: {
            $id: "nodes/parent.json",
            type: "object",
            properties: { child: { $ref: "child.json" } },
          },
          child: {
            $id: "nodes/child.json",
            type: "object",
            properties: { parent: { $ref: "parent.json" } },
          },
        },
      };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!(error instanceof SchemaValidationError)) {
        throw new Error("Expected a schema validation error");
      }
      expect(error.message).toMatch(/circular/i);
    });

    it("rejects a cycle linked through a dynamic reference", () => {
      const schema: JSONSchema7 = {
        $id: "https://example.test/node.json",
        type: "object",
        properties: {
          child: {
            $dynamicRef: "#node",
          },
        },
      };
      Reflect.set(schema, "$dynamicAnchor", "node");

      const error = captureFailure(() => fakerPlugin({ schema }));

      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!(error instanceof SchemaValidationError)) {
        throw new Error("Expected a schema validation error");
      }
      expect(error.message).toMatch(/circular/i);
    });

    it("rejects duplicate canonical embedded resource IDs", () => {
      const schema: JSONSchema7 = {
        $id: "https://example.test/root.json",
        type: "object",
        $defs: {
          first: { $id: "./shared.json", type: "string" },
          second: {
            $id: "https://example.test/shared.json",
            type: "integer",
          },
        },
      };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expect(error).toBeInstanceOf(SchemaValidationError);
      expect(String(error)).toMatch(/duplicate.*identifier/i);
    });

    it.each([
      "$anchor",
      "$dynamicAnchor",
    ] as const)("rejects duplicate canonical %s values", (keyword) => {
      const first: JSONSchema7 = { type: "string" };
      const second: JSONSchema7 = { type: "integer" };
      Reflect.set(first, keyword, "shared");
      Reflect.set(second, keyword, "shared");
      const schema: JSONSchema7 = {
        $id: "https://example.test/root.json",
        type: "object",
        $defs: { first, second },
      };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expect(error).toBeInstanceOf(SchemaValidationError);
      expect(String(error)).toMatch(/duplicate.*identifier/i);
    });

    it("charges absolute references to embedded resources at every output site", () => {
      const properties = Object.fromEntries(
        Array.from({ length: 1_100 }, (_, index) => [
          `row${index}`,
          { $ref: "https://example.test/schemas/rows/row.json" },
        ]),
      );
      const schema: JSONSchema7 = {
        $id: "https://example.test/schemas/root.json",
        type: "object",
        properties,
        $defs: {
          row: {
            $id: "rows/row.json",
            type: "array",
            minItems: 1_000,
            maxItems: 1_000,
            items: { type: "string" },
          },
        },
      };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expect(error).toBeInstanceOf(ResourceLimitError);
      if (!(error instanceof ResourceLimitError)) {
        throw new Error("Expected a resource limit error");
      }
      expect(error.context).toMatchObject({
        resource: "generated_nodes",
        actual: 1_101_101,
      });
    });

    it("accepts repeated relative references to one embedded resource", async () => {
      const schema: JSONSchema7 = {
        $id: "https://example.test/schemas/root.json",
        type: "object",
        properties: {
          left: { $ref: "leaf.json" },
          right: { $ref: "leaf.json" },
        },
        required: ["left", "right"],
        $defs: {
          leaf: {
            $id: "leaf.json",
            type: "object",
            properties: { value: { type: "integer" } },
            required: ["value"],
          },
        },
      };

      await expect(
        generateFromSchema({ schema, seed: 42 }),
      ).resolves.toMatchObject({
        left: { value: expect.any(Number) },
        right: { value: expect.any(Number) },
      });
    });

    it("accepts a shared local-reference DAG below the output budget", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          left: { $ref: "#/$defs/leaf" },
          right: { $ref: "#/$defs/leaf" },
        },
        required: ["left", "right"],
        $defs: {
          leaf: {
            type: "object",
            properties: { value: { type: "integer" } },
            required: ["value"],
          },
        },
      };

      await expect(
        generateFromSchema({ schema, seed: 42 }),
      ).resolves.toMatchObject({
        left: { value: expect.any(Number) },
        right: { value: expect.any(Number) },
      });
    });

    it("counts one reused schema node once across a wide shared DAG", () => {
      const shared: JSONSchema7 = { type: "integer" };
      const schema: JSONSchema7 = {
        allOf: Array.from({ length: 50_100 }, () => shared),
      };

      expect(() => fakerPlugin({ schema })).not.toThrow();
    });
  });

  describe("object cardinality", () => {
    it("exports a finite object-property limit", () => {
      expect(Number.isSafeInteger(MAX_OBJECT_PROPERTIES)).toBe(true);
      expect(MAX_OBJECT_PROPERTIES).toBeGreaterThan(0);
    });

    it("rejects an oversized minimum property count", () => {
      const actual = Number.MAX_SAFE_INTEGER;
      const schema: JSONSchema7 = {
        type: "object",
        minProperties: actual,
        additionalProperties: { type: "string" },
      };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expectResource(error, "object_properties", actual);
    });

    it("rejects an object with too many declared properties", () => {
      const actual = MAX_OBJECT_PROPERTIES + 1;
      const schema: JSONSchema7 = {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: actual }, (_, index) => [
            `field${index}`,
            { type: "integer" },
          ]),
        ),
      };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expectResource(error, "object_properties", actual);
    });

    it("includes generated additional properties in the node estimate", () => {
      const additionalValue: JSONSchema7 = {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 1_100 }, (_, index) => [
            `field${index}`,
            { type: "string" },
          ]),
        ),
      };
      const schema: JSONSchema7 = {
        type: "object",
        minProperties: 1_000,
        additionalProperties: additionalValue,
      };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expect(error).toBeInstanceOf(ResourceLimitError);
      if (!(error instanceof ResourceLimitError)) {
        throw new Error("Expected a resource limit error");
      }
      expect(error.context).toMatchObject({
        resource: "generated_nodes",
        actual: 1_101_001,
      });
    });
  });

  describe("object-form faker syntax", () => {
    it("passes an argument array to the one declared faker method", async () => {
      const schema: Schmock.Schema = {
        type: "integer",
        faker: { "number.int": [{ min: 1, max: 2 }] },
      };

      await expect(generateFromSchema({ schema, seed: 42 })).resolves.toSatisfy(
        (value: unknown) =>
          typeof value === "number" && value >= 1 && value <= 2,
      );
    });

    it.each([
      ["an empty object", {}],
      ["multiple method keys", { "number.int": [], "number.float": [] }],
      ["a non-array argument value", { "number.int": { min: 1, max: 2 } }],
      ["an array instead of an object", ["number.int"]],
    ])("rejects %s", (_label, faker) => {
      const schema: Schmock.Schema = { type: "integer" };
      Reflect.set(schema, "faker", faker);
      const error = captureFailure(() => fakerPlugin({ schema }));

      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!(error instanceof SchemaValidationError)) {
        throw new Error("Expected a schema validation error");
      }
      expect(error.context).toMatchObject({ schemaPath: "$.faker" });
    });

    it.each([
      {
        method: "word.words",
        args: [MAX_STRING_LENGTH + 1],
        schemaType: "string" as const,
        resource: "string_length",
        actual: MAX_STRING_LENGTH + 1,
      },
      {
        method: "string.fromCharacters",
        args: ["ab", MAX_STRING_LENGTH + 1],
        schemaType: "string" as const,
        resource: "string_length",
        actual: MAX_STRING_LENGTH + 1,
      },
      {
        method: "helpers.uniqueArray",
        args: [() => "value", MAX_ARRAY_SIZE + 1],
        schemaType: "array" as const,
        resource: "array_size",
        actual: MAX_ARRAY_SIZE + 1,
      },
      {
        method: "helpers.arrayElements",
        args: [["value"], MAX_ARRAY_SIZE + 1],
        schemaType: "array" as const,
        resource: "array_size",
        actual: MAX_ARRAY_SIZE + 1,
      },
      {
        method: "helpers.multiple",
        args: [() => "value", { count: MAX_ARRAY_SIZE + 1 }],
        schemaType: "array" as const,
        resource: "array_size",
        actual: MAX_ARRAY_SIZE + 1,
      },
    ])("rejects the allocation count for $method", ({
      method,
      args,
      schemaType,
      resource,
      actual,
    }) => {
      const schema: Schmock.Schema = {
        type: schemaType,
        faker: { [method]: args },
      };
      if (schemaType === "array") schema.items = { type: "string" };

      const error = captureFailure(() => fakerPlugin({ schema }));

      expectResource(error, resource, actual);
    });

    it("does not treat scalar string method options as allocation counts", () => {
      const schema: Schmock.Schema = {
        type: "string",
        faker: {
          "string.uuid": [{ version: 7, refDate: 1_000_000 }],
        },
      };

      expect(() => fakerPlugin({ schema })).not.toThrow();
    });

    it("does not treat scalar number bounds as allocation counts", () => {
      const schema: Schmock.Schema = {
        type: "integer",
        faker: {
          "number.int": [{ min: 1_000_000, max: 2_000_000 }],
        },
      };

      expect(() => fakerPlugin({ schema })).not.toThrow();
    });
  });

  describe("forwarded schema keyword traversal", () => {
    const invalidChild: Schmock.Schema = {
      type: "string",
      faker: "notAReal.method",
    };

    it.each([
      [
        "prefixItems",
        () => {
          const schema: JSONSchema7 = {};
          Reflect.set(schema, "prefixItems", [invalidChild]);
          return schema;
        },
      ],
      [
        "dependentSchemas",
        () => {
          const schema: JSONSchema7 = { type: "object" };
          Reflect.set(schema, "dependentSchemas", { value: invalidChild });
          return schema;
        },
      ],
      [
        "contentSchema",
        () => {
          const schema: JSONSchema7 = { type: "string" };
          Reflect.set(schema, "contentSchema", invalidChild);
          return schema;
        },
      ],
      [
        "containsAll",
        () => {
          const schema: JSONSchema7 = {
            type: "array",
            items: { type: "string" },
          };
          Reflect.set(schema, "containsAll", [invalidChild]);
          return schema;
        },
      ],
    ] as const)("validates schemas inside %s", (_keyword, createSchema) => {
      const error = captureFailure(() =>
        fakerPlugin({ schema: createSchema() }),
      );

      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!(error instanceof SchemaValidationError)) {
        throw new Error("Expected a schema validation error");
      }
      expect(error.context).toMatchObject({
        schemaPath: expect.stringContaining(".faker"),
      });
    });
  });

  describe("plugin option snapshots", () => {
    const context: Schmock.PluginContext = {
      method: "GET",
      path: "/snapshot",
      params: {},
      query: {},
      state: new Map(),
      routeState: {},
      headers: {},
      route: { pattern: "/snapshot" },
    };

    it("uses only schema, count, overrides, and seed captured at creation", async () => {
      const valueSchema: JSONSchema7 = { type: "integer" };
      const itemSchema: JSONSchema7 = {
        type: "object",
        properties: {
          value: valueSchema,
          label: { type: "string" },
        },
        required: ["value", "label"],
      };
      const schema: JSONSchema7 = { type: "array", items: itemSchema };
      const overrides = { label: "captured" };
      const options: Schmock.FakerPluginOptions = {
        schema,
        count: 1,
        overrides,
        seed: 42,
      };
      const plugin = fakerPlugin(options);
      const baseline = await plugin.process(context);

      valueSchema.const = 999_999;
      options.count = 2;
      overrides.label = "mutated";
      options.seed = 43;
      const afterMutation = await plugin.process(context);

      expect(afterMutation.response).toEqual(baseline.response);
      expect(afterMutation.response).toMatchObject([{ label: "captured" }]);
    });

    it("supports callback functions in snapshotted faker arguments", async () => {
      const callback = () => "callback-value";
      const schema: Schmock.Schema = {
        type: "array",
        items: { type: "string" },
        faker: {
          "helpers.multiple": [callback, { count: 2 }],
        },
      };

      const result = await fakerPlugin({ schema, seed: 42 }).process(context);

      expect(result.response).toEqual(["callback-value", "callback-value"]);
    });
  });

  describe("json-schema-faker registry isolation", () => {
    it("ignores a consumer define extension without clearing its registration", async () => {
      const extensionName = "schmockUnitContaminationProbe";
      const schema = {
        type: "integer",
        minimum: 1,
        maximum: 2,
        [extensionName]: true,
      } as const;
      define(extensionName, () => 999_999);

      expect(await generateWithConsumerJsf(schema, { seed: 42 })).toBe(999_999);

      const [schmockValue, concurrentConsumerValue] = await Promise.all([
        generateFromSchema({ schema, seed: 42 }),
        generateWithConsumerJsf(schema, { seed: 43 }),
      ]);

      expect(schmockValue).toEqual(expect.any(Number));
      expect(Number(schmockValue)).toBeGreaterThanOrEqual(1);
      expect(Number(schmockValue)).toBeLessThanOrEqual(2);
      expect(concurrentConsumerValue).toBe(999_999);
      await expect(generateWithConsumerJsf(schema, { seed: 44 })).resolves.toBe(
        999_999,
      );
    });

    it("preserves the complete pinned JSF-only vocabulary", () => {
      const schema: JSONSchema7 = { type: "integer" };
      const containsAll = [{ type: "string" }];
      for (const [keyword, value] of Object.entries({
        autoIncrement: true,
        initialOffset: 7,
        template: "#{value}",
        jsonPath: "$.value",
        chance: "integer",
        example: 7,
        containsAll,
        consumerOnlyKeyword: true,
      })) {
        Reflect.set(schema, keyword, value);
      }

      const normalized = normalizeSchemaForJsf(schema);

      expect(normalized).toMatchObject({
        autoIncrement: true,
        initialOffset: 7,
        template: "#{value}",
        jsonPath: "$.value",
        chance: "integer",
        example: 7,
        containsAll,
      });
      expect(normalized).not.toHaveProperty("consumerOnlyKeyword");
    });

    it("retains auto-increment and template generation behavior", async () => {
      const sequenceItem: JSONSchema7 = { type: "integer" };
      Reflect.set(sequenceItem, "autoIncrement", true);
      Reflect.set(sequenceItem, "initialOffset", 7);
      const templated: JSONSchema7 = { type: "string" };
      Reflect.set(templated, "template", "Hello #{first}");

      const [sequence, message] = await Promise.all([
        generateFromSchema({
          schema: { type: "array", items: sequenceItem },
          count: 3,
          seed: 42,
        }),
        generateFromSchema({
          schema: {
            type: "object",
            properties: {
              first: { type: "string", const: "Ada" },
              message: templated,
            },
            required: ["first", "message"],
          },
          seed: 42,
        }),
      ]);

      expect(sequence).toEqual([7, 8, 9]);
      expect(message).toMatchObject({ first: "Ada", message: "Hello Ada" });
    });

    it("isolates a consumer extension colliding with the type keyword", async () => {
      const schema = {
        type: "integer",
        minimum: 1,
        maximum: 2,
      } as const;
      define("type", () => 999_999);

      expect(await generateWithConsumerJsf(schema, { seed: 42 })).toBe(999_999);

      const [schmockValue, consumerValue] = await Promise.all([
        generateFromSchema({ schema, seed: 42 }),
        generateWithConsumerJsf(schema, { seed: 43 }),
      ]);

      expect(schmockValue).toEqual(expect.any(Number));
      expect(Number(schmockValue)).toBeGreaterThanOrEqual(1);
      expect(Number(schmockValue)).toBeLessThanOrEqual(2);
      expect(consumerValue).toBe(999_999);
    });
  });
});
