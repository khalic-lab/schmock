import type { JSONSchema7 } from "json-schema";
import {
  declaresExplicitValue,
  findBestMapping,
  GENERATABLE_FORMATS,
} from "./field-name-matcher.js";
import { mapSchemaChildren, type SchemaChildSlot } from "./schema-children.js";
import { isJSONSchema7 } from "./utils.js";
import { validateFakerMethod } from "./validation.js";

/** JSONSchema7 extended with json-schema-faker's `faker` property and schmock markers */
interface FakerSchema extends JSONSchema7 {
  faker?: string | Record<string, unknown>;
  schmockNullable?: boolean;
  schmockTrueProbability?: number;
}

function needsStringFallback(schema: FakerSchema): boolean {
  return (
    schema.type === "string" &&
    schema.faker === undefined &&
    schema.format === undefined &&
    schema.minLength === undefined &&
    schema.maxLength === undefined &&
    !declaresExplicitValue(schema)
  );
}

/** True for a bare `{ type: "null" }` branch — nothing else may constrain it. */
function isBareNullBranch(branch: unknown): boolean {
  return (
    isJSONSchema7(branch) &&
    branch.type === "null" &&
    Object.keys(branch).length === 1
  );
}

/**
 * Unwrap a two-branch `anyOf`/`oneOf` whose other branch is a bare
 * `{type: "null"}`, in either order, into that other branch.
 *
 * The structural match is deliberately strict — exactly two branches, one of
 * them nothing but `type: "null"`. Do not loosen it to
 * `anyOf.some(b => b.type === "null")`: a union with more than one non-null
 * branch is a real choice that json-schema-faker must keep making.
 *
 * Returns undefined when the node is not such a union, or when the wrapper
 * repeats a keyword of the unwrapped branch (merging would drop one of them).
 */
function unwrapNullUnion(
  schema: FakerSchema,
  requireDisjoint: boolean,
): FakerSchema | undefined {
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length !== 2) continue;
    const [first, second] = branches;
    const rest = isBareNullBranch(first)
      ? second
      : isBareNullBranch(second)
        ? first
        : undefined;
    if (!isJSONSchema7(rest)) continue;
    const { [keyword]: _dropped, ...wrapper } = schema;
    if (
      requireDisjoint &&
      Object.keys(wrapper).some((key) => Object.hasOwn(rest, key))
    ) {
      return undefined;
    }
    return { ...rest, ...wrapper, schmockNullable: true };
  }
  return undefined;
}

/**
 * Collapse a nullable schema back to its non-null shape for the generation
 * pass, marking it `schmockNullable` so null is reintroduced at ~5%.
 *
 * Two sources reach this:
 * - the OpenAPI normalizer's encodings of 3.0 `nullable: true`, marked with
 *   `schmockNullable` (`type: [T, "null"]`, or `anyOf: [{type:"null"}, rest]`
 *   for composition-only schemas);
 * - the same shapes written natively — OpenAPI 3.1 and plain JSON Schema spell
 *   nullability `type: [T, "null"]` or `oneOf`/`anyOf` with a `{type:"null"}`
 *   branch, and carry no marker.
 *
 * JSF would read either union as a ~50/50 type choice, and it also defeats the
 * `type === "string"` gates in `needsStringFallback`/`findBestMapping`, so on
 * the generation path we strip it and let `applyNullableRolls` (post-process.ts)
 * reintroduce null at ~5%. An explicit `schmockNullable: false` opts a node
 * out: JSF then generates the union as written.
 *
 * The `schmockNullable` marker MUST survive: `applyNullableRolls` walks the
 * ENHANCED schema, so dropping it here would silently stop nulls entirely.
 *
 * Contract: the caller passes an already-shallow-copied object; this helper may
 * mutate it in place, and always returns the object to use.
 */
