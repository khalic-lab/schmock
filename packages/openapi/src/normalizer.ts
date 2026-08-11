import type { JSONSchema7 } from "json-schema";
import { isRecord, toJsonSchema } from "./utils.js";

/**
 * Where the parser records the explicit mapping key or implicit component name
 * for the branch at index i, before dereference erases its `$ref`. Written in
 * parser.ts; read here; dropped with the whole `discriminator` object below.
 */
const DISCRIMINATOR_VALUES_MARKER = "x-schmock-discriminator-values";

/**
 * Normalize an OpenAPI schema to pure JSON Schema 7 that json-schema-faker understands.
 *
 * Transforms applied:
 * - nullable: true -> validation-visible null (`type: [T, "null"]`, or
 *   `anyOf: [{type:"null"}, rest]` for composition-only schemas) plus the
 *   `schmockNullable` marker the faker plugin uses to roll nulls at ~5%
 * - discriminator -> required + enum on branches
 * - readOnly/writeOnly -> strip based on direction
 * - example -> default (if default not set)
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
 * schema that accepts `null` and keeps the marker so `postProcessGenerated`
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
  } else {
    // Typeless and composition-free — already accepts null.
    return { ...node, schmockNullable: true };
  }

  // A union type alone still rejects null when an enum constrains the values.
  if (Array.isArray(node.enum) && !node.enum.includes(null)) {
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
      // BEFORE dereference in parser.ts and handed over index-aligned here.
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

  // Handle example -> default
  if ("example" in node && !("default" in node)) {
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
  stack.delete(node);
  memo.set(node, out);
  return out;
}
