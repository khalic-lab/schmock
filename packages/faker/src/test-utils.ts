import type * as Schmock from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { expect } from "vitest";
import { generateFromSchema } from "./index";

interface FakerSchema extends JSONSchema7 {
  faker?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Schema Factory Functions
export const schemas = {
  simple: {
    string: (): JSONSchema7 => ({
      type: "string",
    }),

    number: (): JSONSchema7 => ({
      type: "number",
    }),

    object: (properties: Record<string, JSONSchema7> = {}): JSONSchema7 => ({
      type: "object",
      properties,
    }),

    array: (
      items: JSONSchema7,
      constraints?: { minItems?: number; maxItems?: number },
    ): JSONSchema7 => ({
      type: "array",
      items,
      ...constraints,
    }),
  },

  withFaker: (type: JSONSchema7["type"], fakerMethod: string): FakerSchema => ({
    type,
    faker: fakerMethod,
  }),

  nested: {
    deep: (
      depth: number,
      leafSchema: JSONSchema7 = schemas.simple.string(),
    ): JSONSchema7 => {
      if (depth <= 0) return leafSchema;
      return {
        type: "object",
        properties: {
          nested: schemas.nested.deep(depth - 1, leafSchema),
        },
      };
    },

    wide: (
      width: number,
      propertySchema: JSONSchema7 = schemas.simple.string(),
    ): JSONSchema7 => ({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: width }, (_, i) => [`prop${i}`, propertySchema]),
      ),
    }),
  },

  complex: {
    user: (): JSONSchema7 => ({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        email: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        createdAt: { type: "string" },
      },
      required: ["id", "email"],
    }),

    apiResponse: (): JSONSchema7 => ({
      type: "object",
      properties: {
        success: { type: "boolean" },
        data: {
          type: "array",
          items: schemas.complex.user(),
        },
        meta: {
          type: "object",
          properties: {
            page: { type: "number" },
            total: { type: "number" },
          },
        },
      },
    }),
  },
};

// Validation Helpers
export const validators = {
  // Check if a field was mapped to a faker method by comparing with unmapped behavior
  isFieldMapped: async (
    fieldName: string,
    fieldType: JSONSchema7["type"] = "string",
  ): Promise<boolean> => {
    const mappedSchema: JSONSchema7 = {
      type: "object",
      properties: {
        [fieldName]: { type: fieldType },
      },
    };

    const unmappedSchema: JSONSchema7 = {
      type: "object",
      properties: {
        unmappedRandomField12345: { type: fieldType },
      },
    };

    // Generate multiple samples to check for patterns
    const mappedSamples: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await generateFromSchema({
        schema: mappedSchema,
      });
      if (!isRecord(result)) {
        throw new Error(
          "Expected mapped schema generation to return an object",
        );
      }
      mappedSamples.push(result[fieldName]);
    }

    const unmappedSamples: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await generateFromSchema({
        schema: unmappedSchema,
      });
      if (!isRecord(result)) {
        throw new Error(
          "Expected unmapped schema generation to return an object",
        );
      }
      unmappedSamples.push(result.unmappedRandomField12345);
    }

    // If field is mapped to a specific faker method, it should have different characteristics
    // than the generic unmapped field
    return (
      analyzeDataCharacteristics(mappedSamples) !==
      analyzeDataCharacteristics(unmappedSamples)
    );
  },

  // Analyze uniqueness of generated data
  uniquenessRatio: (samples: unknown[]): number => {
    const unique = new Set(samples);
    return unique.size / samples.length;
  },

  // Check if all samples match a basic pattern without being too specific
  allMatch: <T>(samples: T[], validator: (sample: T) => boolean): boolean => {
    return samples.every(validator);
  },

  // Check if data appears to be from a specific faker category
  appearsToBeFromCategory: (
    samples: string[],
    category: "email" | "name" | "phone" | "address" | "uuid" | "date",
  ): boolean => {
    switch (category) {
      case "email":
        return validators.allMatch(
          samples,
          (s) => typeof s === "string" && s.includes("@") && s.includes("."),
        );
      case "name":
        return validators.allMatch(
          samples,
          (s) =>
            typeof s === "string" &&
            s.length > 1 &&
            s.length < 50 &&
            /^[A-Z]/.test(s),
        );
      case "phone":
        return validators.allMatch(
          samples,
          (s) => typeof s === "string" && /\d/.test(s) && s.length > 10,
        );
      case "address":
        return validators.allMatch(
          samples,
          (s) =>
            typeof s === "string" &&
            s.length > 10 &&
            /\d/.test(s) &&
            /[A-Z]/.test(s),
        );
      case "uuid":
        return validators.allMatch(
          samples,
          (s) =>
            typeof s === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              s,
            ),
        );
      case "date":
        return validators.allMatch(
          samples,
          (s) => typeof s === "string" && !Number.isNaN(Date.parse(s)),
        );
      default:
        return false;
    }
  },
};

