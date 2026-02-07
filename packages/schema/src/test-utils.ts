import type { JSONSchema7 } from "json-schema";
import { expect } from "vitest";
import { generateFromSchema } from "./index";

interface FakerSchema extends JSONSchema7 {
  faker?: string;
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
    const mappedSamples = Array.from(
      { length: 10 },
      () => generateFromSchema({ schema: mappedSchema })[fieldName],
    );

    const unmappedSamples = Array.from(
      { length: 10 },
      () =>
        generateFromSchema({ schema: unmappedSchema }).unmappedRandomField12345,
    );

    // If field is mapped to a specific faker method, it should have different characteristics
    // than the generic unmapped field
    return (
      analyzeDataCharacteristics(mappedSamples) !==
      analyzeDataCharacteristics(unmappedSamples)
    );
  },

  // Analyze uniqueness of generated data
  uniquenessRatio: (samples: any[]): number => {
    const unique = new Set(samples);
    return unique.size / samples.length;
  },

  // Check if all samples match a basic pattern without being too specific
  allMatch: (samples: any[], validator: (sample: any) => boolean): boolean => {
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

// Performance Testing Utilities
export const performance = {
  measure: async <T>(
    fn: () => T | Promise<T>,
  ): Promise<{ result: T; duration: number }> => {
    const start = Date.now();
    const result = await fn();
    const duration = Date.now() - start;
    return { result, duration };
  },

  measureMemory: (fn: () => void): number => {
    if (globalThis.gc) {
      globalThis.gc();
    }
    const before = process.memoryUsage().heapUsed;
    fn();
    const after = process.memoryUsage().heapUsed;
    return after - before;
  },

  benchmark: async (
    _name: string,
    fn: () => any,
    iterations = 100,
  ): Promise<{ mean: number; min: number; max: number }> => {
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      await fn();
      const duration = Date.now() - start;
      times.push(duration);
    }

    return {
      mean: times.reduce((a, b) => a + b, 0) / times.length,
      min: Math.min(...times),
      max: Math.max(...times),
    };
  },
};

// Test Data Generators
export const generate = {
  samples: <T>(schema: JSONSchema7, count = 10, options?: any): T[] => {
    return Array.from({ length: count }, () =>
      generateFromSchema({ schema, ...options }),
    );
  },

  withSeed: (schema: JSONSchema7, _seed?: number): any => {
    // Note: faker.js doesn't support seeding in the same way,
    // but we can at least ensure consistent test behavior
    return generateFromSchema({ schema });
  },
};

// Statistical Analysis
export const stats = {
  distribution: (samples: any[]): Map<any, number> => {
    const dist = new Map<any, number>();
    for (const sample of samples) {
      const key = JSON.stringify(sample);
      dist.set(key, (dist.get(key) || 0) + 1);
    }
    return dist;
  },

  entropy: (samples: any[]): number => {
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
  expectValid: (schema: JSONSchema7): void => {
    expect(() => generateFromSchema({ schema })).not.toThrow();
  },

  expectInvalid: (schema: any, errorMessage?: string | RegExp): void => {
    if (errorMessage) {
      expect(() => generateFromSchema({ schema })).toThrow(errorMessage);
    } else {
      expect(() => generateFromSchema({ schema })).toThrow();
    }
  },

  expectSchemaError: (schema: any, path: string, issue?: string): void => {
    try {
      generateFromSchema({ schema });
      throw new Error("Expected schema validation to fail");
    } catch (error: any) {
      expect(error.name).toBe("SchemaValidationError");
      // The schemaPath is in the context
      if (error.context?.schemaPath) {
        expect(error.context.schemaPath).toBe(path);
      }
      if (issue) {
        expect(error.message).toContain(issue);
      }
    }
  },
};

// Helper to analyze data characteristics without hardcoding patterns
function analyzeDataCharacteristics(samples: any[]): string {
  if (samples.length === 0) return "empty";

  const first = samples[0];
  const type = typeof first;

  if (type !== "string") return type;

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
