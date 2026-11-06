import type { JSONSchema7 } from "json-schema";
import type { CrudResource } from "./crud-detector.js";
import { hasType, isRecord, toJsonSchema } from "./utils.js";

/*
 * Reading what an object contract declares, and which array of a list
 * envelope carries the collection. CRUD detection, route registration and the
 * generators all ask these questions of the same schemas.
 */

/**
 * Result of finding the array property in a response schema.
 * If `property` is undefined, the schema is a flat array (or unknown).
 */
export interface ArrayPropertyInfo {
  /**
   * Top-level property holding (or, for a nested envelope, containing) the
   * array — `"data"` for `{data:[…]}`, `"page"` for `{page:{items:[…]}}`.
   * Undefined for flat arrays.
   */
  property?: string;
  /** For a nested envelope, the property inside `property` holding the array. */
  innerProperty?: string;
  /**
   * Schema for the array items — the declared object itself, not a copy, so
   * identity-keyed lookups (`collectAccessModes`) still find it.
   */
  itemSchema?: JSONSchema7;
}

/** Path to the array a wrapper carries (`["data"]`, `["page", "items"]`), if any. */
export function arrayPropertyPath(
  info: ArrayPropertyInfo,
): string[] | undefined {
  if (info.property === undefined) return undefined;
  return info.innerProperty === undefined
    ? [info.property]
    : [info.property, info.innerProperty];
}

/**
 * What is already known about the resource a list envelope carries, used to
 * pick the right array when the envelope declares more than one.
 */
export interface ArrayPropertyHints {
  /** Property names that identify the resource's primary key, most specific first. */
  idProperties?: readonly string[];
  /** The resource's item schema, when already known. */
  itemSchema?: JSONSchema7;
}

/** Envelope keys conventionally holding a page of items. */
const CONVENTIONAL_LIST_KEYS = new Set([
  "data",
  "items",
  "results",
  "result",
  "content",
  "value",
  "values",
  "records",
  "entries",
  "list",
]);

const PRIMITIVE_TYPES = ["string", "number", "integer", "boolean", "null"];

/** The `{ type: "null" }` branch a nullable composition carries. */
function isNullBranch(branch: JSONSchema7): boolean {
  return branch.type === "null" && Object.keys(branch).length === 1;
}

/**
 * The node inside the normalizer's composition-only nullable wrapper,
 * `{ anyOf: [{ type: "null" }, node], schmockNullable: true }`, or the schema
 * itself. The node is returned as declared, not copied, so identity-keyed
 * lookups (`collectAccessModes`) still find it.
 */
export function unwrapNullable(schema: JSONSchema7): JSONSchema7 {
  if (
    typeof schema !== "object" ||
    schema === null ||
    !("schmockNullable" in schema) ||
    schema.schmockNullable !== true
  ) {
    return schema;
  }
  const branches = (schema.anyOf ?? []).filter(
    (branch): branch is JSONSchema7 =>
      typeof branch === "object" && !isNullBranch(branch),
  );
  return branches.length === 1 ? branches[0] : schema;
}

/**
 * The non-null alternative of a nullable schema, to generate a value that must
 * be an object: the node inside the composition wrapper ({@link
 * unwrapNullable}), or a copy of a typed `type: [T, "null"]` node without the
 * `null` type and without the `schmockNullable` marker, which faker reads as
 * "roll null ~5%" on its own. Only for generation: the copy defeats the
 * identity-keyed lookups `unwrapNullable` preserves.
 */
export function nonNullable(schema: JSONSchema7): JSONSchema7 {
  const node = unwrapNullable(schema);
  if (node !== schema || !Array.isArray(node.type)) return node;
  if (!node.type.includes("null")) return node;
  const types = node.type.filter((type) => type !== "null");
  if (types.length === 0) return node;
  const copy: JSONSchema7 = {
    ...node,
    type: types.length === 1 ? types[0] : types,
  };
  Reflect.deleteProperty(copy, "schmockNullable");
  return copy;
}

/**
 * Object-shaped by declaration: `type: object` (alone or in a union), no
 * `type` at all with `properties`/`allOf`, or an `anyOf`/`oneOf` whose every
 * non-null branch is object-shaped — a polymorphic `oneOf: [Cat, Dog]`, or the
 * normalizer's nullable wrapper around an object. The same rule
 * `generateContractBase` uses: a wrapper that omits `type` is still an object.
 */
export function isObjectShaped(
  schema: JSONSchema7,
  seen: Set<object> = new Set(),
): boolean {
  if (hasType(schema, "object")) return true;
  if (schema.type !== undefined || seen.has(schema)) return false;
  if (isRecord(schema.properties) || Array.isArray(schema.allOf)) return true;
  seen.add(schema);
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = (schema[keyword] ?? []).filter(
      (branch): branch is JSONSchema7 =>
        typeof branch === "object" && !isNullBranch(branch),
    );
    if (
      branches.length > 0 &&
      branches.every((branch) => isObjectShaped(branch, seen))
    ) {
      return true;
    }
  }
  return false;
}

