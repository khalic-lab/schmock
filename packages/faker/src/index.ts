import type * as Schmock from "@schmock/core";
import {
  ResourceLimitError,
  SchemaGenerationError,
  SchemaValidationError,
} from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { version as packageVersion } from "../package.json";
import { MAX_ARRAY_SIZE, NULLABLE_NULL_PROBABILITY } from "./constants.js";
import {
  createSeededRandom,
  DETERMINISTIC_REF_DATE,
  generateWithJsf,
  resolveGenerationSeed,
} from "./jsf-config.js";
import { applyOverrides, determineArrayCount } from "./overrides.js";
import { enhanceSchemaWithSmartMapping } from "./schema-enhancement.js";
import { hasType, isJSONSchema7, validateSchema } from "./validation.js";

export type SchemaGenerationContext = Schmock.SchemaGenerationContext;

export type FakerPluginOptions = Schmock.FakerPluginOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fakerPlugin(options: FakerPluginOptions): Schmock.Plugin {
  // Validate schema immediately when plugin is created (fail-fast)
  validateSchema(options.schema);

  return {
    name: "faker",
    version: packageVersion,

    async process(context: Schmock.PluginContext, response?: unknown) {
      // If response already exists, pass it through
      if (response !== undefined && response !== null) {
        return { context, response };
      }

      try {
        const generatedResponse = await generateFromSchema({
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

export async function generateFromSchema(
  options: SchemaGenerationContext,
): Promise<unknown> {
  const { schema, count, overrides, params, state, query, seed } = options;

  validateSchema(schema);

  const generationSeed = resolveGenerationSeed(seed);
  const random = createSeededRandom(generationSeed);

  let enhancedSchema = enhanceSchemaWithSmartMapping(schema);

  // Resolve the top-level array size once, then let JSF generate the complete
  // array so tuple positions, uniqueness, and a seeded sequence are preserved.
  if (hasType(schema, "array") && schema.items) {
    const itemCount = determineArrayCount(schema, count, random);

    if (itemCount > MAX_ARRAY_SIZE) {
      throw new ResourceLimitError("array_size", MAX_ARRAY_SIZE, itemCount);
    }

    enhancedSchema = {
      ...enhancedSchema,
      minItems: itemCount,
      maxItems: itemCount,
    };
  }

  // A caller-supplied seed promises reproducible output, so date fields are
  // anchored to a fixed reference date instead of the wall clock. Unseeded
  // generation stays wall-clock relative (`date.future` must stay in the future).
  let generated: unknown = await generateWithJsf(
    enhancedSchema,
    generationSeed,
    seed !== undefined ? DETERMINISTIC_REF_DATE : undefined,
  );
  generated = postProcessGenerated(generated, enhancedSchema, random);

  if (Array.isArray(generated)) {
    return generated.map((item) =>
      applyOverrides(item, overrides, params, state, query),
    );
  }

  generated = applyOverrides(generated, overrides, params, state, query);
  return generated;
}

/**
 * Post-process generated data to apply nullable probability and boolean weighting.
 * Walks the schema and generated data in parallel, applying:
 * - schmockNullable: ~5% chance of null
 * - schmockTrueProbability: weighted boolean generation
 */
function postProcessGenerated(
  data: unknown,
  schema: JSONSchema7,
  random: () => number,
): unknown {
  if (
    data === null ||
    data === undefined ||
    !schema ||
    typeof schema !== "object"
  ) {
    return data;
  }

  // Apply nullable probability at this level
  if ("schmockNullable" in schema && schema.schmockNullable === true) {
    if (random() < NULLABLE_NULL_PROBABILITY) {
      return null;
    }
  }

  // Apply boolean weighting at this level
  if (
    schema.type === "boolean" &&
    "schmockTrueProbability" in schema &&
    typeof schema.schmockTrueProbability === "number"
  ) {
    return random() < schema.schmockTrueProbability;
  }

  // Recurse into object properties
  if (isRecord(data) && schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in data && isJSONSchema7(propSchema)) {
        data[key] = postProcessGenerated(data[key], propSchema, random);
      }
    }
  }

  // Recurse into array items
  if (Array.isArray(data) && Array.isArray(schema.items)) {
    for (let index = 0; index < data.length; index++) {
      const itemSchema = schema.items[index];
      if (itemSchema && isJSONSchema7(itemSchema)) {
        data[index] = postProcessGenerated(data[index], itemSchema, random);
      }
    }
  } else if (
    Array.isArray(data) &&
    schema.items &&
    isJSONSchema7(schema.items)
  ) {
    for (let index = 0; index < data.length; index++) {
      data[index] = postProcessGenerated(data[index], schema.items, random);
    }
  }

  return data;
}
