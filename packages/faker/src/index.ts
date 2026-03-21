/// <reference path="../../core/schmock.d.ts" />

import {
  ResourceLimitError,
  SchemaGenerationError,
  SchemaValidationError,
} from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { MAX_ARRAY_SIZE, NULLABLE_NULL_PROBABILITY } from "./constants.js";
import { getJsf } from "./jsf-config.js";
import { applyOverrides, determineArrayCount } from "./overrides.js";
import { enhanceSchemaWithSmartMapping } from "./schema-enhancement.js";
import { isJSONSchema7, validateSchema } from "./validation.js";

export interface SchemaGenerationContext {
  schema: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
  params?: Record<string, string>;
  state?: any;
  query?: Record<string, string>;
  seed?: number;
}

export interface FakerPluginOptions {
  schema: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
  seed?: number;
}

export function fakerPlugin(options: FakerPluginOptions): Schmock.Plugin {
  // Validate schema immediately when plugin is created (fail-fast)
  validateSchema(options.schema);

  return {
    name: "faker",
    version: "1.0.1",

    process(context: Schmock.PluginContext, response?: any) {
      // If response already exists, pass it through
      if (response !== undefined && response !== null) {
        return { context, response };
      }

      try {
        const generatedResponse = generateFromSchema({
          schema: options.schema,
          count: options.count,
          overrides: options.overrides,
          params: context.params,
          state: context.routeState,
          query: context.query,
          seed: options.seed,
        });

        return {
          context,
          response: generatedResponse,
        };
      } catch (error) {
        // Re-throw schema-specific errors as-is
        if (
          error instanceof SchemaValidationError ||
          error instanceof ResourceLimitError
        ) {
          throw error;
        }

        // Wrap other errors
        throw new SchemaGenerationError(
          context.path,
          error instanceof Error ? error : new Error(String(error)),
          options.schema,
        );
      }
    },
  };
}

export function generateFromSchema(options: SchemaGenerationContext): any {
  const { schema, count, overrides, params, state, query, seed } = options;

  validateSchema(schema);

  let generated: any;

  // Handle array schemas with count
  if (schema.type === "array" && schema.items) {
    const itemCount = determineArrayCount(schema, count);

    // Check for resource limits
    if (itemCount > MAX_ARRAY_SIZE) {
      throw new ResourceLimitError("array_size", MAX_ARRAY_SIZE, itemCount);
    }

    const rawItemSchema = Array.isArray(schema.items)
      ? schema.items[0]
      : schema.items;

    if (!rawItemSchema || typeof rawItemSchema === "boolean") {
      throw new SchemaValidationError(
        "$.items",
        "Array schema must have valid items definition",
      );
    }

    const itemSchema = rawItemSchema;
    const enhancedItemSchema = enhanceSchemaWithSmartMapping(itemSchema);

    generated = [];
    for (let i = 0; i < itemCount; i++) {
      let item = getJsf(seed).generate(enhancedItemSchema);
      item = postProcessGenerated(item, enhancedItemSchema);
      item = applyOverrides(item, overrides, params, state, query);
      generated.push(item);
    }
  } else {
    // Handle object schemas
    const enhancedSchema = enhanceSchemaWithSmartMapping(schema);
    generated = getJsf(seed).generate(enhancedSchema);
    generated = postProcessGenerated(generated, enhancedSchema);
    generated = applyOverrides(generated, overrides, params, state, query);
  }

  return generated;
}

/**
 * Post-process generated data to apply nullable probability and boolean weighting.
 * Walks the schema and generated data in parallel, applying:
 * - schmockNullable: ~5% chance of null
 * - schmockTrueProbability: weighted boolean generation
 */
function postProcessGenerated(data: any, schema: JSONSchema7): any {
  if (
    data === null ||
    data === undefined ||
    !schema ||
    typeof schema !== "object"
  ) {
    return data;
  }

  const schemaAny = schema as Record<string, unknown>;

  // Apply nullable probability at this level
  if (schemaAny.schmockNullable === true) {
    if (Math.random() < NULLABLE_NULL_PROBABILITY) {
      return null;
    }
  }

  // Apply boolean weighting at this level
  if (
    schema.type === "boolean" &&
    typeof schemaAny.schmockTrueProbability === "number"
  ) {
    return Math.random() < schemaAny.schmockTrueProbability;
  }

  // Recurse into object properties
  if (typeof data === "object" && !Array.isArray(data) && schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in data && isJSONSchema7(propSchema)) {
        data[key] = postProcessGenerated(data[key], propSchema);
      }
    }
  }

  // Recurse into array items
  if (Array.isArray(data) && schema.items && isJSONSchema7(schema.items)) {
    for (let i = 0; i < data.length; i++) {
      data[i] = postProcessGenerated(data[i], schema.items);
    }
  }

  return data;
}
