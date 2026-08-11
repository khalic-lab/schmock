import { base, en, Faker } from "@faker-js/faker";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import {
  type GenerateOptions,
  generate,
  type JsonSchema,
} from "json-schema-faker-private";
import { DETERMINISTIC_REF_DATE, JSF_MAX_DEPTH } from "./constants.js";
import { assertOutputWithinLimits } from "./output-limits.js";

// Re-exported here because this module owns the seeded-generation contract the
// constant serves; `constants.ts` is its home.
export { DETERMINISTIC_REF_DATE };

const MAX_GENERATION_SEED = 2_147_483_647;
type JsfObjectSchema = Exclude<JsonSchema, boolean>;

/**
 * Keywords Schmock deliberately hands to json-schema-faker. Unknown keywords
 * are annotations in JSON Schema, but JSF also treats them as hooks into its
 * module-global `define()` registry. Removing them at this boundary keeps a
 * consumer registration from changing Schmock output without mutating that
 * consumer's registry.
 */
const JSF_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "definitions",
  "type",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "autoIncrement",
  "initialOffset",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "items",
  "prefixItems",
  "additionalItems",
  "contains",
  "containsAll",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "default",
  "examples",
  "description",
  "title",
  "readOnly",
  "writeOnly",
  "deprecated",
  "faker",
  "chance",
  "jsonPath",
  "template",
  "example",
]);

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

function cloneSnapshotValue(
  value: unknown,
  clones: Map<object, unknown>,
): unknown {
  if (value === null || typeof value !== "object") return value;

  const existing = clones.get(value);
  if (existing !== undefined) return existing;

  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    clones.set(value, copy);
    return copy;
  }
  if (value instanceof RegExp) {
    const copy = new RegExp(value.source, value.flags);
    copy.lastIndex = value.lastIndex;
    clones.set(value, copy);
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    clones.set(value, copy);
    for (const [key, entry] of value) {
      copy.set(
        cloneSnapshotValue(key, clones),
        cloneSnapshotValue(entry, clones),
      );
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    clones.set(value, copy);
    for (const entry of value) copy.add(cloneSnapshotValue(entry, clones));
    return copy;
  }
  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    clones.set(value, copy);
    return copy;
  }
  if (ArrayBuffer.isView(value)) {
    const copy = structuredClone(value);
    clones.set(value, copy);
    return copy;
  }
  if (value instanceof URL) {
    const copy = new URL(value.href);
    clones.set(value, copy);
    return copy;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    clones.set(value, copy);
    for (let index = 0; index < value.length; index += 1) {
      if (Object.hasOwn(value, index)) {
        copy[index] = cloneSnapshotValue(value[index], clones);
      }
    }
    return copy;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Opaque Faker arguments (including callback-support objects) retain their
    // identity rather than being corrupted by a lossy generic clone.
    return value;
  }

  const copy: Record<string, unknown> = Object.create(prototype);
  clones.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: cloneSnapshotValue(entry, clones),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

/** Clone related option graphs together while retaining aliases and callbacks. */
export function snapshotGraphs(values: readonly unknown[]): unknown[] {
  const clones = new Map<object, unknown>();
  return values.map((value) => cloneSnapshotValue(value, clones));
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
  normalizedSchemas: Map<JSONSchema7, JsfObjectSchema>,
): JsonSchema {
  return typeof definition === "boolean"
    ? definition
    : normalizeSchemaNodeForJsf(definition, normalizedSchemas);
}

function normalizeUnknownDefinitionForJsf(
  definition: unknown,
  normalizedSchemas: Map<JSONSchema7, JsfObjectSchema>,
): JsonSchema | undefined {
  if (typeof definition === "boolean") return definition;
  return isSchemaObject(definition)
    ? normalizeSchemaNodeForJsf(definition, normalizedSchemas)
    : undefined;
}

function isSchemaObject(value: unknown): value is JSONSchema7 {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeDefinitionMap(
  definitions: Record<string, JSONSchema7Definition>,
  normalizedSchemas: Map<JSONSchema7, JsfObjectSchema>,
): Record<string, JsonSchema> {
  return Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => [
      key,
      normalizeDefinitionForJsf(definition, normalizedSchemas),
    ]),
  );
}

/**
 * json-schema-faker consumes tuple schemas through the 2020-12 `prefixItems`
 * keyword. Convert Draft 7 tuple `items` recursively at the library boundary.
 */
export function normalizeSchemaForJsf(schema: JSONSchema7): JsfObjectSchema {
  return normalizeSchemaNodeForJsf(schema, new Map());
}

