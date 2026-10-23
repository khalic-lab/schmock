import type { JSONSchema7 } from "json-schema";
import { isJSONSchema7 } from "./utils.js";

/** The enhancer's null-roll markers, which a resized root must keep. */
export const NULLABLE_MARKERS = ["schmockNullable", "schmockNullAlternative"];

/** Keys that leave a single-entry `allOf` root standing for its entry alone. */
const ALLOF_WRAPPER_KEYS = new Set([
  "allOf",
  "$schema",
  "$id",
  "$comment",
  "$defs",
  "definitions",
  "title",
  "description",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  ...NULLABLE_MARKERS,
]);

export interface RootArrayRules {
  /** The schema the `$ref` on `schema` names, if it names one. */
  resolve: (schema: JSONSchema7) => JSONSchema7 | undefined;
  /** Whether `schema` is the array the root value is generated from. */
  isArray: (schema: JSONSchema7) => boolean;
  /**
   * Also step into the array branch of a two-branch `anyOf`/`oneOf` whose
   * other branch is a bare `{type: "null"}`. The enhancer has already
   * unwrapped that union on the schema generation sizes, so only a reader of
   * the schema as written needs it.
   */
  throughNullUnions?: boolean;
}

/** A two-branch `anyOf`/`oneOf` whose other branch is a bare `{type: "null"}`. */
export interface NullUnion {
  keyword: "anyOf" | "oneOf";
  /** The branch that is not the bare null one. */
  branch: JSONSchema7;
}

/** The two-branch null union on `schema`, if it holds one. */
export function nullUnion(schema: JSONSchema7): NullUnion | undefined {
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length !== 2) continue;
    const other = branches.find((branch) => !isBareNull(branch));
    if (other !== undefined && branches.some(isBareNull)) {
      return isJSONSchema7(other) ? { keyword, branch: other } : undefined;
    }
  }
  return undefined;
}

/** The other branch of a two-branch null union, if `schema` is one. */
function nullUnionBranch(schema: JSONSchema7): JSONSchema7 | undefined {
  return nullUnion(schema)?.branch;
}

function isBareNull(branch: unknown): boolean {
  return (
    isJSONSchema7(branch) &&
    branch.type === "null" &&
    Object.keys(branch).length === 1
  );
}

/**
 * The array node a root value is generated from: the root itself, or what a
 * root `$ref` or a single-entry `allOf` with nothing else to merge stands for
 * (and, with `throughNullUnions`, a null union). Generation sizes this array
 * with `count`, and validation checks `count` against it. Undefined when the
 * root is not such an array.
 */
export function findRootArray(
  root: JSONSchema7,
  rules: RootArrayRules,
): JSONSchema7 | undefined {
  const visited = new Set<JSONSchema7>();
  let node: JSONSchema7 | undefined = root;
  while (node && !visited.has(node)) {
    visited.add(node);
    if (rules.isArray(node)) return node;
    if (typeof node.$ref === "string") {
      node = rules.resolve(node);
    } else if (
      node.allOf?.length === 1 &&
      Object.keys(node).every((key) => ALLOF_WRAPPER_KEYS.has(key)) &&
      isJSONSchema7(node.allOf[0])
    ) {
      const [entry] = node.allOf;
      node = typeof entry.$ref === "string" ? rules.resolve(entry) : entry;
    } else if (rules.throughNullUnions) {
      node = nullUnionBranch(node);
    } else {
      node = undefined;
    }
  }
  return undefined;
}
