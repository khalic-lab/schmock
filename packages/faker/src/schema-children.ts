import type { JSONSchema7 } from "json-schema";
import { isJSONSchema7 } from "./utils.js";

export interface SchemaChild {
  schema: JSONSchema7;
  /** The `SCHEMA_KEYWORDS` keyword the child sits under. */
  keyword: string;
  path: string;
  depthCost: 0 | 1;
  frameCost: 0 | 1;
  typedContinuation: boolean;
  /**
   * False for keywords whose subschema never produces a value of its own:
   * `not` only tests the value, `if` tests it unless a sibling `then` is
   * present (json-schema-faker then merges `if` into what it generates), and
   * `definitions`/`$defs` are reached for generation only through a `$ref`.
   * Resource limits are charged along generating edges only.
   */
  generates: boolean;
}

interface ChildCost {
  depthCost: 0 | 1;
  frameCost: 0 | 1;
}

/**
 * How a keyword holds its subschemas: one schema (`not`), a list of schemas
 * (`allOf`), or a name-to-schema map (`properties`).
 */
type SchemaKeywordShape = "single" | "array" | "map";

interface SchemaKeyword {
  keyword: string;
  shape: SchemaKeywordShape;
  /** False when the subschema only tests or defines, never generating itself. */
  generates: boolean;
  /**
   * A sibling keyword that makes a non-generating subschema generate: when the
   * parent also holds it, json-schema-faker merges this subschema into what it
   * generates (`if` is merged with `then`).
   */
  generatesWith?: string;
  costs: ChildCost;
  /** The declared type under which a child continues the typed chain. */
  typedAs?: "array" | "object";
  /** Draft-7 `items`: a single schema, or a list in the tuple form. */
  tupleForm?: true;
}

/** A child one value level down (a property, an item). */
const VALUE_LEVEL: ChildCost = { depthCost: 1, frameCost: 0 };
/** A child describing the same value (composition, conditionals). */
const SAME_LEVEL: ChildCost = { depthCost: 0, frameCost: 1 };

/**
 * Every schema-bearing keyword Schmock forwards to json-schema-faker. The
 * validating walker (`collectSchemaChildren`) and the two rewriting walkers
 * (smart mapping in `schema-enhancement.ts`, JSF normalization in
 * `jsf-config.ts`) all read this one table, so a keyword added here is
 * validated, enhanced and normalized alike.
 *
 * Order is load-bearing: children are visited in table order, and JSF
 * normalization draws a seed for every `patternProperties` key it invents in
 * visiting order. Reordering entries changes seeded output.
 *
 * Known gap: `unevaluatedProperties` and `unevaluatedItems` are not listed.
 * No walker descends into them, and JSF normalization strips them (they are
 * not in `JSF_SCHEMA_KEYWORDS`), so they are neither validated nor generated.
 * Adding them here would also require forwarding them to json-schema-faker.
 */