function normalizeSchemaNodeForJsf(
  schema: JSONSchema7,
  normalizedSchemas: Map<JSONSchema7, JsfObjectSchema>,
): JsfObjectSchema {
  const existing = normalizedSchemas.get(schema);
  if (existing) return existing;

  const normalized: JsfObjectSchema = {};
  normalizedSchemas.set(schema, normalized);
  for (const [key, value] of Object.entries(schema)) {
    if (JSF_SCHEMA_KEYWORDS.has(key)) {
      normalized[key] = value;
    }
  }

  if (schema.properties) {
    normalized.properties = normalizeDefinitionMap(
      schema.properties,
      normalizedSchemas,
    );
  }

  if (schema.definitions) {
    normalized.definitions = normalizeDefinitionMap(
      schema.definitions,
      normalizedSchemas,
    );
  }

  if (schema.$defs) {
    normalized.$defs = normalizeDefinitionMap(schema.$defs, normalizedSchemas);
  }

  if (schema.patternProperties) {
    normalized.patternProperties = normalizeDefinitionMap(
      schema.patternProperties,
      normalizedSchemas,
    );
  }

  if (Array.isArray(schema.items)) {
    normalized.prefixItems = schema.items.map((definition) =>
      normalizeDefinitionForJsf(definition, normalizedSchemas),
    );
    normalized.items =
      schema.additionalItems === undefined
        ? true
        : normalizeDefinitionForJsf(schema.additionalItems, normalizedSchemas);
    delete normalized.additionalItems;
  } else if (schema.items !== undefined) {
    normalized.items = normalizeDefinitionForJsf(
      schema.items,
      normalizedSchemas,
    );
    if (schema.additionalItems !== undefined) {
      normalized.additionalItems = normalizeDefinitionForJsf(
        schema.additionalItems,
        normalizedSchemas,
      );
    }
  }

  const prefixItems = Reflect.get(schema, "prefixItems");
  if (!Array.isArray(schema.items) && Array.isArray(prefixItems)) {
    normalized.prefixItems = prefixItems.flatMap((definition) => {
      const normalizedDefinition = normalizeUnknownDefinitionForJsf(
        definition,
        normalizedSchemas,
      );
      return normalizedDefinition === undefined ? [] : [normalizedDefinition];
    });
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const definitions = schema[keyword];
    if (definitions) {
      normalized[keyword] = definitions.map((definition) =>
        normalizeDefinitionForJsf(definition, normalizedSchemas),
      );
    }
  }

  if (schema.additionalProperties !== undefined) {
    normalized.additionalProperties = normalizeDefinitionForJsf(
      schema.additionalProperties,
      normalizedSchemas,
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
      normalized[keyword] = normalizeDefinitionForJsf(
        definition,
        normalizedSchemas,
      );
    }
  }

  if (schema.dependencies) {
    normalized.dependencies = Object.fromEntries(
      Object.entries(schema.dependencies).map(([key, dependency]) => [
        key,
        Array.isArray(dependency)
          ? [...dependency]
          : normalizeDefinitionForJsf(dependency, normalizedSchemas),
      ]),
    );
  }

  const contentSchema = normalizeUnknownDefinitionForJsf(
    Reflect.get(schema, "contentSchema"),
    normalizedSchemas,
  );
  if (contentSchema !== undefined) normalized.contentSchema = contentSchema;

  const dependentSchemas = Reflect.get(schema, "dependentSchemas");
  if (
    dependentSchemas !== null &&
    typeof dependentSchemas === "object" &&
    !Array.isArray(dependentSchemas)
  ) {
    normalized.dependentSchemas = Object.fromEntries(
      Object.entries(dependentSchemas).flatMap(([key, definition]) => {
        const normalizedDefinition = normalizeUnknownDefinitionForJsf(
          definition,
          normalizedSchemas,
        );
        return normalizedDefinition === undefined
          ? []
          : [[key, normalizedDefinition]];
      }),
    );
  }

  const containsAll = Reflect.get(schema, "containsAll");
  if (Array.isArray(containsAll)) {
    normalized.containsAll = containsAll.flatMap((definition) => {
      const normalizedDefinition = normalizeUnknownDefinitionForJsf(
        definition,
        normalizedSchemas,
      );
      return normalizedDefinition === undefined ? [] : [normalizedDefinition];
    });
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
    // deep a generated body can get. Validation resolves indexed schema refs
    // and rejects cycles, while this remains defense in depth for JSF's
    // separate internal depth counter and references it resolves by other
    // mechanisms.
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
  const generated = await generate(normalizeSchemaForJsf(schema), options);
  assertOutputWithinLimits(generated);
  return cloneOwned(generated);
}
