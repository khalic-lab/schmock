import { isRecord } from "./utils.js";

/**
 * Passes over a raw document's `$ref`s that run before EITHER resolver, so the
 * Node and browser builds see the same input and cannot diverge on it.
 */

/**
 * What a `$ref` key is renamed to while its object is literal data. It must not
 * contain the text `"$ref"`: `dereferenceDocument` in load-document.ts decides
 * whether a document needs dereferencing at all by searching its JSON for
 * exactly that.
 */
const HIDDEN_REF_KEY = "\u0000schmock:literal-ref";

/**
 * Keys whose value is a map from NAMES to objects, rather than an object of
 * keywords. Inside one, a key such as `default`, `example` or `x-rate-limit`
 * is a response code, a property or a header name, not a literal.
 */
const NAME_MAP_KEYS = new Set([
  "$defs",
  "content",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "encoding",
  "headers",
  "links",
  "mapping",
  "parameters",
  "pathItems",
  "paths",
  "patternProperties",
  "properties",
  "requestBodies",
  "responses",
  "schemas",
  "scopes",
  "securityDefinitions",
  "securitySchemes",
  "variables",
  "webhooks",
]);

/** Keyword positions whose whole value is data, never a reference. */
const LITERAL_KEYS = new Set(["default", "example"]);

/**
 * Replace every own key of `node`, in order, with `entries`.
 *
 * Defined rather than assigned: these objects are spec data, and assigning an
 * own `__proto__` key — which `JSON.parse` produces for `"__proto__": …` —
 * would set the object's prototype instead of restoring the key.
 */
