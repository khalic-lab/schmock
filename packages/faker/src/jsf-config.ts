import { base, en, Faker } from "@faker-js/faker";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import {
  type GenerateOptions,
  generate,
  type JsonSchema,
} from "json-schema-faker";

const MAX_GENERATION_SEED = 2_147_483_647;
type JsfObjectSchema = Exclude<JsonSchema, boolean>;

/**
 * Create isolated faker instance to avoid race conditions.
 * Each generation gets its own faker instance to ensure thread-safety.
 */
export function createFakerInstance(seed?: number) {
  const faker = new Faker({ locale: [en, base] });
  if (seed !== undefined) {
    faker.seed(seed);
  }
  return faker;
}

export function resolveGenerationSeed(seed?: number): number {
  return seed ?? Math.floor(Math.random() * MAX_GENERATION_SEED);
}

export function createSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normalizeDefinitionForJsf(
  definition: JSONSchema7Definition,
): JsonSchema {
  return typeof definition === "boolean"
    ? definition
    : normalizeSchemaForJsf(definition);
}

function normalizeDefinitionMap(
  definitions: Record<string, JSONSchema7Definition>,
): Record<string, JsonSchema> {
  return Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => [
      key,
      normalizeDefinitionForJsf(definition),
    ]),
  );
}

/**
 * json-schema-faker consumes tuple schemas through the 2020-12 `prefixItems`
 * keyword. Convert Draft 7 tuple `items` recursively at the library boundary.
 */
export function normalizeSchemaForJsf(schema: JSONSchema7): JsfObjectSchema {
  const normalized: JsfObjectSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    normalized[key] = value;
  }

  if (schema.properties) {
    normalized.properties = normalizeDefinitionMap(schema.properties);
  }

  if (schema.definitions) {
    normalized.definitions = normalizeDefinitionMap(schema.definitions);
  }

  if (schema.$defs) {
    normalized.$defs = normalizeDefinitionMap(schema.$defs);
  }

  if (schema.patternProperties) {
    normalized.patternProperties = normalizeDefinitionMap(
      schema.patternProperties,
    );
  }

  if (Array.isArray(schema.items)) {
    normalized.prefixItems = schema.items.map(normalizeDefinitionForJsf);
    normalized.items =
      schema.additionalItems === undefined
        ? true
        : normalizeDefinitionForJsf(schema.additionalItems);
    delete normalized.additionalItems;
  } else if (schema.items !== undefined) {
    normalized.items = normalizeDefinitionForJsf(schema.items);
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const definitions = schema[keyword];
    if (definitions) {
      normalized[keyword] = definitions.map(normalizeDefinitionForJsf);
    }
  }

  if (schema.additionalProperties !== undefined) {
    normalized.additionalProperties = normalizeDefinitionForJsf(
      schema.additionalProperties,
    );
  }

  for (const keyword of [
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
  ] as const) {
    const definition = schema[keyword];
    if (definition !== undefined) {
      normalized[keyword] = normalizeDefinitionForJsf(definition);
    }
  }

  if (schema.dependencies) {
    normalized.dependencies = Object.fromEntries(
      Object.entries(schema.dependencies).map(([key, dependency]) => [
        key,
        Array.isArray(dependency)
          ? [...dependency]
          : normalizeDefinitionForJsf(dependency),
      ]),
    );
  }

  return normalized;
}

/**
 * Generate data from a JSON schema using json-schema-faker 0.6.0 async API.
 * Stateless — each call is self-contained with its own faker instance and options.
 */
export async function generateWithJsf(
  schema: JSONSchema7,
  seed: number,
): Promise<unknown> {
  const options: GenerateOptions = {
    seed,
    optionalsProbability: 1.0,
    alwaysFakeOptionals: true,
    useDefaultValue: true,
    failOnInvalidTypes: false,
    extensions: { faker: createFakerInstance(seed) },
  };

  return generate(normalizeSchemaForJsf(schema), options);
}
