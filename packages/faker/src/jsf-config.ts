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
import { narrowTypeUnion, omittableNotRequired } from "./not-support.js";
import { assertOutputWithinLimits } from "./output-limits.js";
import { resolveLocalRef } from "./post-process.js";
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
  /** JSF copies of nodes whose `faker` the enhancer wrote. */
  inferredFakers: Set<JsfObjectSchema>;
}

/**
 * Set by the enhancer on a node whose `faker` it wrote (a name mapping, the
 * lorem fallback, boolean weighting) rather than the schema. Like the other
 * `schmock` markers it never reaches json-schema-faker; it tells
 * `dropOverriddenFakers` which fakers may yield to a merged constraint.
 */
export const INFERRED_FAKER_MARKER = "schmockInferredFaker";

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

/** Padded base64 comes in blocks of four characters. */
const BASE64_BLOCK = 4;

/** Blocks `generateBase64` emits at most: 48 bytes. */
const BASE64_MAX_BLOCKS = 16;

/**
 * A format generator never sees length bounds: json-schema-faker slices or
 * pads its output afterwards, which breaks padded base64. For a `byte` node
 * with bounds, generate whole blocks from a pattern instead, as many as the
 * bounds allow (at least one, unless only an empty string fits). An
 * unsatisfiable range (`minLength: 5, maxLength: 7`) or a declared `pattern`
 * is left as it is. Only the JSF copy changes.
 */
function boundByteLength(normalized: JsfObjectSchema): void {
  const { format, minLength, maxLength } = normalized;
  if (format !== "byte" || normalized.pattern !== undefined) return;
  if (minLength === undefined && maxLength === undefined) return;
  const fewest = Math.ceil((minLength ?? 0) / BASE64_BLOCK);
  const most =
    maxLength === undefined
      ? fewest + BASE64_MAX_BLOCKS
      : Math.floor(maxLength / BASE64_BLOCK);
  const least = most > 0 ? Math.max(1, fewest) : fewest;
  if (least > most) return;
  normalized.pattern = `^(?:[A-Za-z0-9+/]{${BASE64_BLOCK}}){${least},${most}}$`;
  delete normalized.format;
}

/** ISO 8601 duration units, each with the largest value generated for it. */
const DURATION_DATE_UNITS = [
  ["Y", 10],
  ["M", 11],
  ["D", 30],
] as const;
const DURATION_TIME_UNITS = [
  ["H", 23],
  ["M", 59],
  ["S", 59],
] as const;

function durationPart(
  units: typeof DURATION_DATE_UNITS | typeof DURATION_TIME_UNITS,
  random: Random,
): string {
  return units
    .filter(() => random.bool())
    .map(([unit, most]) => `${random.int(1, most)}${unit}`)
    .join("");
}

/**
 * json-schema-faker writes the `T` of a duration whether or not a time unit
 * follows, and pads an empty one with "0D" after it, so about 7% of its
 * durations ("P1YT", "PT0D") fail ajv-formats. Write `T` only before a time
 * unit, and fall back to a day count when no unit was picked.
 */
function generateDuration(random: Random): string {
  const date = durationPart(DURATION_DATE_UNITS, random);
  const time = durationPart(DURATION_TIME_UNITS, random);
  if (date === "" && time === "") return `P${random.int(1, 30)}D`;
  return `P${date}${time === "" ? "" : `T${time}`}`;
}

/**
 * Formats Schmock generates itself, passed per call so json-schema-faker's
 * module-global registry is never touched.
 */