/** First items schema of an array, as declared (no copy). */
function arrayItemSchema(schema: JSONSchema7): JSONSchema7 | undefined {
  const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  return typeof items === "object" && items !== null ? items : undefined;
}

/** Resource-derived hints for {@link findArrayProperty} on a list route. */
export function listArrayHints(
  resource: Pick<CrudResource, "idProperty" | "idParam" | "schema">,
): ArrayPropertyHints {
  const idProperties = [
    ...new Set([resource.idProperty, resource.idParam, "id"]),
  ].filter((name) => name.length > 0);
  return { idProperties, itemSchema: resource.schema };
}

/**
 * Find which property in a response schema holds the array of items.
 * Handles flat arrays, object wrappers (Stripe), typeless wrappers, allOf
 * compositions (Scalar Galaxy) and one level of nesting (`{page:{items}}`,
 * HAL `_embedded`).
 *
 * When the envelope declares several arrays (`errors`, `links`, `warnings`
 * next to the items), they are ranked rather than taken in declaration order:
 * see {@link rankArrayCandidates}.
 */
export function findArrayProperty(
  schema: JSONSchema7,
  hints: ArrayPropertyHints = {},
): ArrayPropertyInfo {
  if (!schema || typeof schema === "boolean") return {};

  // Case 1: flat array
  if (hasType(schema, "array")) {
    return { itemSchema: arrayItemSchema(schema) };
  }

  // Case 2: object envelope — typed or not, with or without allOf
  if (isObjectShaped(schema)) {
    const best = rankArrayCandidates(collectArrayCandidates(schema), hints);
    if (best) {
      const [property, innerProperty] = best.path;
      return innerProperty === undefined
        ? { property, itemSchema: best.itemSchema }
        : { property, innerProperty, itemSchema: best.itemSchema };
    }
  }

  // Case 3: anyOf/oneOf — try the first meaningful branch. The normalizer wraps
  // a composition-only `nullable: true` as `anyOf: [{type:"null"}, rest]`, so a
  // bare null branch must be skipped rather than read as the shape.
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0) {
      for (const branch of branches) {
        if (!isRecord(branch)) continue;
        if (branch.type === "null" && Object.keys(branch).length === 1)
          continue;
        return findArrayProperty(toJsonSchema(branch), hints);
      }
    }
  }

  return {};
}

/**
 * Flatten a schema's declared properties, following `allOf` branches.
 *
 * Used to answer two questions that both need "what does this contract declare":
 * which property carries the primary key, and which request fields survive an
 * `additionalProperties: false` create contract. Earlier branches win, matching
 * the way a merged `allOf` resolves.
 *
 * The record has no prototype, so `name in properties` answers for declared
 * names only: on a plain `{}` it was true for `toString` or `constructor`,
 * which let those request fields through a closed contract and dropped a
 * schema property actually named `constructor`.
 */
export function collectSchemaProperties(
  schema?: JSONSchema7,
): Record<string, JSONSchema7> {
  const out: Record<string, JSONSchema7> = Object.create(null);

  const visit = (node?: JSONSchema7): void => {
    if (!node || typeof node === "boolean") return;
    if (isRecord(node.properties)) {
      for (const [key, value] of Object.entries(node.properties)) {
        if (isRecord(value) && !Object.hasOwn(out, key)) {
          out[key] = toJsonSchema(value);
        }
      }
    }
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        if (isRecord(branch)) visit(toJsonSchema(branch));
      }
    }
  };

  // A nullable item (`type: object, nullable: true, allOf: […]`) arrives
  // wrapped as `anyOf: [{type:"null"}, node]`; its properties are the node's.
  visit(schema && unwrapNullable(schema));
  return out;
}

interface ArrayCandidate {
  path: string[];
  itemSchema?: JSONSchema7;
}

/**
 * Every declaration of every property of an object schema: its own
 * `properties`, then its `allOf` branches, recursively. A key declared in
 * several branches yields one entry per declaration — a generic
 * `Wrapper-Collection` declaring `data: object[]` next to the operation's own
 * `data: Booking[]` — so the ranking, not a merge order, decides between them.
 */
export function propertyDeclarations(
  schema: JSONSchema7,
): Array<[string, JSONSchema7]> {
  const out: Array<[string, JSONSchema7]> = [];
  const seen = new Set<object>();
  const visit = (node: JSONSchema7): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.properties && typeof node.properties === "object") {
      for (const [key, value] of Object.entries(node.properties)) {
        if (typeof value === "object") out.push([key, value]);
      }
    }
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        if (typeof branch === "object") visit(branch);
      }
    }
  };
  visit(schema);
  return out;
}

