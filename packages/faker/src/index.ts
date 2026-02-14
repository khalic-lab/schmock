/// <reference path="../../core/schmock.d.ts" />

import {
  ResourceLimitError,
  SchemaGenerationError,
  SchemaValidationError,
} from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { MAX_ARRAY_SIZE } from "./constants.js";
import { getJsf } from "./jsf-config.js";
import { applyOverrides, determineArrayCount } from "./overrides.js";
import { enhanceSchemaWithSmartMapping } from "./schema-enhancement.js";
import { validateSchema } from "./validation.js";

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
  // Validate schema immediately when plugin is created
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

  // Validate schema
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

    generated = [];
    for (let i = 0; i < itemCount; i++) {
      let item = getJsf(seed).generate(
        enhanceSchemaWithSmartMapping(itemSchema),
      );
      item = applyOverrides(item, overrides, params, state, query);
      generated.push(item);
    }
  } else {
    // Handle object schemas
    const enhancedSchema = enhanceSchemaWithSmartMapping(schema);
    generated = getJsf(seed).generate(enhancedSchema);
    generated = applyOverrides(generated, overrides, params, state, query);
  }

  return generated;
}