const SCHMOCK_FORMATS: Readonly<Record<string, (random: Random) => string>> = {
  byte: generateBase64,
  duration: generateDuration,
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
 * keyword. Convert Draft 7 tuple `items` recursively at the library boundary,
 * then adapt every node whose subschemas JSF merges: drop the `faker` a merge
 * would let override another declaration's constraints
 * (`dropMergedPropertyFakers`), reconcile the numeric bounds that meet
 * through `allOf` (`reconcileAllOfBounds`), and restate composition beside
 * `allOf` so the merge carries it (`carryCompositionThroughAllOf`).
 */
export function normalizeSchemaForJsf(
  schema: JSONSchema7,
  options: NormalizeSchemaOptions = {},
): JsfObjectSchema {
  const context: NormalizeContext = {
    normalizedSchemas: new Map(),
    patternKeySeed: options.patternKeySeed,
    patternKeyCount: 0,
    inferredFakers: new Set(),
  };
  const normalized = normalizeSchemaNodeForJsf(schema, context);
  // Only once the walk is complete: resolving a `$ref` mid-walk would
  // normalize its target early and reorder the seeds pattern keys draw.
  const resolve = (member: unknown): JsfObjectSchema | undefined => {
    if (!isJsfObject(member) || typeof member.$ref !== "string") {
      return isJsfObject(member) ? member : undefined;
    }
    const target = resolveLocalRef({ $ref: member.$ref }, schema);
    return target ? context.normalizedSchemas.get(target) : undefined;
  };
  const copies = [...context.normalizedSchemas.values()];
  // Merge groups read the layout as written, so every node is grouped before
  // any node is restated; the members replaced along the way are restated too.
  const state: MergeState = {
    replaced: [],
    inferredFakers: context.inferredFakers,
  };
  for (const copy of copies) dropMergedPropertyFakers(copy, resolve, state);
  // After the fakers are dropped, so the members their groups replaced are
  // the ones whose bounds move; the copies built here are restated below.
  const bounds: BoundsContext = {
    resolve,
    replaced: state.replaced,
    ancestors: new Set(),
  };
  for (const copy of [...copies, ...state.replaced]) {
    reconcileAllOfBounds(copy, bounds);
  }
  for (const copy of [...copies, ...state.replaced]) {
    carryCompositionThroughAllOf(copy, resolve);
    // After the merge pass, which may drop this `faker` and must then leave
    // the `format` in place.
    pinFakerDateToUtc(copy);
    closeLoneNumericBound(copy);
  }
  return normalized;
}

/**
 * For a node with `faker` and `format: "date"`, json-schema-faker turns
 * faker's value into a date with local-time getters, so one seed gave a
 * different calendar date on machines in different time zones. Route the
 * call through `schmock.utcDate` (see `fakerExtension`) instead, which
 * returns the UTC calendar date, and drop the format JSF would reapply.
 */
function pinFakerDateToUtc(copy: JsfObjectSchema): void {
  if (copy.faker === undefined || copy.format !== "date") return;
  copy.faker = { [UTC_DATE_METHOD]: [copy.faker] };
  delete copy.format;
}

/** The `schmock.utcDate` helper's path on the faker extension. */
const UTC_DATE_METHOD = "schmock.utcDate";

/**
 * Call a `faker` keyword's method on `faker`, read the way json-schema-faker
 * reads it: a dotted method path, or an object whose first key is the path
 * and whose value lists the arguments.
 */
function callFakerMethod(faker: Faker, spec: unknown): unknown {
  const [path, args] =
    typeof spec === "string"
      ? [spec, []]
      : isJsfObject(spec)
        ? (Object.entries(spec)[0] ?? ["", []])
        : ["", []];
  let method: unknown = faker;
  for (const part of path.split("."))
    method = Reflect.get(Object(method), part);
  if (typeof method !== "function") {
    throw new Error(`cannot resolve faker method ${path}`);
  }
  return method(...(Array.isArray(args) ? args : []));
}

/** The UTC calendar date of a faker value, or the value as text. */
function utcCalendarDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

/**
 * The UTC calendar date of the faker call `spec`. When the call throws (a
 * method that needs arguments the schema does not give), json-schema-faker
 * would fall back to its default generation, which no longer sees the
 * `format` `pinFakerDateToUtc` dropped. Fall back to a date from the same
 * seeded instance instead, as the `format: date` fallback did.
 */
function utcDateOf(faker: Faker, spec: unknown): string {
  let value: unknown;
  try {
    value = callFakerMethod(faker, spec);
  } catch {
    value = faker.date.anytime();
  }
  return utcCalendarDate(value);
}

/**
 * The `faker` extension handed to json-schema-faker: the per-call Faker
 * instance, with Schmock's own helpers under `schmock`. Only the JSF copy
 * names them; `validateFakerMethod` resolves a schema's methods on a plain
 * instance, so a schema cannot.
 */
function fakerExtension(faker: Faker): Faker {
  const helpers = {
    utcDate: (spec: unknown) => utcDateOf(faker, spec),
  };
  return Object.create(faker, { schmock: { value: helpers } });
}

function isJsfObject(value: unknown): value is JsfObjectSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One schema json-schema-faker merges into a node's value. */
interface MergeMember {
  /** The schema JSF merges, after any `$ref` it resolves first. */
  schema: JsfObjectSchema;
  /** Put `next` in the member's place in the node's copy. */
  replace: (next: JsfObjectSchema) => void;
}

type ResolveMember = (member: unknown) => JsfObjectSchema | undefined;

/** The members of a list keyword (`allOf`, `oneOf`, `anyOf`) of `copy`. */
function listMembers(
  copy: JsfObjectSchema,
  keyword: "allOf" | "oneOf" | "anyOf",
  resolve: ResolveMember,
): MergeMember[] {
  const list = copy[keyword];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry, index) => {
    const schema = resolve(entry);
    if (!schema) return [];
    const replace = (next: JsfObjectSchema) => {
      const current = copy[keyword];
      if (Array.isArray(current)) current[index] = next;
    };
    return [{ schema, replace }];
  });
}

/** The member a single-schema keyword (`if`, `then`, `else`) of `copy` holds. */
function singleMember(
  copy: JsfObjectSchema,
  keyword: "if" | "then" | "else",
): MergeMember | undefined {
  const schema = copy[keyword];
  if (!isJsfObject(schema)) return undefined;
  return {
    schema,
    replace: (next) => {
      copy[keyword] = next;
    },
  };
}

/** What one `dropMergedPropertyFakers` pass reads and records. */
interface MergeState {
  /** Every replacement member, for the passes that restate the copies. */
  replaced: JsfObjectSchema[];
  /** JSF copies whose `faker` the enhancer wrote rather than the schema. */
  inferredFakers: Set<JsfObjectSchema>;
}

/**
 * Group the members json-schema-faker merges into one node's value, in its
 * merge order and in the layout `carryCompositionThroughAllOf` gives the copy:
 * the base with every `allOf` entry, plus one `oneOf`/`anyOf` branch, or plus
 * `if` and `then` (or `else`). Then drop the fakers each merge would let
 * override a constraint; every replacement member is added to
 * `state.replaced`.
 */
