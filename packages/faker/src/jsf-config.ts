import { base, en, Faker } from "@faker-js/faker";
import type { JSONSchema7 } from "json-schema";
import {
  type GenerateOptions,
  generate,
  generateSync,
  type JsonSchema,
  type Random,
} from "json-schema-faker-private";
import { DETERMINISTIC_REF_DATE, JSF_MAX_DEPTH } from "./constants.js";
import { assertOutputWithinLimits } from "./output-limits.js";
import { mapSchemaChildren, type SchemaChildSlot } from "./schema-children.js";
import { compilePattern, isJSONSchema7 } from "./utils.js";

// Re-exported here because this module owns the seeded-generation contract the
// constant serves; `constants.ts` is its home.
export { DETERMINISTIC_REF_DATE };

const MAX_GENERATION_SEED = 2_147_483_647;
type JsfObjectSchema = Exclude<JsonSchema, boolean>;

/**
 * State shared by one normalization pass. `patternKeySeed` is set only when
 * normalizing for generation: it seeds the keys invented for
 * `patternProperties`, so without it no keys are invented and the output
 * depends on the schema alone.
 */
interface NormalizeContext {
  normalizedSchemas: Map<JSONSchema7, JsfObjectSchema>;
  patternKeySeed?: number;
  patternKeyCount: number;
}

export interface NormalizeSchemaOptions {
  /** Seed for the keys generated to satisfy `patternProperties`. */
  patternKeySeed?: number;
}

/**
 * json-schema-faker draws numbers from [-1000, 1000] and replaces only the side
 * a schema declares, so a lone `minimum: 1900` becomes the inverted range
 * [1900, 1000] and every value lands below the minimum.
 */
const JSF_DEFAULT_NUMBER_BOUND = 1000;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * json-schema-faker has no generator for OpenAPI's `byte` format and emits a
 * word whose length is rarely a multiple of four, which ajv-formats rejects.
 * Encode 1-48 seeded random bytes as padded base64 instead.
 */
function generateBase64(random: Random): string {
  const bytes = Array.from({ length: random.int(1, 48) }, () =>
    random.int(0, 255),
  );
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const chunk =
      (bytes[index] << 16) |
      ((remaining > 1 ? bytes[index + 1] : 0) << 8) |
      (remaining > 2 ? bytes[index + 2] : 0);
    encoded += BASE64_ALPHABET[(chunk >> 18) & 63];
    encoded += BASE64_ALPHABET[(chunk >> 12) & 63];
    encoded += remaining > 1 ? BASE64_ALPHABET[(chunk >> 6) & 63] : "=";
    encoded += remaining > 2 ? BASE64_ALPHABET[chunk & 63] : "=";
  }
  return encoded;
}

/**
 * Formats Schmock generates itself, passed per call so json-schema-faker's
 * module-global registry is never touched.
 */
const SCHMOCK_FORMATS: Readonly<Record<string, (random: Random) => string>> = {
  byte: generateBase64,
};

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

/** Keywords whose list entries are matched to array items by position. */
const POSITIONAL_KEYWORDS = new Set(["items", "prefixItems"]);

/**
 * The JSF copy of one child entry. Boolean schemas pass through, schema objects
 * are normalized, and a `dependencies` property list is copied. Any other entry
 * is malformed. In a positional list (a tuple `items`, `prefixItems`) it
 * becomes `true`, so every later position keeps its schema; elsewhere it is
 * dropped from a list or map, and a single-schema keyword keeps its raw copy.
 * `validateSchema` rejects malformed positional entries; this keeps the walker
 * aligned when it is called on its own.
 */
function normalizeChildForJsf(
  child: unknown,
  slot: SchemaChildSlot,
  context: NormalizeContext,
): JsonSchema | string[] | undefined {
  if (typeof child === "boolean") return child;
  if (isJSONSchema7(child)) return normalizeSchemaNodeForJsf(child, context);
  if (slot.keyword === "dependencies" && Array.isArray(child)) {
    return [...child];
  }
  if (slot.location.form === "array" && POSITIONAL_KEYWORDS.has(slot.keyword)) {
    return true;
  }
  return undefined;
}

