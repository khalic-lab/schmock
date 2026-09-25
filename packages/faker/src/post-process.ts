import type { JSONSchema7 } from "json-schema";
import { NULLABLE_NULL_PROBABILITY } from "./constants.js";
import { compilePattern, isJSONSchema7, isRecord } from "./utils.js";

/**
 * Reintroduce null at ~5% on nodes the enhancer marked `schmockNullable`.
 *
 * json-schema-faker generates the non-null shape (the enhancer collapsed the
 * union), so this walks the generated value alongside the ENHANCED schema.
 * Every schema that describes a value applies to it: `$ref` targets, every
 * `allOf` branch, the one `anyOf`/`oneOf` branch the value structurally
 * matches, and `properties`, `patternProperties` or `additionalProperties`
 * for each key of an object. The walk is driven by the value, so it is finite
 * even over a recursive schema.
 *
 * A node is rolled at most once, and only when null satisfies every schema
 * that constrains it — an `allOf` sibling that declares a non-null type keeps
 * the value.
 *
 * Boolean weighting (`schmockTrueProbability`) is not applied here: the
 * enhancer compiles it into the faker call, so it reaches every node JSF
 * generates.
 */
export function applyNullableRolls(
  data: unknown,
  root: JSONSchema7,
  random: () => number,
): unknown {
  return visit(data, [root], { root, random, patterns: new Map() });
}

interface WalkContext {
  root: JSONSchema7;
  random: () => number;
  patterns: Map<string, RegExp | undefined>;
}

/**
 * A schema that applies to the value being walked. `vetoes` is false for
 * schemas reached through a nullable-marked node's own `$ref`/composition:
 * those describe the non-null alternative, so they cannot rule null out.
 */
interface Applicable {
  schema: JSONSchema7;
  vetoes: boolean;
}

/** How deep `couldMatch` looks into a candidate branch before giving up. */
const MATCH_DEPTH = 4;

function visit(
  data: unknown,
  schemas: JSONSchema7[],
  context: WalkContext,
): unknown {
  if (data === null || data === undefined) return data;

  const found: Applicable[] = [];
  const seen = new Set<JSONSchema7>();
  for (const schema of schemas) {
    collectApplicable({ schema, data, context, seen, found }, false);
  }
  if (found.length === 0) return data;

  if (acceptsRolledNull(found)) {
    if (context.random() < NULLABLE_NULL_PROBABILITY) return null;
  }

  const applicable = found.map((entry) => entry.schema);
  if (isRecord(data)) {
    for (const key of Object.keys(data)) {
      const children = applicable.flatMap(
        (schema) => lookupProperty(schema, key, context).schemas,
      );
      if (children.length > 0) {
        data[key] = visit(data[key], children, context);
      }
    }
  } else if (Array.isArray(data)) {
    for (let index = 0; index < data.length; index++) {
      const children = applicable.flatMap((schema) =>
        itemSchemas(schema, index),
      );
      if (children.length > 0) {
        data[index] = visit(data[index], children, context);
      }
    }
  }

  return data;
}

function isNullableMarked(schema: JSONSchema7): boolean {
  return Reflect.get(schema, "schmockNullable") === true;
}

/** Whether a null instance satisfies `schema` — only type/const/enum refuse. */
function admitsNull(schema: JSONSchema7): boolean {
  if (isNullableMarked(schema)) return true;
  if (schema.const !== undefined && schema.const !== null) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) return false;
  if (schema.type === undefined) return true;
  return Array.isArray(schema.type)
    ? schema.type.includes("null")
    : schema.type === "null";
}

/**
 * Some applicable schema is marked nullable, and no other schema that
 * constrains this value rejects null.
 */
function acceptsRolledNull(found: Applicable[]): boolean {
  if (!found.some((entry) => isNullableMarked(entry.schema))) return false;
  return found.every((entry) => !entry.vetoes || admitsNull(entry.schema));
}

interface Collection {
  schema: JSONSchema7;
  data: unknown;
  context: WalkContext;
  seen: Set<JSONSchema7>;
  found: Applicable[];
}

function collectApplicable(
  collection: Collection,
  underNullable: boolean,
): void {
  const { schema, data, context, seen, found } = collection;
  if (seen.has(schema)) return;
  seen.add(schema);
  found.push({ schema, vetoes: !underNullable });
  const nested = underNullable || isNullableMarked(schema);
  const descend = (next: JSONSchema7) =>
    collectApplicable({ ...collection, schema: next }, nested);

  const target = resolveRef(schema, context.root);
  if (target) descend(target);

  for (const branch of schema.allOf ?? []) {
    if (isJSONSchema7(branch)) descend(branch);
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = (schema[keyword] ?? []).filter(isJSONSchema7);
    const matching = branches.filter((branch) =>
      couldMatch(data, branch, context, MATCH_DEPTH),
    );
    // Which branch JSF picked is unknowable when several fit; rolling a
    // non-chosen branch's field could produce an invalid null, so skip.
    if (matching.length === 1) descend(matching[0]);
  }
}

