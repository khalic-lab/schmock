import type { JSONSchema7 } from "json-schema";
import { isRecord, toJsonSchema } from "./utils.js";

/**
 * Where the parser records the explicit mapping key or implicit component name
 * for the branch at index i, before dereference erases its `$ref`. Written in
 * load-document.ts (`markDiscriminatorValues` /
 * `markDereferencedDiscriminatorValues`); read here; dropped with the whole
 * `discriminator` object below.
 */
const DISCRIMINATOR_VALUES_MARKER = "x-schmock-discriminator-values";

/**
 * Property names a schema node marked `readOnly` / `writeOnly` before
 * normalization erased the flags (and, depending on direction, the properties).
 */
export interface AccessModes {
  readonly readOnly: ReadonlySet<string>;
  readonly writeOnly: ReadonlySet<string>;
}

/**
 * Side table from a normalized node to the access modes its `properties`
 * declared.
 *
 * Deliberately not an in-schema keyword: normalized schemas reach Ajv in
 * `@schmock/validation`, whose fixed vocabulary would reject an unknown key.
 * Keyed on the exact object `normalizeNode` returns, so the lookup follows the
 * schema through `$ref` sharing and the parser's per-direction cache, and simply
 * misses on a copy (an `onSchema` result, an `options.schemas` override).
 */
const accessModesByNode = new WeakMap<object, AccessModes>();

const NO_ACCESS_MODES: AccessModes = {
  readOnly: new Set(),
  writeOnly: new Set(),
};

/**
 * Union the access modes recorded on a normalized schema and its `allOf`
 * branches — the same flattening `collectSchemaProperties` applies.
 *
 * The request direction strips `readOnly` properties and the response direction
 * strips `writeOnly` ones, so this is the only place either name survives.
 */
export function collectAccessModes(
  schema: JSONSchema7 | undefined,
): AccessModes {
  const readOnly = new Set<string>();
  const writeOnly = new Set<string>();
  const seen = new Set<object>();

  const visit = (node: unknown): void => {
    if (!isRecord(node) || seen.has(node)) return;
    seen.add(node);
    const recorded = accessModesByNode.get(node);
    if (recorded) {
      for (const name of recorded.readOnly) readOnly.add(name);
      for (const name of recorded.writeOnly) writeOnly.add(name);
    }
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) visit(branch);
    }
    // A composition-only nullable wraps its node as `anyOf: [{type:"null"}, node]`.
    if (node.schmockNullable === true && Array.isArray(node.anyOf)) {
      for (const branch of node.anyOf) visit(branch);
    }
  };

  visit(schema);
  if (readOnly.size === 0 && writeOnly.size === 0) return NO_ACCESS_MODES;
  return { readOnly, writeOnly };
}

/**
 * Is `node` shaped as an object or array, by its declared type or structure?
 *
 * Only a node that is neither gets its `example` promoted to `default`:
 * json-schema-faker returns an object/array default verbatim, so a partial
 * object example dropped required properties, cloned every seed row and leaked
 * `writeOnly` fields the direction had just stripped from `properties`.
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

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

/**
 * Normalize an OpenAPI schema to pure JSON Schema 7 that json-schema-faker understands.
 *
 * Transforms applied:
 * - nullable: true -> validation-visible null (`type: [T, "null"]`, or
 *   `anyOf: [{type:"null"}, rest]` for composition-only schemas) plus the
 *   `schmockNullable` marker the faker plugin uses to roll nulls at ~5%
 * - discriminator -> required + enum on branches
 * - readOnly/writeOnly -> strip based on direction (names recorded, see
 *   {@link collectAccessModes})
 * - example -> default (if default not set), on scalar nodes only
 * - exclusiveMinimum/exclusiveMaximum boolean -> number format
 * - x-* extensions -> stripped
 */
export function normalizeSchema(
  schema: Record<string, unknown>,
  direction: "request" | "response",
): JSONSchema7 {
  return normalizeNode(
    structuredClone(schema),
    direction,
    new Set<object>(),
    new Map<object, JSONSchema7>(),
  );
}

