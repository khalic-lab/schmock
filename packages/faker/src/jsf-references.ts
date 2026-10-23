import type { JSONSchema7 } from "json-schema";
import { createLocalRefResolver } from "./ref-index.js";
import { collectSchemaChildren, mapSchemaChildren } from "./schema-children.js";
import { isJSONSchema7 } from "./utils.js";

/** A reference on one schema node that json-schema-faker cannot follow. */
interface UnfollowedReference {
  keyword: "$ref" | "$dynamicRef";
  target: JSONSchema7;
}

/**
 * json-schema-faker follows a `$ref` that is `#` or a `#/...` JSON Pointer
 * from the document root. Any other `$ref` it looks up by its literal text
 * among the `$id`s under `$defs` and `properties`: it registers no anchor
 * and no `$id` under `definitions`, and resolves no `$id` against a base
 * URI, so such a `$ref` fails every request with "Unresolved $ref". It
 * ignores `$dynamicRef` altogether and generates an arbitrary value.
 *
 * Return `root` with every reference other than a root JSON Pointer that
 * the reference index resolves replaced by its target as one more `allOf`
 * entry, which json-schema-faker merges into the value it generates. The
 * index resolves anchors, `$dynamicRef` and `$id`s the way validation does,
 * so generation reaches the schema validation charged. `root` must have
 * passed `validateSchema`, which rejects reference cycles. A reference the
 * index cannot resolve is left as it is. When nothing is replaced, `root`
 * itself comes back.
 */
export function inlineUnfollowedReferences(root: JSONSchema7): JSONSchema7 {
  const holders = referenceHolders(root);
  if (holders.length === 0) return root;

  const refs = createLocalRefResolver(root);
  const inlined = new Map<JSONSchema7, UnfollowedReference[]>();
  for (const schema of holders) {
    const references: UnfollowedReference[] = [];
    for (const keyword of ["$ref", "$dynamicRef"] as const) {
      const reference: unknown = Reflect.get(schema, keyword);
      if (typeof reference !== "string") continue;
      if (keyword === "$ref" && isRootPointer(reference)) continue;
      const target = refs.resolve(schema, reference);
      if (isJSONSchema7(target)) references.push({ keyword, target });
    }
    if (references.length > 0) inlined.set(schema, references);
  }
  if (inlined.size === 0) return root;
  return copyWithInlined(root, inlined, new Map());
}

function isRootPointer(reference: string): boolean {
  return reference === "#" || reference.startsWith("#/");
}

/** Every schema node holding a `$dynamicRef` or a `$ref` beyond a root pointer. */
function referenceHolders(root: JSONSchema7): JSONSchema7[] {
  const holders: JSONSchema7[] = [];
  const seen = new Set<JSONSchema7>();
  const pending = [root];
  while (pending.length > 0) {
    const schema = pending.pop();
    if (!schema || seen.has(schema)) continue;
    seen.add(schema);
    const ref = schema.$ref;
    if (
      Reflect.get(schema, "$dynamicRef") !== undefined ||
      (typeof ref === "string" && !isRootPointer(ref))
    ) {
      holders.push(schema);
    }
    for (const child of collectSchemaChildren(schema, "$")) {
      pending.push(child.schema);
    }
  }
  return holders;
}

/** A copy of `schema` and everything below it, with the references inlined. */
function copyWithInlined(
  schema: JSONSchema7,
  inlined: Map<JSONSchema7, UnfollowedReference[]>,
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
    for (const { keyword } of references) Reflect.deleteProperty(copy, keyword);
    copy.allOf = [
      ...(copy.allOf ?? []),
      ...references.map(({ target }) =>
        copyWithInlined(target, inlined, copies),
      ),
    ];
  }
  return copy;
}