/**
 * The schema the child walk reads, without the keywords json-schema-faker
 * would misread. A Draft-7 tuple (`items` as a list) ignores a native
 * `prefixItems`, since the tuple becomes the `prefixItems`. `additionalItems`
 * without `items` constrains nothing, so it keeps its raw copy.
 */
function jsfTraversalView(schema: JSONSchema7): JSONSchema7 {
  if (Array.isArray(schema.items)) {
    if (Reflect.get(schema, "prefixItems") === undefined) return schema;
    const view = { ...schema };
    Reflect.deleteProperty(view, "prefixItems");
    return view;
  }
  if (schema.items === undefined && schema.additionalItems !== undefined) {
    const view = { ...schema };
    Reflect.deleteProperty(view, "additionalItems");
    return view;
  }
  return schema;
}

/** Where a Draft-7 tuple's keywords land in the 2020-12 form JSF reads. */
const TUPLE_TARGETS: Readonly<Record<string, string>> = {
  items: "prefixItems",
  additionalItems: "items",
};

/**
 * json-schema-faker consumes tuple schemas through the 2020-12 `prefixItems`
 * keyword. Convert Draft 7 tuple `items` recursively at the library boundary.
 */
export function normalizeSchemaForJsf(
  schema: JSONSchema7,
  options: NormalizeSchemaOptions = {},
): JsfObjectSchema {
  return normalizeSchemaNodeForJsf(schema, {
    normalizedSchemas: new Map(),
    patternKeySeed: options.patternKeySeed,
    patternKeyCount: 0,
  });
}

function normalizeSchemaNodeForJsf(
  schema: JSONSchema7,
  context: NormalizeContext,
): JsfObjectSchema {
  const existing = context.normalizedSchemas.get(schema);
  if (existing) return existing;

  const normalized: JsfObjectSchema = {};
  context.normalizedSchemas.set(schema, normalized);
  for (const [key, value] of Object.entries(schema)) {
    if (JSF_SCHEMA_KEYWORDS.has(key)) {
      normalized[key] = value;
    }
  }
  closeLoneNumericBound(schema, normalized);

  // Bespoke pre-step: a Draft-7 tuple's list becomes `prefixItems`, and its
  // `additionalItems` becomes `items` (`true` when absent or malformed).
  const tuple = Array.isArray(schema.items);
  if (tuple) {
    normalized.items = true;
    delete normalized.additionalItems;
  }

  const children = mapSchemaChildren(jsfTraversalView(schema), (child, slot) =>
    normalizeChildForJsf(child, slot, context),
  );
  for (const { keyword, value } of children) {
    normalized[tuple ? (TUPLE_TARGETS[keyword] ?? keyword) : keyword] = value;
    // Pattern keys are invented here, before the walk descends into `items`
    // and later keywords, so the seed each one draws stays where it was.
    if (keyword === "patternProperties" && normalized.patternProperties) {
      addPatternPropertyKeys({
        schema,
        normalized,
        patternProperties: normalized.patternProperties,
        context,
      });
    }
  }

  return normalized;
}

/** Lower and upper numeric bounds, from the inclusive or numeric exclusive form. */
function numericBound(
  inclusive: unknown,
  exclusive: unknown,
  pick: (left: number, right: number) => number,
): number | undefined {
  const bounds = [inclusive, exclusive].filter(
    (bound): bound is number => typeof bound === "number",
  );
  if (bounds.length === 0) return undefined;
  return bounds.reduce(pick);
}

/**
 * Give a lone bound past json-schema-faker's default range a finite partner, so
 * the range it draws from is not inverted. Only the JSF copy changes; schemas
 * with `multipleOf` take a separate JSF path that already honours the bound.
 */
function closeLoneNumericBound(
  schema: JSONSchema7,
  normalized: JsfObjectSchema,
): void {
  if (schema.multipleOf !== undefined) return;
  const lower = numericBound(schema.minimum, schema.exclusiveMinimum, Math.max);
  const upper = numericBound(schema.maximum, schema.exclusiveMaximum, Math.min);
  if (
    lower !== undefined &&
    upper === undefined &&
    lower >= JSF_DEFAULT_NUMBER_BOUND
  ) {
    normalized.maximum = lower + JSF_DEFAULT_NUMBER_BOUND;
  } else if (
    upper !== undefined &&
    lower === undefined &&
    upper <= -JSF_DEFAULT_NUMBER_BOUND
  ) {
    normalized.minimum = upper - JSF_DEFAULT_NUMBER_BOUND;
  }
}