/**
 * Apply nullability to an already-normalized node in a form AJV can see.
 *
 * The `schmockNullable` marker alone leaves the non-null `type` in place, so a
 * generated `null` fails the plugin's own validator. Every branch below emits a
 * schema that accepts `null` and keeps the marker so `applyNullableRolls`
 * still rolls nulls at ~5%.
 */
function applyNullability(
  node: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof node.type === "string") {
    node.type = [node.type, "null"];
  } else if (Array.isArray(node.type)) {
    if (!node.type.includes("null")) {
      node.type = [...node.type, "null"];
    }
  } else if (node.allOf || node.anyOf || node.oneOf || node.$ref) {
    // Composition-only nullable (the standard `allOf: [{$ref}], nullable: true`
    // idiom): the whole node moves into the non-null branch.
    return { anyOf: [{ type: "null" }, node], schmockNullable: true };
  }
  // A typeless, composition-free node accepts null by type — but an `enum` or
  // `const` still constrains the value regardless of `type`, so it falls
  // through to the same value fix-up as the typed branches.

  // A union type alone still rejects null when an enum or const constrains the
  // values.
  if ("const" in node) {
    const value = node.const;
    delete node.const;
    node.enum = value === null ? [null] : [value, null];
  } else if (Array.isArray(node.enum) && !node.enum.includes(null)) {
    node.enum = [...node.enum, null];
  }

  node.schmockNullable = true;
  return node;
}