function dropMergedPropertyFakers(
  copy: JsfObjectSchema,
  resolve: ResolveMember,
  state: MergeState,
): void {
  // JSF resolves a `$ref` before merging only in `allOf` and `oneOf`; a
  // `$ref` anywhere else replaces the merge, so it has no properties here.
  const allOf = listMembers(copy, "allOf", resolve);
  const branches = [
    ...listMembers(copy, "oneOf", resolve),
    ...listMembers(copy, "anyOf", (entry) =>
      isJsfObject(entry) ? entry : undefined,
    ),
  ];
  const own: MergeMember = {
    schema: copy,
    replace: (next) => {
      copy.properties = next.properties;
    },
  };
  const groups: MergeMember[][] = [];
  if (allOf.length > 0) groups.push([own, ...allOf]);
  for (const branch of branches) groups.push([own, ...allOf, branch]);
  const conditionIf = singleMember(copy, "if");
  const conditionThen = singleMember(copy, "then");
  const conditionElse = singleMember(copy, "else");
  if (conditionIf && (conditionThen || conditionElse)) {
    if (conditionThen || allOf.length > 0) {
      groups.push([
        own,
        conditionIf,
        ...allOf,
        ...(conditionThen ? [conditionThen] : []),
      ]);
    }
    if (conditionElse) groups.push([own, ...allOf, conditionElse]);
  }
  for (const group of groups) dropOverriddenFakers(group, state);
}

/** Most branch combinations a `oneOf`/`anyOf` is restated with. */
const MAX_BRANCH_COMBINATIONS = 64;

/**
 * One branch list whose every branch meets one branch of each list in
 * `lists`, as `{allOf: [...]}`; undefined when that takes more than
 * `MAX_BRANCH_COMBINATIONS` branches.
 */
function combineBranches(lists: JsonSchema[][]): JsonSchema[] | undefined {
  if (lists.length === 1) return lists[0];
  const total = lists.reduce((product, list) => product * list.length, 1);
  if (total > MAX_BRANCH_COMBINATIONS) return undefined;
  let combinations: JsonSchema[][] = [[]];
  for (const list of lists) {
    combinations = combinations.flatMap((picked) =>
      list.map((branch) => [...picked, branch]),
    );
  }
  return combinations.map((picked) => ({ allOf: picked }));
}

/**
 * json-schema-faker merges `allOf` with a base it strips of every other
 * composition keyword, so a sibling `oneOf`/`anyOf` or `if`/`then`/`else` was
 * never generated. Restate them so the `allOf` merge carries them: a sibling
 * `oneOf`/`anyOf` becomes one more `allOf` entry, and an `if` with a `then`
 * or `else` takes the `allOf` into each branch. JSF's oneOf path then
 * generates the base's required properties and the chosen branch's, as it
 * does for any `oneOf`. The merge keeps only the last entry's `oneOf` (or
 * `anyOf`), so when entries already hold one, the added entry lists every
 * combination of their branches with the sibling's instead, up to
 * `MAX_BRANCH_COMBINATIONS`; past that the sibling is left as it is.
 */
function carryCompositionThroughAllOf(
  copy: JsfObjectSchema,
  resolve: ResolveMember,
): void {
  if (!Array.isArray(copy.allOf)) return;
  let entries: JsonSchema[] = copy.allOf;
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = copy[keyword];
    if (!Array.isArray(branches)) continue;
    // JSF resolves an entry's `$ref` before it merges the entry.
    const held = entries.flatMap((entry) => {
      const list = resolve(entry)?.[keyword];
      return Array.isArray(list) ? [list] : [];
    });
    const restated = combineBranches([...held, branches]);
    if (restated === undefined) continue;
    entries = [...entries, { [keyword]: restated }];
    delete copy[keyword];
  }
  copy.allOf = entries;

  if (copy.if === undefined) return;
  if (copy.then === undefined && copy.else === undefined) return;
  // An absent `then` accepts every value the `if` accepts, so the `if`
  // branch can always carry the `allOf`. Reflect.set: `then` is a schema
  // keyword here, not a thenable.
  Reflect.set(copy, "then", {
    allOf: copy.then === undefined ? entries : [...entries, copy.then],
  });
  if (copy.else !== undefined) copy.else = { allOf: [...entries, copy.else] };
  delete copy.allOf;
}

/** Keywords that never change the value json-schema-faker generates. */
const ANNOTATION_KEYWORDS = new Set([
  "title",
  "description",
  "$comment",
  "readOnly",
  "writeOnly",
  "deprecated",
  "examples",
  "example",
  "default",
  "faker",
]);

function propertiesOf(schema: JsfObjectSchema): Record<string, JsonSchema> {
  return isJsfObject(schema.properties) ? schema.properties : {};
}

/** True when merging `declaration` into `first` adds a constraint. */
function addsConstraint(
  declaration: JsonSchema | undefined,
  first: JsfObjectSchema,
): boolean {
  if (!isJsfObject(declaration)) return declaration === false;
  return Object.keys(declaration).some((key) =>
    key === "type"
      ? JSON.stringify(declaration.type) !== JSON.stringify(first.type)
      : !ANNOTATION_KEYWORDS.has(key),
  );
}

/** Put `next` in `member`'s place, recording it as a replacement. */
function replaceMember(
  member: MergeMember,
  next: JsfObjectSchema,
  state: MergeState,
): void {
  if (state.inferredFakers.has(member.schema)) state.inferredFakers.add(next);
  member.replace(next);
  member.schema = next;
  state.replaced.push(next);
}

