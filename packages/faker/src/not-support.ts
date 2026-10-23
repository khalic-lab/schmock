import type { JSONSchema7 } from "json-schema";
import { type NullUnion, nullUnion } from "./root-array.js";
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
interface NotSite {
  /** The node is a `properties` value, which JSF leaves out when nothing fits. */
  propertyValue: boolean;
  /**
   * JSF merges the node into its parent (`mergeSchemas`): it is an `allOf`
   * entry, an `anyOf` or `oneOf` branch, or an `if`, `then` or `else`, or a
   * reference reaches it from one. The merge has no `not`, so it is dropped.
   */
  mergedIntoParent: boolean;
}

/**
 * Keywords whose subschema json-schema-faker merges into the schema that
 * holds it, through a merge that drops the subschema's `not`.
 */
const MERGED_POSITIONS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
]);

/** Reference keywords: generation merges the target into the node holding them. */
const REFERENCE_KEYWORDS = new Set(["$ref", "$dynamicRef"]);

/** A generating edge of the schema graph `validateSchema` builds. */
export interface NotWalkEdge {
  schema: JSONSchema7;
  keyword: string;
  path: string;
  generates: boolean;
}

/** One way of reaching a schema node during `findUnhonouredNot`. */
interface NotFrame {
  schema: JSONSchema7;
  path: string;
  site: NotSite;
  /**
   * Reached through a reference: generation merges the node into the one
   * holding the reference, where its `not` was already judged.
   */
  judged: boolean;
  /**
   * The keywords of the null union this node is the non-null branch of. The
   * enhancer unwraps the union into the branch, these keywords over it, so
   * the branch is generated in its parent's place rather than merged into it.
   */
  wrapper?: JSONSchema7;
}

/**
 * The first `not`, on a path that generates from `root`, that
 * json-schema-faker would not honour (`unhonouredNot`), with its path.
 * `edgesOf` lists a node's subschema and reference edges; `view` gives a
 * node with the references generation follows merged in
 * (`createReferenceViews`). A node reached in two ways (as a property and as
 * an `allOf` entry, say) is judged once for each.
 */
export function findUnhonouredNot(
  root: JSONSchema7,
  rootPath: string,
  edgesOf: (schema: JSONSchema7) => readonly NotWalkEdge[],
  view: (schema: JSONSchema7) => JSONSchema7,
): { path: string; issue: string } | undefined {
  const seen = new Map<JSONSchema7, Set<number>>();
  const pending: NotFrame[] = [
    {
      schema: root,
      path: rootPath,
      site: { propertyValue: false, mergedIntoParent: false },
      judged: false,
    },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) break;
    const { schema, site } = frame;
    if (!frame.wrapper) {
      const reach =
        (site.propertyValue ? 1 : 0) |
        (site.mergedIntoParent ? 2 : 0) |
        (frame.judged ? 4 : 0);
      const reaches = seen.get(schema) ?? new Set<number>();
      if (reaches.has(reach)) continue;
      reaches.add(reach);
      seen.set(schema, reaches);
    }

    if (!frame.judged) {
      const merged = frame.wrapper
        ? { ...view(schema), ...frame.wrapper }
        : view(schema);
      // Generation merges a reference in a `not` body into the body too.
      const node = isJSONSchema7(merged.not)
        ? { ...merged, not: view(merged.not) }
        : merged;
      const issue =
        node.not === undefined ? undefined : unhonouredNot(node, site);
      if (issue !== undefined) return { path: `${frame.path}.not`, issue };
    }

    const union = unwrappedNullUnion(schema);
    const edges = edgesOf(schema);
    for (let index = edges.length - 1; index >= 0; index -= 1) {
      const edge = edges[index];
      if (!edge.generates) continue;
      if (REFERENCE_KEYWORDS.has(edge.keyword)) {
        pending.push({
          schema: edge.schema,
          path: edge.path,
          site,
          judged: true,
        });
      } else if (
        union &&
        edge.keyword === union.keyword &&
        edge.schema === union.branch
      ) {
        pending.push({
          schema: edge.schema,
          path: edge.path,
          site,
          judged: false,
          wrapper: union.wrapper,
        });
      } else {
        pending.push({
          schema: edge.schema,
          path: edge.path,
          site: {
            propertyValue: edge.keyword === "properties",
            mergedIntoParent: MERGED_POSITIONS.has(edge.keyword),
          },
          judged: false,
        });
      }
    }
  }
  return undefined;
}

/**
 * The two-branch null union on `schema` that the enhancer unwraps
 * (`unwrapNullUnion` in schema-enhancement.ts), with the node's other
 * keywords, which it merges over the non-null branch. It leaves a union with
 * `schmockNullable: false` alone, and an unmarked one whose other keywords
 * repeat one of the branch's.
 */
function unwrappedNullUnion(
  schema: JSONSchema7,
): (NullUnion & { wrapper: JSONSchema7 }) | undefined {
  const marker: unknown = Reflect.get(schema, "schmockNullable");
  if (marker === false) return undefined;
  const union = nullUnion(schema);
  if (!union) return undefined;
  const { [union.keyword]: _unwrapped, ...wrapper } = schema;
  if (
    marker !== true &&
    Object.keys(wrapper).some((key) => Object.hasOwn(union.branch, key))
  ) {
    return undefined;
  }
  return { ...union, wrapper };
}

/**
 * Why json-schema-faker would generate values that `schema`'s `not` rejects,
 * or undefined when it honours the `not`. It honours `not: false`; a
 * `not: true` or `not: {}` property, which it leaves out; a `not.const` or
 * `not.enum`, by generating again; a lone `not.type` on an untyped node (by
 * picking another type) or a type union (narrowed, `normalizeSchemaForJsf`);
 * and a lone `not.required` with an optional property to leave out, all
 * only where JSF generates the node itself rather than merging it into a
 * parent. A body the node's own type or bounds already rule out is honoured
 * whatever JSF does. `schema` is the node as generation merges it, the
 * targets of its references (and of its `not` body's) included.
 */
function unhonouredNot(schema: JSONSchema7, site: NotSite): string | undefined {
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
  if (site.mergedIntoParent) {
    return "json-schema-faker merges an allOf entry, an anyOf or oneOf branch, or an if, then or else into its parent and drops its not";
  }
  if (Reflect.get(schema, "faker") !== undefined) {
    return "json-schema-faker generates the faker method's value and never checks it against not";
  }
  if (mergesAheadOfNot(schema)) {
    return "json-schema-faker ignores not beside allOf, anyOf, oneOf or if";
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
  const rejected = typeList(excluded);
  if (
    types.includes("number") &&
    rejected.includes("integer") &&
    !rejected.includes("number")
  ) {
    return "not.type integer beside type number lets json-schema-faker generate an integral number, which is an integer";
  }
  return "not.type rejects every type the node generates";
}
