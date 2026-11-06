import type { JSONSchema7 } from "json-schema";
import { createLocalRefResolver, type LocalRefResolver } from "./ref-index.js";
import { collectSchemaChildren, mapSchemaChildren } from "./schema-children.js";
import { isJSONSchema7 } from "./utils.js";

/** A reference on one schema node, with the schema the index resolves it to. */
interface ResolvedReference {
  keyword: "$ref" | "$dynamicRef";
  reference: string;
  target: JSONSchema7;
}

/**
 * Keywords a reference target does not bring into the node that holds the
 * reference. Its identifiers stay on the target itself, and its definitions
 * are reached only through references, which name the target's own copy.
 * Brought along, `$defs` would shadow the root's for json-schema-faker, which
 * registers a node's `$defs` as `#/$defs/...` while it walks below it.
 */
const TARGET_ONLY_KEYWORDS = [
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$defs",
  "definitions",
];

/**
 * A `$ref` json-schema-faker resolves itself: `#` or a `#/...` pointer. It
 * walks a pointer's segments as written, without percent-decoding them, so a
 * pointer holding a `%` escape is merged like any other reference.
 */
function isRootPointer(reference: string): boolean {
  if (reference.includes("%")) return false;
  return reference === "#" || reference.startsWith("#/");
}

/** Every `$ref` and `$dynamicRef` on `schema` that the index resolves. */
function resolvedReferences(
  schema: JSONSchema7,
  refs: LocalRefResolver,
): ResolvedReference[] {
  const references: ResolvedReference[] = [];
  for (const keyword of ["$ref", "$dynamicRef"] as const) {
    const reference: unknown = Reflect.get(schema, keyword);
    if (typeof reference !== "string") continue;
    const target = refs.resolve(schema, reference);
    if (isJSONSchema7(target)) references.push({ keyword, reference, target });
  }
  return references;
}

/**
 * Merge reference targets into the node that holds the references, the way
 * json-schema-faker merges a `$ref` it follows: the targets' keywords, with
 * the node's own keywords over them. `allOf` is the exception: the node's
 * entries are appended to the targets', since dropping either would generate
 * values that ignore the dropped entries.
 */
function mergeIntoHolder(
  holder: JSONSchema7,
  references: ReadonlyArray<{ keyword: string; target: JSONSchema7 }>,
): JSONSchema7 {
  const siblings: JSONSchema7 = { ...holder };
  for (const { keyword } of references)
    Reflect.deleteProperty(siblings, keyword);
  const merged: JSONSchema7 = {};
  const allOf: JSONSchema7["allOf"] = [];
  for (const { target } of references) {
    const brought: JSONSchema7 = { ...target };
    for (const keyword of TARGET_ONLY_KEYWORDS) {
      Reflect.deleteProperty(brought, keyword);
    }
    Object.assign(merged, brought);
    allOf.push(...(target.allOf ?? []));
  }
  Object.assign(merged, siblings);
  allOf.push(...(siblings.allOf ?? []));
  if (allOf.length > 0) merged.allOf = allOf;
  return merged;
}

/**
 * The view of a schema node that json-schema-faker generates from once
 * generation has resolved its references: every `$ref` and `$dynamicRef` the
 * index resolves, followed through chains of them, merged in by
 * `mergeIntoHolder`. A node without such a reference is its own view. Only
 * the keywords on the node itself are merged; subschemas stay as written.
 * The views are memoized per resolver; the schema must be free of reference
 * cycles, which `validateSchema` rejects.
 */
export function createReferenceViews(
  refs: LocalRefResolver,
): (schema: JSONSchema7) => JSONSchema7 {
  const views = new Map<JSONSchema7, JSONSchema7>();
  const view = (schema: JSONSchema7): JSONSchema7 => {
    const known = views.get(schema);
    if (known) return known;
    const references = resolvedReferences(schema, refs);
    const merged =
      references.length === 0
        ? schema
        : mergeIntoHolder(
            schema,
            references.map(({ keyword, target }) => ({
              keyword,
              target: view(target),
            })),
          );
    views.set(schema, merged);
    return merged;
  };
  return view;
}