/**
 * Property names that reach `Object.prototype` (or a constructor) when used as
 * a key. A spec is untrusted input, so these never become a path the
 * collection is written along.
 */
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The array a property declares, looking through the compositions real specs
 * wrap it in: `anyOf: [{type: array, …}, {type: null}]` (FastAPI/pydantic on
 * 3.1), a 3.0 `allOf` + `nullable: true` (normalized to that same `anyOf`), or
 * a `oneOf` array-or-object. A declared non-array `type` ends the search, and
 * `{type: "null"}` branches are skipped by that rule. `items` is optional: a
 * bare `{type: array}` is valid 3.1 and still carries the collection.
 */
function declaredArray(
  schema: JSONSchema7,
  seen: Set<object> = new Set(),
): JSONSchema7 | undefined {
  if (seen.has(schema)) return undefined;
  seen.add(schema);
  if (hasType(schema, "array")) return schema;
  if (schema.type !== undefined) return undefined;
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!isRecord(branch)) continue;
      const found = declaredArray(branch, seen);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Every array property of an object envelope: its own (and its `allOf`
 * branches') properties first, then one level down inside object-shaped
 * properties. Declaration order is preserved within each level.
 */
function collectArrayCandidates(schema: JSONSchema7): ArrayCandidate[] {
  const top: ArrayCandidate[] = [];
  const nested: ArrayCandidate[] = [];
  for (const [key, prop] of propertyDeclarations(schema)) {
    if (PROTOTYPE_KEYS.has(key)) continue;
    const array = declaredArray(prop);
    if (array) {
      top.push({ path: [key], itemSchema: arrayItemSchema(array) });
      continue;
    }
    if (!isObjectShaped(prop)) continue;
    for (const [inner, innerProp] of propertyDeclarations(prop)) {
      if (PROTOTYPE_KEYS.has(inner)) continue;
      const innerArray = declaredArray(innerProp);
      if (innerArray) {
        nested.push({
          path: [key, inner],
          itemSchema: arrayItemSchema(innerArray),
        });
      }
    }
  }
  return [...top, ...nested];
}

/**
 * Parent keys that mark a nested level as a list envelope (`_embedded` for
 * HAL, `page`/`data`/`result` for paged APIs).
 */
const NESTED_ENVELOPE_KEYS = new Set([
  "_embedded",
  "embedded",
  "page",
  "data",
  "result",
  "results",
  "response",
  "payload",
]);

/**
 * Pick the array most likely to carry the resource, by, in order:
 *
 * 1. being the very items object the resource schema came from;
 * 2. declaring the resource's id property (most specific hint first) — the
 *    rule `findResourceWrapper` already uses for create envelopes;
 * 3. sharing the most property names with the known item schema;
 * 4. holding objects rather than primitives (`warnings: string[]`);
 * 5. a conventional name (`data`, `items`, `results`, …);
 * 6. sitting at the top level rather than one level down;
 * 7. declaration order.
 *
 * Taking the first array in declaration order injected the collection into an
 * `errors`/`links` array declared before the real one and derived the resource
 * schema from it.
 *
 * A nested array only competes with evidence that it is the list — one of
 * signals 1-3, or an envelope parent key — so an ordinary object that happens
 * to hold an array (`card_issuing.status_details`) is not read as a wrapper.
 */
function rankArrayCandidates(
  candidates: ArrayCandidate[],
  hints: ArrayPropertyHints,
): ArrayCandidate | undefined {
  const idNames = hints.idProperties?.length ? hints.idProperties : ["id"];
  const reference = new Set(
    Object.keys(collectSchemaProperties(hints.itemSchema)),
  );

  const score = (candidate: ArrayCandidate): number[] => {
    const items = candidate.itemSchema;
    const props = collectSchemaProperties(items);
    const idRank = idNames.findIndex((name) => name in props);
    let overlap = 0;
    for (const name of Object.keys(props)) {
      if (reference.has(name)) overlap++;
    }
    const primitive =
      items !== undefined &&
      !isObjectShaped(items) &&
      PRIMITIVE_TYPES.some((type) => hasType(items, type));
    const leaf = candidate.path[candidate.path.length - 1];
    return [
      items !== undefined && items === hints.itemSchema ? 0 : 1,
      idRank === -1 ? idNames.length : idRank,
      -overlap,
      primitive ? 1 : 0,
      CONVENTIONAL_LIST_KEYS.has(leaf) ? 0 : 1,
      candidate.path.length,
    ];
  };

  const admitted = candidates.filter((candidate) => {
    if (candidate.path.length === 1) return true;
    if (NESTED_ENVELOPE_KEYS.has(candidate.path[0])) return true;
    const [identity, idRank, negOverlap] = score(candidate);
    return identity === 0 || idRank < idNames.length || negOverlap < 0;
  });
  if (admitted.length <= 1) return admitted[0];

  let best = admitted[0];
  let bestScore = score(best);
  for (const candidate of admitted.slice(1)) {
    const candidateScore = score(candidate);
    const diff = candidateScore.findIndex((v, i) => v !== bestScore[i]);
    // Strictly better only: ties keep the earlier declaration.
    if (diff !== -1 && candidateScore[diff] < bestScore[diff]) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
}