function stripNullableForGeneration(schema: FakerSchema): FakerSchema {
  if (schema.schmockNullable === false) return schema;
  const marked = schema.schmockNullable === true;

  const unwrapped = unwrapNullUnion(schema, !marked);
  if (unwrapped) return unwrapped;

  if (!marked && !isNativeNullableType(schema)) return schema;
  schema.schmockNullable = true;

  // `type: [T, "null"]` encoding
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== "null");
    if (nonNull.length === 1) {
      schema.type = nonNull[0];
    } else if (nonNull.length > 0) {
      schema.type = nonNull;
    }
    // all-null: leave untouched
  }
  if (Array.isArray(schema.enum)) {
    const nonNull = schema.enum.filter((v) => v !== null);
    if (nonNull.length > 0) {
      schema.enum = nonNull;
    }
  }

  return schema;
}

/**
 * `type: [..., "null"]` with at least one other type, and nothing that pins
 * the value to null itself (a `const: null`, or an enum of only nulls).
 */
function isNativeNullableType(schema: FakerSchema): boolean {
  if (!Array.isArray(schema.type) || !schema.type.includes("null")) {
    return false;
  }
  if (!schema.type.some((type) => type !== "null")) return false;
  if (schema.const === null) return false;
  if (Array.isArray(schema.enum) && schema.enum.every((v) => v === null)) {
    return false;
  }
  return true;
}

const ROOT_CONTEXT = Symbol("root-schema");
type EnhancementContext = typeof ROOT_CONTEXT | string;

interface EnhancementState {
  cache: Map<JSONSchema7, Map<EnhancementContext, FakerSchema>>;
}

const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);

/** True when `schema` generates a single primitive type (nullable allowed). */
function isPrimitiveSchema(schema: JSONSchema7): boolean {
  const types = Array.isArray(schema.type)
    ? schema.type.filter((type) => type !== "null")
    : [schema.type];
  return types.length === 1 && PRIMITIVE_TYPES.has(String(types[0]));
}

/** Candidate singular forms of a plural field name: emails → email, cities → city. */
function singularForms(fieldName: string): string[] {
  const forms: string[] = [];
  if (/ies$/i.test(fieldName)) forms.push(`${fieldName.slice(0, -3)}y`);
  if (/[^s]s$/i.test(fieldName)) forms.push(fieldName.slice(0, -1));
  if (/(ses|xes|zes|ches|shes)$/i.test(fieldName)) {
    forms.push(fieldName.slice(0, -2));
  }
  return forms;
}

/**
 * The context to enhance a single `items` schema under.
 *
 * Array items have no name of their own, so a primitive item inherits the
 * singular form of its property name — `emails: [string]` generates addresses
 * rather than lorem words — but only when that singular form actually maps.
 * The explicit-keyword rule still applies: `findBestMapping` refuses an item
 * that declares its own default, enum, pattern or generatable format.
 */
function itemContext(
  context: EnhancementContext,
  items: JSONSchema7,
): EnhancementContext {
  if (context === ROOT_CONTEXT || !isPrimitiveSchema(items)) {
    return ROOT_CONTEXT;
  }
  for (const singular of singularForms(context)) {
    if (findBestMapping(singular, items)) return singular;
  }
  return ROOT_CONTEXT;
}

/** Enhance each distinct schema/context pair once and preserve shared edges. */
export function enhanceSchemaWithSmartMapping(
  schema: JSONSchema7,
): JSONSchema7 {
  if (!schema || typeof schema !== "object") return schema;
  return enhanceSchema(schema, { cache: new Map() }, ROOT_CONTEXT);
}

function enhanceSchema(
  schema: JSONSchema7,
  state: EnhancementState,
  context: EnhancementContext,
): FakerSchema {
  let contexts = state.cache.get(schema);
  if (!contexts) {
    contexts = new Map();
    state.cache.set(schema, contexts);
  }
  const cached = contexts.get(context);
  if (cached) return cached;

  const enhanced = stripNullableForGeneration({ ...schema } as FakerSchema);
  contexts.set(context, enhanced);

  if (context !== ROOT_CONTEXT && enhanced.faker) {
    if (typeof enhanced.faker === "string") {
      validateFakerMethod(enhanced.faker);
    }
  } else {
    enhanceChildren(enhanced, state, context);
    applyNameMapping(enhanced, context);
  }

  applyBooleanWeighting(enhanced);
  return enhanced;
}