/** Resolve a local JSON Pointer `$ref` against the enhanced root schema. */
function resolveRef(
  schema: JSONSchema7,
  root: JSONSchema7,
): JSONSchema7 | undefined {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return undefined;
    }
    segment = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      current = /^(0|[1-9]\d*)$/.test(segment)
        ? current[Number(segment)]
        : undefined;
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return isJSONSchema7(current) ? current : undefined;
}

function patternFor(source: string, context: WalkContext): RegExp | undefined {
  if (!context.patterns.has(source)) {
    // Compiled as JSF normalization compiles it when inventing keys, so every
    // invented key is recognised here.
    context.patterns.set(source, compilePattern(source));
  }
  return context.patterns.get(source);
}

interface PropertyLookup {
  schemas: JSONSchema7[];
  /** The key is named by `properties` or matched by a `patternProperties` key. */
  covered: boolean;
}

function lookupProperty(
  schema: JSONSchema7,
  key: string,
  context: WalkContext,
): PropertyLookup {
  const schemas: JSONSchema7[] = [];
  const declared =
    schema.properties !== undefined && Object.hasOwn(schema.properties, key);
  if (declared) {
    const property = schema.properties?.[key];
    if (isJSONSchema7(property)) schemas.push(property);
  }
  let patterned = false;
  for (const [source, definition] of Object.entries(
    schema.patternProperties ?? {},
  )) {
    if (patternFor(source, context)?.test(key)) {
      patterned = true;
      if (isJSONSchema7(definition)) schemas.push(definition);
    }
  }
  const covered = declared || patterned;
  if (!covered && isJSONSchema7(schema.additionalProperties)) {
    schemas.push(schema.additionalProperties);
  }
  return { schemas, covered };
}

function itemSchemas(schema: JSONSchema7, index: number): JSONSchema7[] {
  const prefixItems = Reflect.get(schema, "prefixItems");
  const tuple = Array.isArray(schema.items)
    ? schema.items
    : Array.isArray(prefixItems)
      ? prefixItems
      : undefined;
  if (tuple) {
    const positional: unknown =
      index < tuple.length
        ? tuple[index]
        : Array.isArray(schema.items)
          ? schema.additionalItems
          : schema.items;
    return isJSONSchema7(positional) ? [positional] : [];
  }
  return isJSONSchema7(schema.items) ? [schema.items] : [];
}

function jsonTypeMatches(data: unknown, type: unknown): boolean {
  switch (type) {
    case "null":
      return data === null;
    case "boolean":
      return typeof data === "boolean";
    case "string":
      return typeof data === "string";
    case "integer":
      return Number.isInteger(data);
    case "number":
      return typeof data === "number";
    case "array":
      return Array.isArray(data);
    case "object":
      return isRecord(data);
    default:
      return true;
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object") return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Cheap structural test: could `data` be an instance of `schema`?
 *
 * It checks `type`, `const`, `enum`, `required`, closed `additionalProperties`,
 * the same test on declared property values (so a discriminator `const`
 * separates branches), `$ref` targets and every `allOf` branch. Past
 * `MATCH_DEPTH` it answers "could match", which only ever makes the caller
 * treat an `anyOf`/`oneOf` as ambiguous and skip it.
 */
function couldMatch(
  data: unknown,
  schema: JSONSchema7,
  context: WalkContext,
  depth: number,
): boolean {
  if (depth <= 0) return true;
  const target = resolveRef(schema, context.root);
  if (target && !couldMatch(data, target, context, depth - 1)) return false;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => jsonTypeMatches(data, type))) return false;
  }
  if (schema.const !== undefined && !sameValue(schema.const, data)) {
    return false;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((value) => sameValue(value, data))
  ) {
    return false;
  }

  if (isRecord(data)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(data, key)) return false;
    }
    for (const [key, value] of Object.entries(data)) {
      const { schemas, covered } = lookupProperty(schema, key, context);
      if (!covered && schema.additionalProperties === false) return false;
      for (const child of schemas) {
        if (value !== null && !couldMatch(value, child, context, depth - 1)) {
          return false;
        }
      }
    }
  }

  for (const branch of schema.allOf ?? []) {
    if (
      isJSONSchema7(branch) &&
      !couldMatch(data, branch, context, depth - 1)
    ) {
      return false;
    }
  }
  return true;
}
