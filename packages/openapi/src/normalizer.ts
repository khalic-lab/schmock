/// <reference path="../../../types/schmock.d.ts" />

import type { JSONSchema7 } from "json-schema";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonSchema(node: Record<string, unknown>): JSONSchema7 {
  // Object.assign merges unknown-keyed properties into JSONSchema7.
  // This is safe because the normalizer has already ensured the shape
  // is valid JSON Schema 7 before calling this function.
  return Object.assign<JSONSchema7, Record<string, unknown>>({}, node);
}

/**
 * Normalize an OpenAPI schema to pure JSON Schema 7 that json-schema-faker understands.
 *
 * Transforms applied:
 * - nullable: true -> oneOf with null type
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
  return normalizeNode(structuredClone(schema), direction, new WeakSet());
}

function normalizeNode(
  node: Record<string, unknown>,
  direction: "request" | "response",
  visited: WeakSet<object>,
): JSONSchema7 {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return toJsonSchema({});
  }

  // Circular reference detection — break cycles
  if (visited.has(node)) {
    return toJsonSchema({});
  }
  visited.add(node);

  // Strip x-* extensions
  for (const key of Object.keys(node)) {
    if (key.startsWith("x-")) {
      delete node[key];
    }
  }

  // Handle nullable: true -> oneOf with null
  if (node.nullable === true) {
    delete node.nullable;
    // Only wrap if not already a composition with null
    const copy = { ...node };
    delete copy.nullable;
    return {
      oneOf: [normalizeNode(copy, direction, visited), { type: "null" }],
    };
  }
  delete node.nullable;

  // Handle discriminator
  if (node.discriminator && isRecord(node.discriminator)) {
    const disc = node.discriminator;
    const propName = disc.propertyName;
    if (typeof propName === "string" && Array.isArray(node.oneOf)) {
      const mappingRaw = disc.mapping ?? {};
      const mapping = isRecord(mappingRaw) ? mappingRaw : {};
      // mapping keys ARE the discriminator values (e.g. "dog", "cat")
      // mapping values are $ref strings — after dereference they can't be matched to branches
      // Use key order to correspond to oneOf branch order
      const discriminatorValues = Object.keys(mapping);

      node.oneOf = node.oneOf
        .filter((branch): branch is Record<string, unknown> => isRecord(branch))
        .map((branch, index) => {
          const normalized = normalizeNode(branch, direction, visited);
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
            const mappingValue = discriminatorValues[index];
            if (mappingValue && isRecord(normalized.properties)) {
              const props = normalized.properties;
              const existingRaw = props[propName] ?? {};
              const existing = isRecord(existingRaw) ? existingRaw : {};
              props[propName] = { ...existing, enum: [mappingValue] };
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
      props[propName] = normalizeNode(propSchema, direction, visited);
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
        isRecord(item) ? normalizeNode(item, direction, visited) : item,
      );
    } else if (isRecord(node.items)) {
      node.items = normalizeNode(node.items, direction, visited);
    }
  }

  // Recurse into additionalProperties
  if (isRecord(node.additionalProperties)) {
    node.additionalProperties = normalizeNode(
      node.additionalProperties,
      direction,
      visited,
    );
  }

  // Recurse into composition keywords
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const keywordValue = node[keyword];
    if (Array.isArray(keywordValue)) {
      node[keyword] = keywordValue.map((branch: unknown) =>
        isRecord(branch) ? normalizeNode(branch, direction, visited) : branch,
      );
    }
  }

  // Recurse into not
  if (isRecord(node.not)) {
    node.not = normalizeNode(node.not, direction, visited);
  }

  // Recurse into conditional
  for (const keyword of ["if", "then", "else"]) {
    const keywordValue = node[keyword];
    if (isRecord(keywordValue)) {
      node[keyword] = normalizeNode(keywordValue, direction, visited);
    }
  }

  // Recurse into patternProperties
  if (isRecord(node.patternProperties)) {
    const pp = node.patternProperties;
    for (const [pattern, schema] of Object.entries(pp)) {
      if (isRecord(schema)) {
        pp[pattern] = normalizeNode(schema, direction, visited);
      }
    }
  }

  return toJsonSchema(node);
}
