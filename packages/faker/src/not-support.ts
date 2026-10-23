import type { JSONSchema7 } from "json-schema";
import { isJSONSchema7 } from "./utils.js";

/**
 * Keywords json-schema-faker generates from ahead of `not`. When a node holds
 * one, its `not` is never reached.
 */
const MERGING_KEYWORDS = ["allOf", "anyOf", "oneOf", "if"] as const;

/** Whether `schema` holds a keyword json-schema-faker merges ahead of `not`. */
function mergesAheadOfNot(schema: JSONSchema7): boolean {
  return MERGING_KEYWORDS.some((keyword) => schema[keyword] !== undefined);
}

function typeList(type: unknown): unknown[] {
  if (type === undefined) return [];
  return Array.isArray(type) ? type : [type];
}

/**
 * The members of the type union `type` that `excluded` leaves. Every integer
 * is also a number, so excluding `number` excludes `integer` too. Undefined
 * when `type` is not a union, or `excluded` removes none or all of it.
 */
export function narrowTypeUnion(
  type: unknown,
  excluded: unknown,
): string[] | undefined {
  if (!Array.isArray(type)) return undefined;
  const members = type.filter((member) => typeof member === "string");
  if (members.length !== type.length) return undefined;
  const rejected = typeList(excluded);
  const allowed = members.filter(
    (member) =>
      !rejected.includes(member) &&
      !(member === "integer" && rejected.includes("number")),
  );
  if (allowed.length === 0 || allowed.length === type.length) return undefined;
  return allowed;
}

/**
 * The first property `not.required` lists that `schema` declares in
 * `properties` without requiring it, which a copy can leave out. None when
 * a merge (`allOf`, `anyOf`, `oneOf`, `if`) could bring the property back.
 */
export function omittableNotRequired(
  schema: JSONSchema7,
  properties: unknown,
  not: JSONSchema7,
): string | undefined {
  if (mergesAheadOfNot(schema) || !isJSONSchema7(properties)) return undefined;
  const required = new Set(schema.required ?? []);
  return (not.required ?? []).find(
    (name) => !required.has(name) && Object.hasOwn(properties, name),
  );
}

/**
 * The type json-schema-faker generates `schema` as. The enhancer generates a
 * `type: [T, "null"]` union as T and rolls null in afterwards, unless the
 * node opts out with `schmockNullable: false`; the roll never adds a null a
 * `not` rejects.
 */
function generatedTypes(schema: JSONSchema7): unknown[] {
  const types = typeList(schema.type);
  if (
    !types.includes("null") ||
    Reflect.get(schema, "schmockNullable") === false
  ) {
    return types;
  }
  const nonNull = types.filter((type) => type !== "null");
  return nonNull.length > 0 ? nonNull : types;
}

/** Whether a value of JSON type `type` can be one of `types`. */
function overlapsType(type: unknown, types: unknown[]): boolean {
  return (
    types.includes(type) ||
    (type === "integer" && types.includes("number")) ||
    (type === "number" && types.includes("integer"))
  );
}

/**
 * A bound in a `not` body that a bound of the node itself contradicts, for
 * the one family of types both apply to: every value the node generates
 * fails that body keyword, so none matches the body.
 */
interface ContradictedBound {
  body: keyof JSONSchema7;
  base: keyof JSONSchema7;
  family: readonly string[];
  contradicts: (body: number, base: number) => boolean;
}

const STRING_TYPES = ["string"];
const ARRAY_TYPES = ["array"];
const OBJECT_TYPES = ["object"];
const NUMERIC_TYPES = ["number", "integer"];
const above = (body: number, base: number) => body > base;
const below = (body: number, base: number) => body < base;
const atOrAbove = (body: number, base: number) => body >= base;
const atOrBelow = (body: number, base: number) => body <= base;

const CONTRADICTED_BOUNDS: readonly ContradictedBound[] = [
  {
    body: "minLength",
    base: "maxLength",
    family: STRING_TYPES,
    contradicts: above,
  },
  {
    body: "maxLength",
    base: "minLength",
    family: STRING_TYPES,
    contradicts: below,
  },
  {
    body: "minItems",
    base: "maxItems",
    family: ARRAY_TYPES,
    contradicts: above,
  },
  {
    body: "maxItems",
    base: "minItems",
    family: ARRAY_TYPES,
    contradicts: below,
  },
  {
    body: "minProperties",
    base: "maxProperties",
    family: OBJECT_TYPES,
    contradicts: above,
  },
  {
    body: "maxProperties",
    base: "minProperties",
    family: OBJECT_TYPES,
    contradicts: below,
  },
  {
    body: "minimum",
    base: "maximum",
    family: NUMERIC_TYPES,
    contradicts: above,
  },
  {
    body: "minimum",
    base: "exclusiveMaximum",
    family: NUMERIC_TYPES,
    contradicts: atOrAbove,
  },
  {
    body: "exclusiveMinimum",
    base: "maximum",
    family: NUMERIC_TYPES,
    contradicts: atOrAbove,
  },
  {
    body: "exclusiveMinimum",
    base: "exclusiveMaximum",
    family: NUMERIC_TYPES,
    contradicts: atOrAbove,
  },
  {
    body: "maximum",
    base: "minimum",
    family: NUMERIC_TYPES,
    contradicts: below,
  },
  {
    body: "maximum",
    base: "exclusiveMinimum",
    family: NUMERIC_TYPES,
    contradicts: atOrBelow,
  },
  {
    body: "exclusiveMaximum",
    base: "minimum",
    family: NUMERIC_TYPES,
    contradicts: atOrBelow,
  },
  {
    body: "exclusiveMaximum",
    base: "exclusiveMinimum",
    family: NUMERIC_TYPES,
    contradicts: atOrBelow,
  },
];