/** `member`'s declaration of property `name`, replaced through `member`. */
function declarationMember(
  member: MergeMember,
  name: string,
  state: MergeState,
): MergeMember | undefined {
  const schema = propertiesOf(member.schema)[name];
  if (!isJsfObject(schema)) return undefined;
  return {
    schema,
    replace: (next) => {
      const properties = { ...propertiesOf(member.schema) };
      Object.defineProperty(properties, name, {
        value: next,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      replaceMember(member, { ...member.schema, properties }, state);
    },
  };
}

/**
 * json-schema-faker merges a property declared by several members of one
 * merge by copying the first declaration and merging the later ones'
 * keywords into it, and merges their own properties the same way, level by
 * level. `faker` is not a keyword it merges, so the first declaration's
 * `faker` survives and its value overrides every constraint the later
 * declarations add (an `enum`, a `maxLength`). When a later declaration does
 * add one and the enhancer wrote that `faker` (a name mapping or the lorem
 * fallback), drop it from the member's place in this node's copy; the schema
 * it came from, and any other use of it, keep their own. A `faker` the schema
 * declares is kept: it always wins. `ancestors` holds the declarations
 * already being merged, so a recursive schema stops.
 */
function dropOverriddenFakers(
  group: MergeMember[],
  state: MergeState,
  ancestors: ReadonlySet<JsfObjectSchema> = new Set(),
): void {
  const names = new Set(
    group.flatMap((member) => Object.keys(propertiesOf(member.schema))),
  );
  for (const name of names) {
    const declaring = group.filter((member) =>
      Object.hasOwn(propertiesOf(member.schema), name),
    );
    const [first, ...later] = declaring;
    if (!first || later.length === 0) continue;
    const declaration = propertiesOf(first.schema)[name];
    if (
      isJsfObject(declaration) &&
      state.inferredFakers.has(declaration) &&
      later.some((member) =>
        addsConstraint(propertiesOf(member.schema)[name], declaration),
      )
    ) {
      const { faker: _dropped, ...rest } = declaration;
      declarationMember(first, name, state)?.replace(rest);
      // Restated with the members, which closes its lone numeric bound.
      state.replaced.push(rest);
    }
    const nested = declaring.flatMap(
      (member) => declarationMember(member, name, state) ?? [],
    );
    if (
      nested.length < 2 ||
      nested.some((member) => ancestors.has(member.schema))
    ) {
      continue;
    }
    const path = new Set(ancestors);
    for (const member of nested) path.add(member.schema);
    dropOverriddenFakers(nested, state, path);
  }
}

function normalizeSchemaNodeForJsf(
  schema: JSONSchema7,
  context: NormalizeContext,
): JsfObjectSchema {
  const existing = context.normalizedSchemas.get(schema);
  if (existing) return existing;

  const normalized: JsfObjectSchema = {};
  context.normalizedSchemas.set(schema, normalized);
  if (Reflect.get(schema, INFERRED_FAKER_MARKER) === true) {
    context.inferredFakers.add(normalized);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (JSF_SCHEMA_KEYWORDS.has(key)) {
      normalized[key] = value;
    }
  }
  integerizeStep(normalized);
  keepTighterBounds(normalized);
  boundByteLength(normalized);

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

  encodeNot(schema, normalized);
  if (normalized.properties === undefined && describesObject(normalized)) {
    normalized.properties = {};
  }
  // On an untyped node JSF would read an object `example` or `definitions`
  // as a property to generate, ahead of the array, number or string its
  // other keywords imply. It never uses `example` itself (Schmock does not
  // set `useExamplesValue`), so the copy goes without it.
  if (normalized.type === undefined && normalized.properties === undefined) {
    delete normalized.example;
    hideDefinitions(normalized);
  }

  return normalized;
}

/**
 * Keep `definitions` on a JSF copy but out of every key json-schema-faker
 * enumerates. JSF reads it only when it walks a `#/definitions/...` pointer,
 * which looks the key up by name and so still finds it; inferring
 * properties, merging `$ref` siblings and merging `allOf` all enumerate
 * keys, so they no longer see it.
 */
function hideDefinitions(normalized: JsfObjectSchema): void {
  const { definitions } = normalized;
  if (definitions === undefined) return;
  Object.defineProperty(normalized, "definitions", {
    value: definitions,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/**
 * json-schema-faker honours `not` only as a plain `not.type`, met by picking
 * some other type (and falling back to the first declared one when that pick
 * is not in the node's type union), and as a retried `not.const`/`not.enum`.
 * Encode two more shapes into the JSF copy and drop the `not` they replace:
 * a `not.type` against a type union narrows the union, and a `not.required`
 * leaves one optional listed property out. Any other `not` stays as it is.
 */
function encodeNot(schema: JSONSchema7, normalized: JsfObjectSchema): void {
  const { not } = schema;
  if (!isJSONSchema7(not)) return;
  const keys = Object.keys(not);
  if (keys.length !== 1) return;
  const encoded =
    keys[0] === "type"
      ? narrowCopyTypes(normalized, not.type)
      : keys[0] === "required" && omitOneNotRequired(schema, normalized, not);
  if (encoded) delete normalized.not;
}

/** Remove the types `excluded` rejects from the copy's type union; false if none. */
function narrowCopyTypes(
  normalized: JsfObjectSchema,
  excluded: JSONSchema7["type"],
): boolean {
  const allowed = narrowTypeUnion(normalized.type, excluded);
  if (allowed === undefined) return false;
  normalized.type = allowed.length === 1 ? allowed[0] : allowed;
  return true;
}

/**
 * Leave the first optional property `not.required` lists out of the copy. A
 * `false` schema is one json-schema-faker skips, even under
 * `alwaysFakeOptionals`. A merge would bring the property back, so a node
 * with `allOf`/`anyOf`/`oneOf`/`if` is left alone, as is one whose listed
 * properties are all required or undeclared.
 */
function omitOneNotRequired(
  schema: JSONSchema7,
  normalized: JsfObjectSchema,
  not: JSONSchema7,
): boolean {
  const { properties } = normalized;
  const omitted = omittableNotRequired(schema, properties, not);
  if (omitted === undefined || !isJSONSchema7(properties)) return false;
  const kept: Record<string, JsonSchema> = { ...properties };
  Object.defineProperty(kept, omitted, {
    value: false,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  normalized.properties = kept;
  return true;
}

/** Keywords that make an untyped node an object for json-schema-faker. */
const OBJECT_KEYWORDS = [
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
];

/**
 * True for a node json-schema-faker generates as an object. When such a node
 * has no `properties`, JSF infers one required property from every key it
 * does not know as a keyword. `definitions`, `dependencies` and `example` are
 * forwarded but not on its list, so their schema text would appear in the
 * body; an empty `properties` switches that inference off.
 */
function describesObject(normalized: JsfObjectSchema): boolean {
  if (normalized.$ref !== undefined) return false;
  const { type } = normalized;
  if (type === "object") return true;
  if (Array.isArray(type)) return type.includes("object");
  if (type !== undefined) return false;
  return OBJECT_KEYWORDS.some((keyword) => normalized[keyword] !== undefined);
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

/** A step with more decimal places than this is left as JSF generates it. */
const MAX_STEP_PLACES = 15;

/** Decimal places in the shortest form of `value` (0.25 → 2, 1e-7 → 7). */
function decimalPlaces(value: number): number {
  const [mantissa, exponent] = value.toExponential().split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  return Math.max(0, fraction - Number(exponent));
}

function greatestCommonDivisor(left: number, right: number): number {
  return right === 0 ? left : greatestCommonDivisor(right, left % right);
}

/**
 * The smallest integer that is a multiple of `step`: its numerator in lowest
 * terms (0.5 → 1, 1.5 → 3, 0.3 → 3). Undefined for a step that is already an
 * integer, or too fine to reduce exactly.
 */
function smallestIntegerMultiple(step: number): number | undefined {
  if (!(step > 0) || Number.isInteger(step)) return undefined;
  const places = decimalPlaces(step);
  if (places > MAX_STEP_PLACES) return undefined;
  const denominator = 10 ** places;
  const numerator = Math.round(step * denominator);
  return numerator / greatestCommonDivisor(numerator, denominator);
}

/**
 * json-schema-faker generates an integer under `multipleOf` as `factor *
 * multipleOf`, so a fractional step gave `type: integer` values such as 6.5.
 * The integers that are multiples of the step are the multiples of its
 * smallest integer multiple, so the JSF copy steps by that instead.
 */
function integerizeStep(normalized: JsfObjectSchema): void {
  if (normalized.type !== "integer") return;
  const step = normalized.multipleOf;
  if (typeof step !== "number") return;
  const integerStep = smallestIntegerMultiple(step);
  if (integerStep !== undefined) normalized.multipleOf = integerStep;
}

/** Neighbouring multiples tried on each side when snapping a number. */
const SNAP_NEIGHBOURS = 10;

function withinNumericBounds(value: number, schema: JsfObjectSchema): boolean {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema;
  return !(
    (typeof minimum === "number" && value < minimum) ||
    (typeof maximum === "number" && value > maximum) ||
    (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) ||
    (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum)
  );
}

/**
 * json-schema-faker returns `factor * multipleOf`, which for a decimal step
 * carries floating-point noise (6.300000000000001 for a step of 0.1), and for
 * a step merged into an integer node is not an integer. Snap such a number to
 * a multiple written with the step's decimal places (an integer for
 * `type: integer`), preferring one whose quotient by the step is an exact
 * integer: that is the test AJV applies without `multipleOfPrecision`, and it
 * rejects some clean decimals (73.43 for 0.01). The nearest multiples inside
 * the node's bounds are tried first. A fixed value (`const`, `enum`,
 * `default`) is never touched. Runs as json-schema-faker's `outputTransform`,
 * which sees the merged schema of every generated value.
 */
function snapToStep(value: unknown, schema: JsonSchema): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  if (!isJsfObject(schema)) return value;
  const step = schema.multipleOf;
  if (typeof step !== "number" || !(step > 0) || Number.isInteger(step)) {
    return value;
  }
  if (
    schema.const !== undefined ||
    schema.enum !== undefined ||
    schema.default !== undefined
  ) {
    return value;
  }
  const integer = schema.type === "integer";
  const unit = integer ? smallestIntegerMultiple(step) : step;
  if (unit === undefined) return value;
  const places = integer ? 0 : decimalPlaces(step);
  if (places > MAX_STEP_PLACES) return value;

  const factor = Math.round(value / unit);
  let clean: number | undefined;
  for (let distance = 0; distance <= SNAP_NEIGHBOURS; distance += 1) {
    const factors =
      distance === 0 ? [factor] : [factor - distance, factor + distance];
    for (const candidateFactor of factors) {
      const candidate = Number((candidateFactor * unit).toFixed(places));
      if (!withinNumericBounds(candidate, schema)) continue;
      if (Number.isInteger(candidate / step)) return candidate;
      clean ??= candidate;
    }
  }
  return clean ?? value;
}

/**
 * json-schema-faker lets an exclusive bound replace the inclusive one on the
 * same side even when it is looser (`minimum: 10, exclusiveMinimum: 0` draws
 * from above 0). Keep only the tighter of a numeric pair in the JSF copy; an
 * exclusive bound wins a tie.
 */
function keepTighterBound(
  normalized: JsfObjectSchema,
  inclusiveKey: "minimum" | "maximum",
  exclusiveKey: "exclusiveMinimum" | "exclusiveMaximum",
): void {
  const inclusive = normalized[inclusiveKey];
  const exclusive = normalized[exclusiveKey];
  if (typeof inclusive !== "number" || typeof exclusive !== "number") return;
  const exclusiveIsTighter =
    inclusiveKey === "minimum"
      ? exclusive >= inclusive
      : exclusive <= inclusive;
  delete normalized[exclusiveIsTighter ? inclusiveKey : exclusiveKey];
}

/** Hand json-schema-faker one bound per side of a node. */
function keepTighterBounds(normalized: JsfObjectSchema): void {
  keepTighterBound(normalized, "minimum", "exclusiveMinimum");
  keepTighterBound(normalized, "maximum", "exclusiveMaximum");
}

/**
 * Give a lone bound past json-schema-faker's default range a finite partner,
 * so the range it draws from is not inverted. The `multipleOf` path starts
 * from the same default range, so it needs the partner too; there the partner
 * sits at least two steps away, so a multiple always lies between the bounds.
 * Runs once the bounds that meet through `allOf` are reconciled: a partner
 * written earlier would read as a real bound there. Only the JSF copy changes.
 */
function closeLoneNumericBound(normalized: JsfObjectSchema): void {
  const lower = numericBound(
    normalized.minimum,
    normalized.exclusiveMinimum,
    Math.max,
  );
  const upper = numericBound(
    normalized.maximum,
    normalized.exclusiveMaximum,
    Math.min,
  );
  const step = normalized.multipleOf;
  const span =
    typeof step === "number" && step > 0
      ? Math.max(JSF_DEFAULT_NUMBER_BOUND, 2 * step)
      : JSF_DEFAULT_NUMBER_BOUND;
  if (
    lower !== undefined &&
    upper === undefined &&
    lower >= JSF_DEFAULT_NUMBER_BOUND
  ) {
    normalized.maximum = lower + span;
  } else if (
    upper !== undefined &&
    lower === undefined &&
    upper <= -JSF_DEFAULT_NUMBER_BOUND
  ) {
    normalized.minimum = upper - span;
  }
}

/** The keywords of one numeric range. */
const NUMERIC_KEYWORDS = [
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
  "multipleOf",
] as const;

/** Most schemas one merge reconciles; past that it is left to JSF. */
const MAX_MERGE_SLOTS = 256;

/** One side of a numeric range. */
interface NumericBound {
  value: number;
  exclusive: boolean;
}

/** The numeric range of schemas merged into one value. */
interface NumericRange {
  lower?: NumericBound;
  upper?: NumericBound;
  /** Every `multipleOf`, in json-schema-faker's merge order. */
  steps: number[];
}

/** What one `reconcileAllOfBounds` pass reads and records. */
interface BoundsContext {
  resolve: ResolveMember;
  /** Every copy built for a merge, for the passes that restate the copies. */
  replaced: JsfObjectSchema[];
  /** The property declarations already being reconciled. */
  ancestors: ReadonlySet<JsfObjectSchema>;
}

/** One schema json-schema-faker merges, and the `allOf` entries it merges in turn. */
interface MergeSlot {
  /** The entry, or the target of its `$ref` with its other keywords over it. */
  schema: JsfObjectSchema;
  /** One per `allOf` entry of `schema`; undefined for a boolean entry. */
  entries: (MergeSlot | undefined)[];
}

function hasNumericBound(schema: JsfObjectSchema): boolean {
  return NUMERIC_KEYWORDS.some((key) => typeof schema[key] === "number");
}

/** `candidate` when it is tighter than `current`; an exclusive bound wins a tie. */
function tighterBound(
  current: NumericBound | undefined,
  candidate: NumericBound,
  direction: 1 | -1,
): NumericBound {
  if (!current) return candidate;
  const gap = (candidate.value - current.value) * direction;
  return gap > 0 || (gap === 0 && candidate.exclusive) ? candidate : current;
}

/** Narrow `range` by the numeric keywords of one schema. */
function narrowRange(range: NumericRange, schema: JsfObjectSchema): void {
  const sides = [
    ["minimum", "lower", false, 1],
    ["exclusiveMinimum", "lower", true, 1],
    ["maximum", "upper", false, -1],
    ["exclusiveMaximum", "upper", true, -1],
  ] as const;
  for (const [key, side, exclusive, direction] of sides) {
    const value = schema[key];
    if (typeof value !== "number") continue;
    range[side] = tighterBound(range[side], { value, exclusive }, direction);
  }
  if (typeof schema.multipleOf === "number") {
    range.steps.push(schema.multipleOf);
  }
}

/**
 * The least common multiple of `steps`, which is a multiple of every one of
 * them. Undefined when a step is not positive, is finer than
 * `MAX_STEP_PLACES` decimals, or the multiple is not a safe integer once
 * scaled to whole numbers.
 */
function leastCommonMultiple(steps: number[]): number | undefined {
  const distinct = [...new Set(steps)];
  if (distinct.length === 1) return distinct[0];
  if (distinct.some((step) => !(step > 0) || !Number.isFinite(step))) {
    return undefined;
  }
  const places = Math.max(...distinct.map(decimalPlaces));
  if (places > MAX_STEP_PLACES) return undefined;
  const scale = 10 ** places;
  let multiple = 1;
  for (const step of distinct) {
    const scaled = Math.round(step * scale);
    multiple = (multiple / greatestCommonDivisor(multiple, scaled)) * scaled;
    if (!Number.isSafeInteger(multiple)) return undefined;
  }
  return multiple / scale;
}

/**
 * Write `range` as one bound per side and one step. json-schema-faker keeps
 * only the last `multipleOf` it merges, so that is the step when the steps
 * have no least common multiple `leastCommonMultiple` can compute.
 */
function writeRange(target: JsfObjectSchema, range: NumericRange): void {
  const { lower, upper, steps } = range;
  if (lower) {
    target[lower.exclusive ? "exclusiveMinimum" : "minimum"] = lower.value;
  }
  if (upper) {
    target[upper.exclusive ? "exclusiveMaximum" : "maximum"] = upper.value;
  }
  if (steps.length > 0) {
    target.multipleOf = leastCommonMultiple(steps) ?? steps[steps.length - 1];
  }
}

function withoutNumericBounds(schema: JsfObjectSchema): JsfObjectSchema {
  const next = { ...schema };
  for (const key of NUMERIC_KEYWORDS) {
    if (typeof next[key] === "number") delete next[key];
  }
  return next;
}

/**
 * What json-schema-faker merges for an `allOf` entry or a property
 * declaration: the schema itself, or the end of its `$ref` chain with the
 * keywords beside each `$ref` over it, a nearer holder's over a farther
 * one's, as JSF resolves each hop. Undefined when a `$ref` does not reach a
 * local schema or the chain loops back. `origins` are the schemas it stands
 * for: the schema itself, or every target along the chain.
 */
function mergedEntry(
  entry: JsfObjectSchema,
  resolve: ResolveMember,
): { schema: JsfObjectSchema; origins: JsfObjectSchema[] } | undefined {
  if (entry.$ref === undefined) return { schema: entry, origins: [entry] };
  const origins: JsfObjectSchema[] = [];
  let overlay: JsfObjectSchema = {};
  let current = entry;
  while (current.$ref !== undefined) {
    const target =
      typeof current.$ref === "string" ? resolve(current) : undefined;
    if (!target || origins.includes(target)) return undefined;
    const { $ref: _ref, ...siblings } = current;
    overlay = { ...siblings, ...overlay };
    origins.push(target);
    current = target;
  }
  const schema =
    Object.keys(overlay).length === 0 ? current : { ...current, ...overlay };
  return { schema, origins };
}

/**
 * `schema` and the `allOf` entries json-schema-faker merges with it: JSF
 * appends an entry's own `allOf` to the merged list, so those meet too.
 * Undefined when an entry cannot be followed, the entries loop back, or the
 * merge holds more than `MAX_MERGE_SLOTS` schemas (`budget` counts them).
 */
function mergeSlot(
  schema: JsfObjectSchema,
  resolve: ResolveMember,
  path: ReadonlySet<JsfObjectSchema>,
  budget: { slots: number },
): MergeSlot | undefined {
  budget.slots += 1;
  if (budget.slots > MAX_MERGE_SLOTS) return undefined;
  const { allOf } = schema;
  if (!Array.isArray(allOf)) return { schema, entries: [] };
  const entries: (MergeSlot | undefined)[] = [];
  for (const entry of allOf) {
    if (!isJsfObject(entry)) {
      entries.push(undefined);
      continue;
    }
    const merged = mergedEntry(entry, resolve);
    if (!merged || merged.origins.some((origin) => path.has(origin))) {
      return undefined;
    }
    const slot = mergeSlot(
      merged.schema,
      resolve,
      new Set([...path, ...merged.origins]),
      budget,
    );
    if (!slot) return undefined;
    entries.push(slot);
  }
  return { schema, entries };
}

/** The slots of `roots`, in the order json-schema-faker merges them. */
function mergeOrder(roots: MergeSlot[]): MergeSlot[] {
  const ordered: MergeSlot[] = [];
  let level = roots;
  while (level.length > 0) {
    ordered.push(...level);
    level = level.flatMap((slot) =>
      slot.entries.flatMap((entry) => entry ?? []),
    );
  }
  return ordered;
}

/** `properties` with each of `replaced`'s declarations in its name's place. */
function withDeclarations(
  properties: Record<string, JsonSchema>,
  replaced: ReadonlyMap<string, JsfObjectSchema>,
): Record<string, JsonSchema> {
  const next: Record<string, JsonSchema> = { ...properties };
  for (const [name, declaration] of replaced) {
    Object.defineProperty(next, name, {
      value: declaration,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return next;
}

/**
 * json-schema-faker merges a property that several merged schemas declare by
 * merging the declarations, so their bounds meet as well: reconcile each such
 * property's declarations as one merge, level by level. Returns, per slot,
 * the declarations to put in its `properties`. A `$ref` declaration is read
 * as `mergedEntry` reads one. A property declared by a boolean or by a
 * `$ref` that cannot be followed is left as it is, as is one whose schemas
 * are already being reconciled.
 */
function reconcileDeclarations(
  ordered: MergeSlot[],
  context: BoundsContext,
): Map<MergeSlot, Map<string, JsfObjectSchema>> {
  const replaced = new Map<MergeSlot, Map<string, JsfObjectSchema>>();
  const names = new Set(
    ordered.flatMap((slot) => Object.keys(propertiesOf(slot.schema))),
  );
  for (const name of names) {
    const declaring = ordered.filter((slot) =>
      Object.hasOwn(propertiesOf(slot.schema), name),
    );
    if (declaring.length < 2) continue;
    const merged = declaring.flatMap((slot) => {
      const declaration = propertiesOf(slot.schema)[name];
      const entry = isJsfObject(declaration)
        ? mergedEntry(declaration, context.resolve)
        : undefined;
      return entry ? [entry] : [];
    });
    const origins = merged.flatMap((entry) => entry.origins);
    if (
      merged.length < declaring.length ||
      origins.some((origin) => context.ancestors.has(origin))
    ) {
      continue;
    }
    // A `$ref` declaration stands for its target, with its own keywords
    // over it; a changed one is written back as an inline copy.
    const declarations = merged.map((entry) => entry.schema);
    const next = reconcileMerge(declarations, {
      ...context,
      ancestors: new Set([...context.ancestors, ...origins]),
    });
    if (!next) continue;
    declaring.forEach((slot, index) => {
      if (next[index] === declarations[index]) return;
      context.replaced.push(next[index]);
      const forSlot = replaced.get(slot) ?? new Map();
      forSlot.set(name, next[index]);
      replaced.set(slot, forSlot);
    });
  }
  return replaced;
}

/**
 * json-schema-faker merges numeric bounds keyword by keyword: the largest
 * `minimum` and the largest `exclusiveMinimum` both survive, and the
 * exclusive one is used even when the inclusive one is tighter; only the last
 * `multipleOf` is kept. Reconcile the bounds of `roots`, schemas merged into
 * one value in that order, and of every `allOf` entry merged with them: the
 * first root takes the tightest bound of each side and the least common
 * multiple of the steps, and every other schema drops its numeric keywords.
 * Returns the schemas to use in place of `roots`, unchanged ones included,
 * or undefined when nothing changes. Shared schemas are never written to; a
 * changed one is copied, and each copy is added to `context.replaced`.
 */
function reconcileMerge(
  roots: JsfObjectSchema[],
  context: BoundsContext,
): JsfObjectSchema[] | undefined {
  const budget = { slots: 0 };
  const slots: MergeSlot[] = [];
  for (const root of roots) {
    const slot = mergeSlot(root, context.resolve, new Set([root]), budget);
    if (!slot) return undefined;
    slots.push(slot);
  }
  const [carrier] = slots;
  const ordered = mergeOrder(slots);
  const range: NumericRange = { steps: [] };
  for (const slot of ordered) narrowRange(range, slot.schema);
  // True when a bound sits off the first root and so moves onto it.
  const moved = ordered.some(
    (slot) => slot !== carrier && hasNumericBound(slot.schema),
  );
  const declarations = reconcileDeclarations(ordered, context);
  if (!moved && declarations.size === 0) return undefined;

  const rebuild = (slot: MergeSlot): JsfObjectSchema | undefined => {
    const entries = slot.entries.map((entry) => entry && rebuild(entry));
    const replaced = declarations.get(slot);
    const bounded = slot === carrier ? moved : hasNumericBound(slot.schema);
    if (!bounded && !replaced && entries.every((entry) => !entry)) {
      return undefined;
    }
    const next = bounded
      ? withoutNumericBounds(slot.schema)
      : { ...slot.schema };
    if (slot === carrier && moved) writeRange(next, range);
    if (replaced) {
      next.properties = withDeclarations(propertiesOf(slot.schema), replaced);
    }
    const { allOf } = slot.schema;
    if (Array.isArray(allOf) && entries.some((entry) => entry)) {
      next.allOf = allOf.map((entry, index) => entries[index] ?? entry);
    }
    if (!slots.includes(slot)) context.replaced.push(next);
    return next;
  };
  return slots.map((slot) => rebuild(slot) ?? slot.schema);
}

/**
 * Reconcile the numeric bounds a node shares with its `allOf` entries (see
 * `reconcileMerge`), writing the result onto the node's own copy. A node
 * with a `$ref` is left as it is: JSF lets its own keywords override the
 * target's, so bounds written there would replace the target's.
 */
function reconcileAllOfBounds(
  copy: JsfObjectSchema,
  context: BoundsContext,
): void {
  if (!Array.isArray(copy.allOf) || copy.$ref !== undefined) return;
  const [next] = reconcileMerge([copy], context) ?? [];
  if (!next || next === copy) return;
  for (const key of NUMERIC_KEYWORDS) {
    if (typeof copy[key] === "number") delete copy[key];
  }
  Object.assign(copy, next);
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
    outputTransform: snapToStep,
    extensions: { faker: fakerExtension(createFakerInstance(seed, refDate)) },
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