/**
 * json-schema-faker follows a `$ref` that is `#` or a `#/...` JSON Pointer
 * from the document root. Any other `$ref` it looks up by its literal text
 * among the `$id`s under `$defs` and `properties`: it registers no anchor
 * and no `$id` under `definitions`, and resolves no `$id` against a base
 * URI, so such a `$ref` fails every request with "Unresolved $ref". It
 * ignores `$dynamicRef` altogether and generates an arbitrary value.
 *
 * Return a copy of `root` in which each such reference the index resolves is
 * merged into the node that holds it, the way json-schema-faker merges a
 * root JSON Pointer it follows (`mergeIntoHolder`): the target's `faker`,
 * `not`, `if`/`then`/`else` and `default` carry over as they would through a
 * pointer. A root JSON Pointer inside an embedded `$id` resource names a
 * schema of that resource, so it is merged as well. A root JSON Pointer is
 * also merged in the same way when the node it sits on reads a `not` (its
 * own or a target's), or is itself a `not` body, so the JSF copy encodes the `not` against the keywords it is merged with
 * (`normalizeSchemaForJsf`) and json-schema-faker never reaches a `not` body
 * through a `$ref` it would not look into. The target of a merged reference
 * has its own references merged first, so a chain collapses into one node.
 *
 * `root` must have passed `validateSchema`, which rejects reference cycles.
 * A reference the index cannot resolve is left as it is. When nothing is
 * merged, `root` itself comes back.
 */
export function inlineUnfollowedReferences(root: JSONSchema7): JSONSchema7 {
  const holders = referenceHolders(root);
  if (holders.length === 0) return root;

  const refs = createLocalRefResolver(root);
  const view = createReferenceViews(refs);
  const inlined = new Map<JSONSchema7, ResolvedReference[]>();
  const whole = new Set<JSONSchema7>();
  const pending: JSONSchema7[] = [];
  const inlineWhole = (schema: JSONSchema7): void => {
    if (whole.has(schema)) return;
    whole.add(schema);
    const references = resolvedReferences(schema, refs);
    if (references.length === 0) return;
    inlined.set(schema, references);
    for (const { target } of references) pending.push(target);
  };

  for (const { schema, notBody } of holders) {
    if (notBody || view(schema).not !== undefined) {
      inlineWhole(schema);
      continue;
    }
    // A pointer inside an embedded `$id` resource names a schema of that
    // resource, while json-schema-faker reads it from the document root.
    const inResource = refs.resolve(schema, "#") !== root;
    const unfollowed = resolvedReferences(schema, refs).filter(
      ({ keyword, reference }) =>
        keyword === "$dynamicRef" || inResource || !isRootPointer(reference),
    );
    if (unfollowed.length > 0) inlined.set(schema, unfollowed);
  }
  // A node merged whole must not bring a root JSON Pointer back with its
  // target, so every reference along the chain is merged too.
  while (pending.length > 0) {
    const target = pending.pop();
    if (target) inlineWhole(target);
  }
  if (inlined.size === 0) return root;
  return copyWithInlined(root, inlined, new Map());
}

/** A schema node holding a `$ref` or `$dynamicRef`. */
interface ReferenceHolder {
  schema: JSONSchema7;
  /** Whether the node is the body of a `not`. */
  notBody: boolean;
}

/** Every schema node holding a `$ref` or a `$dynamicRef`. */
function referenceHolders(root: JSONSchema7): ReferenceHolder[] {
  const holders: ReferenceHolder[] = [];
  const seen = new Set<JSONSchema7>();
  const notBodies = new Set<JSONSchema7>();
  const pending = [root];
  while (pending.length > 0) {
    const schema = pending.pop();
    if (!schema || seen.has(schema)) continue;
    seen.add(schema);
    if (
      Reflect.get(schema, "$dynamicRef") !== undefined ||
      typeof schema.$ref === "string"
    ) {
      holders.push({ schema, notBody: false });
    }
    for (const child of collectSchemaChildren(schema, "$")) {
      if (child.keyword === "not") notBodies.add(child.schema);
      pending.push(child.schema);
    }
  }
  for (const holder of holders) holder.notBody = notBodies.has(holder.schema);
  return holders;
}

/** A copy of `schema` and everything below it, with the references inlined. */
function copyWithInlined(
  schema: JSONSchema7,
  inlined: Map<JSONSchema7, ResolvedReference[]>,
  copies: Map<JSONSchema7, JSONSchema7>,
): JSONSchema7 {
  const existing = copies.get(schema);
  if (existing) return existing;
  const copy: JSONSchema7 = { ...schema };
  copies.set(schema, copy);

  for (const { keyword, value } of mapSchemaChildren(schema, (child) =>
    isJSONSchema7(child) ? copyWithInlined(child, inlined, copies) : child,
  )) {
    Reflect.set(copy, keyword, value);
  }

  const references = inlined.get(schema);
  if (references) {
    const merged = mergeIntoHolder(
      copy,
      references.map(({ keyword, target }) => ({
        keyword,
        target: copyWithInlined(target, inlined, copies),
      })),
    );
    // The memo already hands out `copy`, so it becomes the merged node.
    for (const keyword of Object.keys(copy)) {
      Reflect.deleteProperty(copy, keyword);
    }
    Object.assign(copy, merged);
  }
  return copy;
}