/**
 * Whether the node's own `type`, or one of its own length, item-count,
 * property-count or numeric bounds, already rules out every value `body`
 * accepts, so the `not` holds whatever json-schema-faker does with it.
 */
function ruledOutByBase(schema: JSONSchema7, body: JSONSchema7): boolean {
  const types = generatedTypes(schema);
  if (types.length === 0) return false;
  if (body.type !== undefined) {
    const excluded = typeList(body.type);
    if (!types.some((type) => overlapsType(type, excluded))) return true;
  }
  return CONTRADICTED_BOUNDS.some(
    ({ body: key, base, family, contradicts }) => {
      const bodyBound = body[key];
      const baseBound = schema[base];
      return (
        typeof bodyBound === "number" &&
        typeof baseBound === "number" &&
        types.every((type) => family.includes(String(type))) &&
        contradicts(bodyBound, baseBound)
      );
    },
  );
}

/** Where a `not` sits, as far as json-schema-faker's handling of it goes. */
export interface NotSite {
  /** The node is a `properties` value, which JSF leaves out when nothing fits. */
  propertyValue: boolean;
  /** The node's reference is inlined as an `allOf` entry (jsf-references.ts). */
  inlinedReference: boolean;
}

/**
 * Why json-schema-faker would generate values that `schema`'s `not` rejects,
 * or undefined when it honours the `not`. It honours `not: false`; a
 * `not: true` or `not: {}` property, which it leaves out; a `not.const` or
 * `not.enum`, by generating again; a lone `not.type` on an untyped node (by
 * picking another type) or a type union (narrowed, `normalizeSchemaForJsf`);
 * and a lone `not.required` with an optional property to leave out. A body
 * the node's own type or bounds already rule out is honoured whatever JSF
 * does. `schema` is the node as JSF merges it, `$ref` target included.
 */
export function unhonouredNot(
  schema: JSONSchema7,
  site: NotSite,
): string | undefined {
  const body = schema.not;
  if (body === undefined || body === false) return undefined;
  if (
    body === true ||
    (isJSONSchema7(body) && Object.keys(body).length === 0)
  ) {
    return site.propertyValue
      ? undefined
      : "not rejects every value, which json-schema-faker can honour only by leaving a property out";
  }
  if (!isJSONSchema7(body)) return "not must be a schema";
  if (ruledOutByBase(schema, body)) return undefined;
  if (Reflect.get(schema, "faker") !== undefined) {
    return "json-schema-faker generates the faker method's value and never checks it against not";
  }
  if (site.inlinedReference || mergesAheadOfNot(schema)) {
    return "json-schema-faker ignores not beside allOf, anyOf, oneOf, if or a reference it cannot follow itself";
  }
  if (body.const !== undefined || body.enum !== undefined) return undefined;
  if (
    schema.const !== undefined ||
    schema.enum !== undefined ||
    schema.default !== undefined
  ) {
    return "json-schema-faker returns the node's const, enum or default value whatever not rejects";
  }
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "type") {
    return unavoidableType(schema, body.type);
  }
  if (
    keys.length === 1 &&
    keys[0] === "required" &&
    omittableNotRequired(schema, schema.properties, body) !== undefined
  ) {
    return undefined;
  }
  return "json-schema-faker honours only not.type, not.const, not.enum and not.required";
}

/** Why json-schema-faker cannot avoid `excluded`, if it cannot. */
function unavoidableType(
  schema: JSONSchema7,
  excluded: unknown,
): string | undefined {
  const types = generatedTypes(schema);
  if (types.length === 0) {
    // JSF picks another type itself, and may pick `integer`, a number.
    return typeList(excluded).includes("number") &&
      !typeList(excluded).includes("integer")
      ? "not.type number on an untyped node lets json-schema-faker pick integer, which is a number"
      : undefined;
  }
  if (types.length > 1 && narrowTypeUnion(types, excluded) !== undefined) {
    return undefined;
  }
  return "not.type rejects every type the node generates";
}