interface PatternKeyRequest {
  schema: JSONSchema7;
  normalized: JsfObjectSchema;
  patternProperties: Record<string, JsonSchema>;
  context: NormalizeContext;
}

/** Tries per invented key before a pattern is given up on. */
const PATTERN_KEY_ATTEMPTS = 8;

/** A string matching `pattern` from JSF's own regex generator, if it can. */
function generatePatternKey(pattern: string, seed: number): string | undefined {
  try {
    const generated = generateSync({ type: "string", pattern }, { seed });
    return typeof generated === "string" ? generated : undefined;
  } catch {
    // A pattern JSF cannot generate from gets no invented key.
    return undefined;
  }
}

/**
 * json-schema-faker never emits a key that matches `patternProperties`: a
 * pattern-keyed map comes out empty, and when `minProperties` forces extra keys
 * it invents ones that match no pattern, which `additionalProperties: false`
 * then forbids. Declare seeded keys that match exactly one pattern as ordinary
 * properties, enough to reach `minProperties` (at least one) without passing
 * `maxProperties`, so JSF generates each value from its pattern's schema.
 */
function addPatternPropertyKeys(request: PatternKeyRequest): void {
  const { schema, normalized, patternProperties, context } = request;
  const seed = context.patternKeySeed;
  if (seed === undefined) return;

  const patterns = Object.keys(patternProperties).flatMap((source) => {
    const regex = compilePattern(source);
    return regex ? [{ source, regex }] : [];
  });
  if (patterns.length === 0) return;

  const properties: Record<string, JsonSchema> = {
    ...(isJSONSchema7(normalized.properties) ? normalized.properties : {}),
  };
  const declared = Object.keys(properties).length;
  const wanted = Math.max(1, (schema.minProperties ?? 0) - declared);
  const room =
    schema.maxProperties === undefined
      ? wanted
      : Math.max(0, schema.maxProperties - declared);
  const target = Math.min(wanted, room);

  const added: string[] = [];
  for (let slot = 0; slot < target; slot += 1) {
    const { source } = patterns[slot % patterns.length];
    for (let attempt = 0; attempt < PATTERN_KEY_ATTEMPTS; attempt += 1) {
      context.patternKeyCount += 1;
      const generated = generatePatternKey(
        source,
        (seed + context.patternKeyCount * 7919) % MAX_GENERATION_SEED,
      );
      if (generated === undefined) break;
      // A pattern with no end anchor ("^x_") yields one string; a suffix keeps
      // later keys distinct while still matching.
      const key = attempt === 0 ? generated : `${generated}${attempt}`;
      const matching = patterns.filter((pattern) => pattern.regex.test(key));
      if (
        Object.hasOwn(properties, key) ||
        matching.length !== 1 ||
        matching[0].source !== source
      ) {
        continue;
      }
      Object.defineProperty(properties, key, {
        value: patternProperties[source],
        writable: true,
        enumerable: true,
        configurable: true,
      });
      added.push(key);
      break;
    }
  }
  if (added.length === 0) return;

  normalized.properties = properties;
  normalized.required = [
    ...(Array.isArray(normalized.required) ? normalized.required : []),
    ...added,
  ];
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
    // Start from the built-in formats plus Schmock's own: json-schema-faker's
    // format registry is module-global, so a consumer's own registration
    // would otherwise change Schmock's generation.
    formats: { ...SCHMOCK_FORMATS },
    extensions: { faker: createFakerInstance(seed, refDate) },
  };

  // Cloned on the way out so nothing generated stays aliased to the schema, to
  // json-schema-faker's internals, or to a sibling item built from the same
  // sub-schema.
  const generated = await generate(
    normalizeSchemaForJsf(schema, { patternKeySeed: seed }),
    options,
  );
  assertOutputWithinLimits(generated);
  return cloneOwned(generated);
}
