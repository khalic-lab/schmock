import type { CodeOptions, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

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

/** The request pipeline's `multipleOf` tolerance (request-pipeline.ts). */
const MULTIPLE_OF_PRECISION = 6;

/**
 * The request pipeline's pattern engine (request-pipeline.ts): the `u` flag
 * first, then without it for patterns only the legacy grammar accepts.
 */
const specPatternEngine: NonNullable<CodeOptions["regExp"]> = Object.assign(
  (pattern: string, flags: string): RegExp => {
    try {
      return new RegExp(pattern, flags);
    } catch (error) {
      if (!flags.includes("u")) throw error;
      return new RegExp(pattern, flags.replace("u", ""));
    }
  },
  // Read only when AJV emits standalone source, which this package never does.
  { code: "specPatternEngine" },
);

let acceptanceAjv: Ajv2020 | undefined;

/**
 * Compiled value checks by the JSON text of the keywords they check. A node
 * whose keywords do not compile maps to `undefined`.
 */
const valueChecks = new Map<string, ValidateFunction | undefined>();

/** The request pipeline's AJV setup, formats included, created on first use. */
function getAcceptanceAjv(): Ajv2020 {
  if (!acceptanceAjv) {
    acceptanceAjv = new Ajv2020({
      strictSchema: false,
      strictTypes: false,
      multipleOfPrecision: MULTIPLE_OF_PRECISION,
      code: { regExp: specPatternEngine },
      // An unknown format (Train Travel's `iso-country-code`) is ignored, as
      // the request pipeline ignores it, without a console line per compile.
      logger: false,
    });
    addFormats(acceptanceAjv);
  }
  return acceptanceAjv;
}

function valueCheck(
  node: Record<string, unknown>,
): ValidateFunction | undefined {
  const keywords: Record<string, unknown> = {};
  for (const keyword of VALUE_KEYWORDS) {
    if (node[keyword] !== undefined) keywords[keyword] = node[keyword];
  }
  const key = JSON.stringify(keywords);
  if (valueChecks.has(key)) return valueChecks.get(key);

  let check: ValidateFunction | undefined;
  try {
    check = getAcceptanceAjv().compile(keywords);
  } catch {
    check = undefined;
  }
  valueChecks.set(key, check);
  return check;
}

/**
 * Does `node` accept `value` by its type, format, pattern, enum, const, length
 * and numeric bounds? A node whose keywords do not compile cannot tell, so it
 * rejects nothing, as before the check existed.
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
 * Does `node` constrain its value through `allOf`, `anyOf`, `oneOf`, `not` or
 * `if`/`then`/`else`? The value check sees only the node's own keywords, so it
 * would accept an example a branch rejects (a uuid `format` in an `allOf`
 * entry, an `anyOf` with no `type` beside it). Such a node generates from its
 * composition, as @schmock/faker generates it, and a `faker` draw beside `not`
 * is rejected outright, because json-schema-faker never checks it.
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
 * back as 19.98. A `faker` keyword the spec declares itself is kept.
 */
function canDrawFromPool(node: Record<string, unknown>): boolean {
  if (node.faker !== undefined) return false;
  const types = Array.isArray(node.type)
    ? node.type.filter((type) => type !== "null")
    : [];
  if (types.length > 1) return false;
  const step = node.multipleOf;
  return !(typeof step === "number" && !Number.isInteger(step));
}

/**
 * Let a scalar node's own examples drive what is generated for it, writing to
 * `node` in place:
 *
 * - a `default` pins the value, and nothing changes;
 * - a node that composes (see {@link isComposedNode}) generates from its
 *   composition, and neither keyword is used;
 * - a primitive 3.0 `example` the node accepts becomes its `default`;
 * - with no `example`, the distinct primitive 3.1 `examples` entries the node
 *   accepts form a pool. One entry becomes the `default`, exactly as an
 *   `example` would. With several, each generated value is drawn from them
 *   through the generator's seeded faker instance (`fakerSeed` reproduces the
 *   draws), unless json-schema-faker would alter a drawn value (see
 *   {@link canDrawFromPool}).
 *
 * `nullable` is the node's 3.0 `nullable: true`, already removed from `node`:
 * it makes a `null` example acceptable whatever the type says.
 */
export function applyExampleValues(
  node: Record<string, unknown>,
  nullable: boolean,
): void {
  if ("default" in node || isCompositeNode(node) || isComposedNode(node)) {
    return;
  }

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