function rebuild(
  node: Record<string, unknown>,
  entries: Array<[string, unknown]>,
): void {
  for (const key of Object.keys(node)) Reflect.deleteProperty(node, key);
  for (const [key, value] of entries) {
    Object.defineProperty(node, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function renameKey(
  node: Record<string, unknown>,
  from: string,
  to: string,
): void {
  // Rebuilt rather than renamed in place, so an example keeps its key order.
  rebuild(
    node,
    Object.entries(node).map(([key, value]) => [
      key === from ? to : key,
      value,
    ]),
  );
}

export interface LiteralRefs {
  /** Put back every `$ref` that was hidden. Idempotent. */
  restore(): void;
}

/**
 * Hide every `$ref` that sits inside literal data, so that no resolver follows
 * it and no policy check rules on it; {@link LiteralRefs.restore} puts them
 * back once dereferencing is done.
 *
 * Literal data is an `example` or `default` value, the payloads of `examples`
 * (a JSON Schema `examples` array, an Example Object's `value`, a Swagger 2
 * response's examples by media type) and any `x-*` vendor extension in a
 * keyword position. Before this, a spec whose example was a JSON Schema
 * document carrying `$ref: https://json-schema.org/…` was rejected as an
 * external reference, a Redocly `x-codeSamples` `$ref` to a source file was
 * too, and an internal-looking `$ref` inside an example was replaced by the
 * schema it named. Hiding rather than skipping keeps every resolver, the
 * policy pre-scan and the residual scan in agreement without each needing the
 * same exclusion rule.
 */
export function hideLiteralRefs(document: object): LiteralRefs {
  const swagger2 = "swagger" in document;
  const hidden: Array<Record<string, unknown>> = [];
  const visited = new WeakSet<object>();

  const hideAll = (value: unknown): void => {
    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const node = stack.pop();
      if (typeof node !== "object" || node === null || visited.has(node)) {
        continue;
      }
      visited.add(node);
      if (isRecord(node) && "$ref" in node && !(HIDDEN_REF_KEY in node)) {
        renameKey(node, "$ref", HIDDEN_REF_KEY);
        hidden.push(node);
      }
      for (const child of Object.values(node)) stack.push(child);
    }
  };

  type Visit = { subject: unknown; names: boolean; exampleObject: boolean };
  const stack: Visit[] = [
    { subject: document, names: false, exampleObject: false },
  ];
  while (stack.length > 0) {
    const visit = stack.pop();
    if (visit === undefined) break;
    const { subject: node, names, exampleObject } = visit;
    if (typeof node !== "object" || node === null || visited.has(node)) {
      continue;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        stack.push({ subject: item, names: false, exampleObject: false });
      }
      continue;
    }

    for (const [key, value] of Object.entries(node)) {
      if (names) {
        stack.push({ subject: value, names: false, exampleObject: false });
      } else if (
        key.startsWith("x-") ||
        LITERAL_KEYS.has(key) ||
        (exampleObject && key === "value")
      ) {
        hideAll(value);
      } else if (key === "examples") {
        if (Array.isArray(value) || swagger2) {
          hideAll(value);
        } else if (isRecord(value)) {
          // OAS 3: a map of Example Objects (payload under `value`) or of
          // Reference Objects to them, which must still resolve.
          visited.add(value);
          for (const entry of Object.values(value)) {
            stack.push({
              subject: entry,
              names: false,
              exampleObject: !(isRecord(entry) && "$ref" in entry),
            });
          }
        }
      } else if (key === "callbacks" && isRecord(value)) {
        // A map of callbacks, each itself a map of expressions to path items.
        visited.add(value);
        for (const callback of Object.values(value)) {
          stack.push({ subject: callback, names: true, exampleObject: false });
        }
      } else {
        stack.push({
          subject: value,
          names: NAME_MAP_KEYS.has(key) && isRecord(value),
          exampleObject: false,
        });
      }
    }
  }

  let restored = false;
  return {
    restore: () => {
      if (restored) return;
      restored = true;
      for (const node of hidden) renameKey(node, HIDDEN_REF_KEY, "$ref");
    },
  };
}

/**
 * JSON Schema keywords that constrain or apply subschemas. A `$ref` beside
 * one of these can only be a schema, and in OAS 3.1 (JSON Schema 2020-12) the
 * two must BOTH hold. Annotations — `description`, `title`, `example`,
 * `default`, `readOnly` and the like — are absent on purpose: beside a `$ref`
 * they override, which is also all an OAS 3.1 Reference Object allows.
 */
const APPLICATOR_OR_ASSERTION_KEYWORDS = new Set([
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "if",
  "items",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "required",
  "then",
  "type",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
]);

/**
 * Whether `key: value` beside a `$ref` marks the object as a schema. `required`
 * counts only as JSON Schema's array: the boolean `required` of a Parameter,
 * Header or Request Body reference is an override of that object, not a
 * schema constraint.
 */
function isSchemaConstraint(key: string, value: unknown): boolean {
  if (!APPLICATOR_OR_ASSERTION_KEYWORDS.has(key)) return false;
  return key !== "required" || Array.isArray(value);
}

/** OpenAPI 3.1 and later: JSON Schema 2020-12, where `$ref` siblings apply. */
function refSiblingsApply(document: object): boolean {
  const version: unknown = Reflect.get(document, "openapi");
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 3 || (major === 3 && Number(match[2]) >= 1);
}

/**
 * Rewrite `{ $ref, ...siblings }` as `{ allOf: [{ $ref }], ...siblings }` in an
 * OAS 3.1+ document, wherever a sibling is an applicator or assertion.
 *
 * Both resolvers merge a `$ref`'s siblings over its target, siblings winning —
 * ref-parser's extended-ref rule. Under 2020-12 the two are a conjunction, so
 * `{ $ref: Base, properties: { extra }, required: [extra] }` lost Base's own
 * `properties` and `required`: generated bodies dropped fields and request
 * validation stopped requiring them. `allOf` is the same conjunction spelled
 * so that every consumer here — AJV, the faker generator, the normalizer —
 * already handles it.
 *
 * Must run after `markDiscriminatorValues`, which pairs `oneOf` branches with
 * their mapping by the `$ref` string still sitting on the branch.
 */
export function combineRefSiblings(document: object): void {
  if (!refSiblingsApply(document)) return;

  const seen = new WeakSet<object>();
  const stack: unknown[] = [document];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);

    if (
      isRecord(node) &&
      typeof node.$ref === "string" &&
      Object.entries(node).some(([key, value]) =>
        isSchemaConstraint(key, value),
      )
    ) {
      const existing = Array.isArray(node.allOf) ? node.allOf : [];
      const entries: Array<[string, unknown]> = [];
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref")
          entries.push(["allOf", [{ $ref: value }, ...existing]]);
        else if (key !== "allOf") entries.push([key, value]);
      }
      rebuild(node, entries);
    }

    for (const child of Object.values(node)) stack.push(child);
  }
}