function enhanceChildren(
  enhanced: FakerSchema,
  state: EnhancementState,
  context: EnhancementContext,
): void {
  const children = mapSchemaChildren(enhanced, (child, slot) =>
    isJSONSchema7(child)
      ? enhanceSchema(child, state, childContext({ context, child, slot }))
      : child,
  );
  for (const { keyword, value } of children) {
    Reflect.set(enhanced, keyword, value);
  }
}

interface ChildContextRequest {
  context: EnhancementContext;
  child: JSONSchema7;
  slot: SchemaChildSlot;
}

/**
 * A property is enhanced under its own name and a single `items` schema under
 * its parent's (see `itemContext`). No other child has a name to map.
 */
function childContext(request: ChildContextRequest): EnhancementContext {
  const { context, child, slot } = request;
  if (slot.keyword === "properties" && slot.location.form === "map") {
    return slot.location.name;
  }
  if (slot.keyword === "items" && slot.location.form === "single") {
    return itemContext(context, child);
  }
  return ROOT_CONTEXT;
}

/**
 * Apply the field-name heuristic, or the lorem fallback for bare strings.
 *
 * Explicit schema keywords always win: `findBestMapping` refuses a schema that
 * declares its own value (`default`, `const`, `enum`, `pattern`, `faker`,
 * `$ref`) or a generatable `format`; a mapping never overwrites a declared
 * `format` or `schmockTrueProbability`.
 */
function applyNameMapping(
  enhanced: FakerSchema,
  context: EnhancementContext,
): void {
  if (context === ROOT_CONTEXT) {
    if (needsStringFallback(enhanced)) enhanced.faker = "lorem.word";
    return;
  }

  const hasComposition = enhanced.allOf || enhanced.anyOf || enhanced.oneOf;
  if (hasComposition || declaresExplicitValue(enhanced)) return;

  const match = findBestMapping(context, enhanced);
  if (match) {
    const { fakerMethod, format, trueProbability, fakerArgs } = match.mapping;
    enhanced.faker = fakerArgs ? { [fakerMethod]: [fakerArgs] } : fakerMethod;
    // A mapping only reaches a node whose declared format (if any) nothing can
    // generate, so the mapping's own format drives generation instead. It
    // matters for dates: JSF serializes a faker `Date` as ISO only under
    // `date-time`, and as a local-time-zone `String(date)` otherwise. This
    // copy feeds generation only; validation still sees the declared format.
    if (
      format &&
      (typeof enhanced.format !== "string" ||
        !GENERATABLE_FORMATS.has(enhanced.format))
    ) {
      enhanced.format = format;
    }
    if (
      trueProbability !== undefined &&
      enhanced.schmockTrueProbability === undefined
    ) {
      enhanced.schmockTrueProbability = trueProbability;
    }
  } else if (needsStringFallback(enhanced)) {
    enhanced.faker = "lorem.word";
  }
}

/**
 * Weight a boolean through faker itself, so the weight applies wherever
 * json-schema-faker generates the node — inside `allOf`/`anyOf`/`oneOf`
 * branches, `$ref` targets and `additionalProperties` values alike. A
 * post-generation walk only ever reached plain `properties` and `items`.
 *
 * `schmockTrueProbability` is either declared by the schema or set by a
 * name mapping that found none declared. A `const` or `enum` fixes the value
 * outright, so it is left alone.
 */
function applyBooleanWeighting(enhanced: FakerSchema): void {
  const probability = enhanced.schmockTrueProbability;
  if (
    enhanced.type !== "boolean" ||
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    enhanced.const !== undefined ||
    enhanced.enum !== undefined
  ) {
    return;
  }
  enhanced.faker = { "datatype.boolean": [{ probability }] };
}