// Test Data Generators
export const generate = {
  samples: async (
    schema: JSONSchema7,
    count = 10,
    options?: Omit<Schmock.SchemaGenerationContext, "schema">,
  ): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (let i = 0; i < count; i++) {
      results.push(await generateFromSchema({ schema, ...options }));
    }
    return results;
  },

  withSeed: async (schema: JSONSchema7, seed?: number): Promise<unknown> => {
    return await generateFromSchema({ schema, seed });
  },
};

// Statistical Analysis
export const stats = {
  distribution: (samples: unknown[]): Map<string, number> => {
    const dist = new Map<string, number>();
    for (const sample of samples) {
      const key = JSON.stringify(sample) ?? "undefined";
      dist.set(key, (dist.get(key) || 0) + 1);
    }
    return dist;
  },

  entropy: (samples: unknown[]): number => {
    const dist = stats.distribution(samples);
    const total = samples.length;
    let entropy = 0;

    for (const count of dist.values()) {
      const p = count / total;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    return entropy;
  },
};

// Schema Validation Test Helpers
export const schemaTests = {
  expectValid: async (schema: JSONSchema7): Promise<void> => {
    await expect(generateFromSchema({ schema })).resolves.not.toThrow();
  },

  expectInvalid: async (
    schema: JSONSchema7,
    errorMessage?: string | RegExp,
  ): Promise<void> => {
    if (errorMessage) {
      await expect(generateFromSchema({ schema })).rejects.toThrow(
        errorMessage,
      );
    } else {
      await expect(generateFromSchema({ schema })).rejects.toThrow();
    }
  },

  expectSchemaError: async (
    schema: JSONSchema7,
    path: string,
    issue?: string,
  ): Promise<void> => {
    try {
      await generateFromSchema({ schema });
      throw new Error("Expected schema validation to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error("Expected schema validation to throw an Error");
      }
      expect(error.name).toBe("SchemaValidationError");
      // The schemaPath is in the context
      if (
        "context" in error &&
        isRecord(error.context) &&
        error.context.schemaPath
      ) {
        expect(error.context.schemaPath).toBe(path);
      }
      if (issue) {
        expect(error.message).toContain(issue);
      }
    }
  },
};

// Helper to analyze data characteristics without hardcoding patterns
function analyzeDataCharacteristics(samples: unknown[]): string {
  if (samples.length === 0) return "empty";

  const first = samples[0];
  const type = typeof first;

  if (!samples.every((sample) => typeof sample === "string")) return type;

  // Analyze string characteristics
  const characteristics: string[] = [type];

  // Check common patterns without being too specific
  if (samples.every((s) => s.includes("@"))) characteristics.push("has-at");
  if (samples.every((s) => /^\d+$/.test(s))) characteristics.push("numeric");
  if (samples.every((s) => /^[0-9a-f-]+$/i.test(s)))
    characteristics.push("hex-like");
  if (samples.every((s) => s.length > 50)) characteristics.push("long");
  if (samples.every((s) => s.length < 10)) characteristics.push("short");
  if (validators.uniquenessRatio(samples) > 0.8)
    characteristics.push("high-entropy");
  if (validators.uniquenessRatio(samples) < 0.2)
    characteristics.push("low-entropy");

  return characteristics.join("-");
}