function normalizeNode(
  node: Record<string, unknown>,
  direction: "request" | "response",
  stack: Set<object>,
  memo: Map<object, JSONSchema7>,
): JSONSchema7 {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return toJsonSchema({});
  }

  // Already normalized in this pass — `$ref` dereference makes two occurrences
  // of one component the SAME object, and they must both normalize fully.
  const cached = memo.get(node);
  if (cached) {
    return cached;
  }

  // Circular reference detection — break true cycles (node is on the stack)
  if (stack.has(node)) {
    return toJsonSchema({});
  }
  stack.add(node);

  const isNullable = node.nullable === true;
  delete node.nullable;
  const readOnlyNames: string[] = [];
  const writeOnlyNames: string[] = [];

  // Strip x-* extensions
  for (const key of Object.keys(node)) {
    if (key.startsWith("x-")) {
      delete node[key];
    }
  }

  // Handle discriminator
  if (node.discriminator && isRecord(node.discriminator)) {
    const disc = node.discriminator;
    const propName = disc.propertyName;
    if (typeof propName === "string" && Array.isArray(node.oneOf)) {
      // Explicit mapping keys or implicit `$ref` component names are resolved
      // BEFORE dereference in load-document.ts (`markDiscriminatorValues` /
      // `markDereferencedDiscriminatorValues`) and handed over index-aligned
      // here.
      const resolvedRaw = disc[DISCRIMINATOR_VALUES_MARKER];
      const resolved = Array.isArray(resolvedRaw) ? resolvedRaw : undefined;

      node.oneOf = node.oneOf.map((branch, index) => {
        if (!isRecord(branch)) return branch;
        const normalized = normalizeNode(branch, direction, stack, memo);
        // Ensure discriminator property is required
        if (isRecord(normalized)) {
          const required = Array.isArray(normalized.required)
            ? [...normalized.required]
            : [];
          if (!required.includes(propName)) {
            required.push(propName);
          }
          normalized.required = required;

          // Add enum constraint for the discriminator value
          const marked = resolved?.[index];
          const mappingValues = Array.isArray(marked)
            ? marked.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          if (mappingValues.length > 0) {
            const props = isRecord(normalized.properties)
              ? normalized.properties
              : {};
            const existingRaw = props[propName] ?? {};
            const existing = isRecord(existingRaw) ? existingRaw : {};
            props[propName] = { ...existing, enum: mappingValues };
            normalized.properties = props;
          }
        }
        return normalized;
      });
    }
    delete node.discriminator;
  }

  // Handle readOnly/writeOnly on properties
  if (isRecord(node.properties)) {
    const props = node.properties;
    const required = Array.isArray(node.required)
      ? node.required.filter((r): r is string => typeof r === "string")
      : [];
    const keysToRemove: string[] = [];

    for (const [propName, propSchemaRaw] of Object.entries(props)) {
      if (!isRecord(propSchemaRaw)) continue;
      const propSchema = propSchemaRaw;

      // Recorded in both directions: the flags are erased below either way.
      if (propSchema.readOnly === true) readOnlyNames.push(propName);
      if (propSchema.writeOnly === true) writeOnlyNames.push(propName);

      // readOnly fields: remove from request schemas
      if (direction === "request" && propSchema.readOnly === true) {
        keysToRemove.push(propName);
        continue;
      }
      // writeOnly fields: remove from response schemas
      if (direction === "response" && propSchema.writeOnly === true) {
        keysToRemove.push(propName);
        continue;
      }

      // Clean up the flags after handling
      delete propSchema.readOnly;
      delete propSchema.writeOnly;

      // Recurse into property
      props[propName] = normalizeNode(propSchema, direction, stack, memo);
    }

    for (const key of keysToRemove) {
      delete props[key];
      const reqIdx = required.indexOf(key);
      if (reqIdx !== -1) {
        required.splice(reqIdx, 1);
      }
    }

    if (required.length > 0) {
      node.required = required;
    } else if (keysToRemove.length > 0 && Array.isArray(node.required)) {
      // If we removed all required fields, clean up
      if (required.length === 0) {
        delete node.required;
      }
    }
  }

  // Handle example -> default, for scalar values on scalar nodes only. An object
  // or array default is returned verbatim by json-schema-faker, so promoting a
  // composite example replaced every generated body with it.
  if (
    "example" in node &&
    !("default" in node) &&
    isPrimitive(node.example) &&
    !isCompositeNode(node)
  ) {
    node.default = node.example;
  }
  delete node.example;

  // Handle exclusiveMinimum/exclusiveMaximum boolean -> number
  if (node.exclusiveMinimum === true && typeof node.minimum === "number") {
    node.exclusiveMinimum = node.minimum;
    delete node.minimum;
  } else if (node.exclusiveMinimum === false) {
    delete node.exclusiveMinimum;
  }

  if (node.exclusiveMaximum === true && typeof node.maximum === "number") {
    node.exclusiveMaximum = node.maximum;
    delete node.maximum;
  } else if (node.exclusiveMaximum === false) {
    delete node.exclusiveMaximum;
  }

  // Recurse into items (array schema)
  if (node.items) {
    if (Array.isArray(node.items)) {
      node.items = node.items.map((item: unknown) =>
        isRecord(item) ? normalizeNode(item, direction, stack, memo) : item,
      );
    } else if (isRecord(node.items)) {
      node.items = normalizeNode(node.items, direction, stack, memo);
    }
  }

  // Recurse into additionalProperties
  if (isRecord(node.additionalProperties)) {
    node.additionalProperties = normalizeNode(
      node.additionalProperties,
      direction,
      stack,
      memo,
    );
  }

  // Recurse into composition keywords
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const keywordValue = node[keyword];
    if (Array.isArray(keywordValue)) {
      node[keyword] = keywordValue.map((branch: unknown) =>
        isRecord(branch)
          ? normalizeNode(branch, direction, stack, memo)
          : branch,
      );
    }
  }

  // Recurse into not
  if (isRecord(node.not)) {
    node.not = normalizeNode(node.not, direction, stack, memo);
  }

  // Recurse into conditional
  for (const keyword of ["if", "then", "else"]) {
    const keywordValue = node[keyword];
    if (isRecord(keywordValue)) {
      node[keyword] = normalizeNode(keywordValue, direction, stack, memo);
    }
  }

  // Recurse into patternProperties
  if (isRecord(node.patternProperties)) {
    const pp = node.patternProperties;
    for (const [pattern, schema] of Object.entries(pp)) {
      if (isRecord(schema)) {
        pp[pattern] = normalizeNode(schema, direction, stack, memo);
      }
    }
  }

  const out = toJsonSchema(isNullable ? applyNullability(node) : node);
  if (readOnlyNames.length > 0 || writeOnlyNames.length > 0) {
    accessModesByNode.set(out, {
      readOnly: new Set(readOnlyNames),
      writeOnly: new Set(writeOnlyNames),
    });
  }
  stack.delete(node);
  memo.set(node, out);
  return out;
}
