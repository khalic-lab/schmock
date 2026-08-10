import { base, en, Faker } from "@faker-js/faker";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import {
  type GenerateOptions,
  generate,
  type JsonSchema,
} from "json-schema-faker";
import { DETERMINISTIC_REF_DATE, JSF_MAX_DEPTH } from "./constants.js";

// Re-exported here because this module owns the seeded-generation contract the
// constant serves; `constants.ts` is its home.
export { DETERMINISTIC_REF_DATE };

const MAX_GENERATION_SEED = 2_147_483_647;
type JsfObjectSchema = Exclude<JsonSchema, boolean>;

/**
 * Create isolated faker instance to avoid race conditions.
 * Each generation gets its own faker instance to ensure thread-safety.
 *
 * @param refDate - Anchors faker's relative date methods. Supplied for seeded
 *   generation so `date.recent`/`date.future` reproduce; omitted otherwise, so
 *   unseeded output stays wall-clock relative.
 */
export function createFakerInstance(seed?: number, refDate?: string) {
  const faker = new Faker({ locale: [en, base] });
  if (seed !== undefined) {
    faker.seed(seed);
  }
  if (refDate !== undefined) {
    faker.setDefaultRefDate(refDate);
  }
  return faker;
}

/**
 * Deep-copy a value away from whoever owns it.
 *
 * `structuredClone` alone is not enough: it preserves the input's object
 * graph, so two array items generated from one shared sub-schema stay aliased
 * and mutating one changes the other. Walking plain objects and arrays breaks
 * that sharing; exotic values (Map, Set, RegExp, class instances) have no
 * structure to walk and fall back to `structuredClone`, then to the value
 * itself when even that fails.
 */
function cloneOwnedValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) {
    // Self-referential input: stop rather than recurse forever.
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  const prototype = Object.getPrototypeOf(value);
  const isPlainObject = prototype === Object.prototype || prototype === null;
  if (!Array.isArray(value) && !isPlainObject) {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => cloneOwnedValue(entry, ancestors));
    }
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // defineProperty, not assignment: a literal "__proto__" key in a schema
      // default must stay data instead of reaching the prototype setter.
      Object.defineProperty(copy, key, {
        value: cloneOwnedValue(entry, ancestors),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Detach a value from its owner so mutating it cannot reach the owner.
 *
 * Returns `unknown` rather than echoing the input type: a clone of a class
 * instance may come back as a plain object (see the `structuredClone`
 * fallback), so promising the caller its own type back would be a lie.
 */
export function cloneOwned(value: unknown): unknown {
  return cloneOwnedValue(value, new Set());
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
  refDate?: string,
): Promise<unknown> {
  const options: GenerateOptions = {
    seed,
    // json-schema-faker defaults to 5, which silently drops required
    // properties below that depth. `JSF_MAX_DEPTH` is derived from
    // `MAX_NESTING_DEPTH` (constants.ts) and is itself the only bound on how
    // deep a generated body can get: `validateSchema`'s schema-node and
    // generated-node budgets bound the schema-side walk and the estimated
    // output of the schema as written, but they never resolve `$ref`, so a
    // `$defs` subtree that references itself is bounded by this option alone.
    maxDepth: JSF_MAX_DEPTH,
    optionalsProbability: 1.0,
    alwaysFakeOptionals: true,
    useDefaultValue: true,
    failOnInvalidTypes: false,
    // Start from the built-in formats only: json-schema-faker's format
    // registry is module-global, so a consumer's own registration would
    // otherwise change Schmock's generation.
    formats: {},
    extensions: { faker: createFakerInstance(seed, refDate) },
  };

  // Cloned on the way out so nothing generated stays aliased to the schema, to
  // json-schema-faker's internals, or to a sibling item built from the same
  // sub-schema.
  return cloneOwned(await generate(normalizeSchemaForJsf(schema), options));
}