export const SCHEMA_KEYWORDS: readonly SchemaKeyword[] = [
  {
    keyword: "properties",
    shape: "map",
    generates: true,
    costs: VALUE_LEVEL,
    typedAs: "object",
  },
  { keyword: "definitions", shape: "map", generates: false, costs: SAME_LEVEL },
  { keyword: "$defs", shape: "map", generates: false, costs: SAME_LEVEL },
  {
    keyword: "patternProperties",
    shape: "map",
    generates: true,
    costs: VALUE_LEVEL,
  },
  {
    keyword: "items",
    shape: "single",
    generates: true,
    costs: VALUE_LEVEL,
    typedAs: "array",
    tupleForm: true,
  },
  {
    keyword: "additionalItems",
    shape: "single",
    generates: true,
    costs: VALUE_LEVEL,
  },
  {
    keyword: "prefixItems",
    shape: "array",
    generates: true,
    costs: VALUE_LEVEL,
    typedAs: "array",
  },
  { keyword: "allOf", shape: "array", generates: true, costs: SAME_LEVEL },
  { keyword: "anyOf", shape: "array", generates: true, costs: SAME_LEVEL },
  { keyword: "oneOf", shape: "array", generates: true, costs: SAME_LEVEL },
  {
    keyword: "additionalProperties",
    shape: "single",
    generates: true,
    costs: VALUE_LEVEL,
  },
  { keyword: "contains", shape: "single", generates: true, costs: VALUE_LEVEL },
  { keyword: "not", shape: "single", generates: false, costs: SAME_LEVEL },
  {
    keyword: "if",
    shape: "single",
    generates: false,
    generatesWith: "then",
    costs: SAME_LEVEL,
  },
  { keyword: "then", shape: "single", generates: true, costs: SAME_LEVEL },
  { keyword: "else", shape: "single", generates: true, costs: SAME_LEVEL },
  {
    keyword: "propertyNames",
    shape: "single",
    generates: true,
    costs: VALUE_LEVEL,
  },
  // Entries that are string arrays are property lists, not subschemas.
  { keyword: "dependencies", shape: "map", generates: true, costs: SAME_LEVEL },
  {
    keyword: "contentSchema",
    shape: "single",
    generates: true,
    costs: SAME_LEVEL,
  },
  {
    keyword: "dependentSchemas",
    shape: "map",
    generates: true,
    costs: SAME_LEVEL,
  },
  {
    keyword: "containsAll",
    shape: "array",
    generates: true,
    costs: VALUE_LEVEL,
  },
];

/** Where an entry sits inside its keyword. */
type ChildLocation =
  | { form: "single" }
  | { form: "array"; index: number }
  | { form: "map"; name: string };

/** The keyword and position a mapped entry comes from. */
export interface SchemaChildSlot {
  keyword: string;
  location: ChildLocation;
}

interface HeldEntry {
  value: unknown;
  location: ChildLocation;
}

interface HeldKeyword {
  descriptor: SchemaKeyword;
  form: SchemaKeywordShape;
  entries: HeldEntry[];
}

/**
 * The entries a keyword holds, when its value has the keyword's shape. A list
 * or map keyword of the wrong shape (an `allOf` object) holds nothing and is
 * left as it is by every walker; `validateSchema` rejects it (see
 * `misshapenKeyword`), so only the walkers called directly ever meet one. A
 * map accepts any object, arrays included, so a malformed array-valued map is
 * still walked (by index) and validated rather than skipped.
 */
function readKeyword(
  schema: JSONSchema7,
  descriptor: SchemaKeyword,
): HeldKeyword | undefined {
  const value: unknown = Reflect.get(schema, descriptor.keyword);
  if (value === undefined) return undefined;
  const listed =
    descriptor.shape === "array" ||
    (descriptor.tupleForm === true && Array.isArray(value));
  if (listed) {
    if (!Array.isArray(value)) return undefined;
    return {
      descriptor,
      form: "array",
      entries: value.map((entry, index) => ({
        value: entry,
        location: { form: "array", index },
      })),
    };
  }
  if (descriptor.shape === "map") {
    if (typeof value !== "object" || value === null) return undefined;
    return {
      descriptor,
      form: "map",
      entries: Object.entries(value).map(([name, entry]) => ({
        value: entry,
        location: { form: "map", name },
      })),
    };
  }
  return {
    descriptor,
    form: "single",
    entries: [{ value, location: { form: "single" } }],
  };
}

/**
 * The first list or map keyword whose value has the wrong shape (an `allOf`
 * object, a `patternProperties` string). Every walker skips such a keyword,
 * so validation rejects it rather than let it pass unchecked.
 */
export function misshapenKeyword(schema: JSONSchema7): string | undefined {
  for (const descriptor of SCHEMA_KEYWORDS) {
    if (
      Reflect.get(schema, descriptor.keyword) !== undefined &&
      readKeyword(schema, descriptor) === undefined
    ) {
      return descriptor.keyword;
    }
  }
  return undefined;
}

