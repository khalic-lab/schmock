import type { ValidateFunction } from "ajv";
import type Ajv2020 from "ajv/dist/2020.js";
import { createSpecAjv } from "./ajv-setup.js";

/*
 * Which of a schema node's own examples drive generation. An example counts
 * only when the node accepts it, so a malformed sample (the Train Travel
 * spec's trip uuid has seven hex digits in its first group) is never
 * generated. What this writes is for generation only: `default` is an
 * annotation to every validator, and so is the `faker` keyword, which the
 * request pipeline's AJV ignores and @schmock/validation registers as
 * vocabulary.
 */

/** The keywords that constrain a scalar value on their own. */
const VALUE_KEYWORDS = [
  "type",
  "format",
  "pattern",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const;

/** The faker method a generated value is drawn from a pool with. */
const POOL_METHOD = "helpers.arrayElement";

/**
 * How many compiled checks are kept. Each distinct set of value keywords is
 * compiled once, and AJV also keeps every schema it compiled, so a process
 * that loads spec after spec (the CLI reloading under `--watch`) would keep
 * them all. Past the cap both are dropped and a fresh instance starts over;
 * compiling a check again costs about 0.1 ms.
 */
const MAX_CACHED_CHECKS = 1024;

/**
 * The spec AJV setup (ajv-setup.ts) and its compiled checks, by the JSON text
 * of the keywords they check. A node whose keywords do not compile maps to
 * `undefined`.
 */
interface AcceptanceCache {
  ajv: Ajv2020;
  checks: Map<string, ValidateFunction | undefined>;
}

let acceptance: AcceptanceCache | undefined;

/** The current cache, created on first use and again past the cap. */
function acceptanceCache(): AcceptanceCache {
  if (!acceptance || acceptance.checks.size >= MAX_CACHED_CHECKS) {
    acceptance = { ajv: createSpecAjv(), checks: new Map() };
  }
  return acceptance;
}

/** The keywords that constrain a node through other schemas. */
const COMPOSITION_KEYWORDS = [
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
] as const;

/**
 * The check of what `node` accepts, compiled from its value keywords and its
 * composition keywords, whose branches the normalizer has already
 * normalized: a uuid `format` in an `allOf` entry rejects a malformed example
 * as surely as one beside `type`. `undefined` when the keywords do not
 * compile, or a cyclic branch cannot be keyed.
 */
function valueCheck(
  node: Record<string, unknown>,
): ValidateFunction | undefined {
  const keywords: Record<string, unknown> = {};
  for (const keyword of [...VALUE_KEYWORDS, ...COMPOSITION_KEYWORDS]) {
    if (node[keyword] !== undefined) keywords[keyword] = node[keyword];
  }
  let key: string;
  try {
    key = JSON.stringify(keywords);
  } catch {
    return undefined;
  }
  const { ajv, checks } = acceptanceCache();
  if (checks.has(key)) return checks.get(key);

  let check: ValidateFunction | undefined;
  try {
    check = ajv.compile(keywords);
  } catch {
    check = undefined;
  }
  checks.set(key, check);
  return check;
}

/**
 * Does `node` accept `value`, by its type, format, pattern, enum, const,
 * length and numeric bounds and by every branch it composes with? A node
 * whose keywords do not compile cannot tell, so it rejects nothing, as before
 * the check existed.
 */
function acceptsValue(node: Record<string, unknown>, value: unknown): boolean {
  const check = valueCheck(node);
  return check === undefined || check(value) === true;
}

/**
 * Is `node` shaped as an object or array, by its declared type or structure?
 *
 * Only a node that is neither takes a value from its examples: json-schema-
 * faker returns an object/array default verbatim, so a partial object example
 * dropped required properties, cloned every seed row and leaked `writeOnly`
 * fields the direction had just stripped from `properties`.
 */
function isCompositeNode(node: Record<string, unknown>): boolean {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes("object") || types.includes("array")) return true;
  return (
    node.type === undefined &&
    (node.properties !== undefined ||
      node.items !== undefined ||
      node.allOf !== undefined ||
      node.additionalProperties !== undefined)
  );
}

/**
 * Does `node` constrain its value through `allOf`, `anyOf`, `oneOf`, `not` or
 * `if`/`then`/`else`? Such a node never draws from several examples:
 * json-schema-faker evaluates a `faker` keyword before the composition, so a
 * draw would skip what the branches add, and @schmock/faker rejects a `faker`
 * draw beside `not` outright, because json-schema-faker never checks it.
 */
function isComposedNode(node: Record<string, unknown>): boolean {
  return COMPOSITION_KEYWORDS.some((keyword) => node[keyword] !== undefined);
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

/**
 * The distinct primitive `examples` entries `node` accepts, in spec order.
 * `null` is left out: a nullable node already generates it about 5% of the
 * time, and json-schema-faker would turn a drawn `null` into the text "null"
 * on the non-null type it generates.
 */
function examplePool(node: Record<string, unknown>): unknown[] {
  if (!Array.isArray(node.examples)) return [];
  const pool = new Set<unknown>();
  for (const entry of node.examples) {
    if (entry === null || !isPrimitive(entry)) continue;
    if (acceptsValue(node, entry)) pool.add(entry);
  }
  return [...pool];
}

/**
 * Does json-schema-faker return an entry drawn by `faker` unchanged? It casts
 * the drawn value to the node's type, and to a type picked at random from a
 * union, so a string entry drawn as `integer` comes back NaN. It also snaps a
 * number onto a fractional `multipleOf`: 19.99 drawn on a 0.01 step comes
 * back as 19.98. A `faker` keyword the spec declares itself is kept, and a
 * node that composes never draws (see {@link isComposedNode}).
 */
function canDrawFromPool(node: Record<string, unknown>): boolean {
  if (node.faker !== undefined || isComposedNode(node)) return false;
  const types = Array.isArray(node.type)
    ? node.type.filter((type) => type !== "null")
    : [];
  if (types.length > 1) return false;
  const step = node.multipleOf;
  return !(typeof step === "number" && !Number.isInteger(step));
}

/**
 * Let a scalar node's own examples drive what is generated for it, writing to
 * `node` in place. The normalizer calls it once the node's composition
 * branches are normalized, so the check covers the whole node:
 *
 * - a `default` pins the value, and nothing changes;
 * - a primitive 3.0 `example` the node accepts becomes its `default`;
 * - with no `example`, the distinct primitive 3.1 `examples` entries the node
 *   accepts form a pool. One entry becomes the `default`, exactly as an
 *   `example` would. With several, each generated value is drawn from them
 *   through the generator's seeded faker instance (`fakerSeed` reproduces the
 *   draws), unless json-schema-faker would alter a drawn value or skip the
 *   node's composition (see {@link canDrawFromPool}).
 *
 * `nullable` is the node's 3.0 `nullable: true`, already removed from `node`:
 * it makes a `null` example acceptable whatever the type says.
 */
export function applyExampleValues(
  node: Record<string, unknown>,
  nullable: boolean,
): void {
  if ("default" in node || isCompositeNode(node)) return;

  if ("example" in node) {
    const { example } = node;
    if (
      isPrimitive(example) &&
      ((example === null && nullable) || acceptsValue(node, example))
    ) {
      node.default = example;
    }
    return;
  }

  const pool = examplePool(node);
  if (pool.length === 1) {
    node.default = pool[0];
  } else if (pool.length > 1 && canDrawFromPool(node)) {
    node.faker = { [POOL_METHOD]: [pool] };
  }
}