function* heldKeywords(schema: JSONSchema7): Generator<HeldKeyword> {
  for (const descriptor of SCHEMA_KEYWORDS) {
    const held = readKeyword(schema, descriptor);
    if (held) yield held;
  }
}

function pathSuffix(location: ChildLocation): string {
  switch (location.form) {
    case "single":
      return "";
    case "array":
      return `[${location.index}]`;
    case "map":
      return `.${location.name}`;
  }
}

/**
 * Enumerate every schema-bearing keyword forwarded to json-schema-faker, in
 * `SCHEMA_KEYWORDS` order. Validation consumes this list; the rewriting
 * walkers use `mapSchemaChildren` over the same table.
 */
export function collectSchemaChildren(
  schema: JSONSchema7,
  path: string,
): SchemaChild[] {
  const hasType = (type: "array" | "object"): boolean =>
    schema.type === type ||
    (Array.isArray(schema.type) && schema.type.includes(type));

  const children: SchemaChild[] = [];
  for (const { descriptor, entries } of heldKeywords(schema)) {
    const typedContinuation =
      descriptor.typedAs !== undefined && hasType(descriptor.typedAs);
    const generates =
      descriptor.generates ||
      (descriptor.generatesWith !== undefined &&
        Reflect.get(schema, descriptor.generatesWith) !== undefined);
    for (const { value, location } of entries) {
      if (!isJSONSchema7(value)) continue;
      children.push({
        schema: value,
        keyword: descriptor.keyword,
        path: `${path}.${descriptor.keyword}${pathSuffix(location)}`,
        depthCost: descriptor.costs.depthCost,
        frameCost: descriptor.costs.frameCost,
        typedContinuation,
        generates,
      });
    }
  }
  return children;
}

/**
 * Maps one entry of a schema-bearing keyword. It sees every entry (schema
 * objects, boolean schemas and malformed values alike) and returns the
 * replacement, or `undefined` to drop the entry. For a single-schema keyword,
 * `undefined` yields nothing for that keyword, so the caller keeps whatever it
 * already holds there.
 */
type SchemaChildMapper<T> = (
  child: unknown,
  slot: SchemaChildSlot,
) => T | undefined;

type MappedKeyword<T> =
  | { keyword: string; form: "single"; value: T }
  | { keyword: string; form: "array"; value: T[] }
  | { keyword: string; form: "map"; value: Record<string, T> };

/**
 * Rewrite the children of every schema-bearing keyword of `schema`, keyword by
 * keyword in `SCHEMA_KEYWORDS` order. The result is a new container per
 * keyword (a fresh array or map, entry order kept); `schema` is not modified.
 *
 * Lazy on purpose: a keyword's children are mapped only when iteration reaches
 * it, so a caller can act between keywords (JSF normalization invents
 * `patternProperties` keys before it descends into `items`).
 */
export function* mapSchemaChildren<T>(
  schema: JSONSchema7,
  fn: SchemaChildMapper<T>,
): Generator<MappedKeyword<T>> {
  for (const { descriptor, form, entries } of heldKeywords(schema)) {
    const { keyword } = descriptor;
    if (form === "single") {
      const [{ value, location }] = entries;
      const mapped = fn(value, { keyword, location });
      if (mapped !== undefined) yield { keyword, form, value: mapped };
    } else if (form === "array") {
      const mapped: T[] = [];
      for (const { value, location } of entries) {
        const result = fn(value, { keyword, location });
        if (result !== undefined) mapped.push(result);
      }
      yield { keyword, form, value: mapped };
    } else {
      const mapped: Record<string, T> = {};
      for (const { value, location } of entries) {
        const result = fn(value, { keyword, location });
        if (result === undefined || location.form !== "map") continue;
        // defineProperty, not assignment: a "__proto__" name stays data.
        Object.defineProperty(mapped, location.name, {
          value: result,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      yield { keyword, form, value: mapped };
    }
  }
}
