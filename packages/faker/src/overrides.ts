import type { JSONSchema7 } from "json-schema";
import { DEFAULT_ARRAY_COUNT } from "./constants.js";

/**
 * Determine number of items to generate for array schema
 * Prefers explicit count, then schema minItems/maxItems, with sane defaults
 * @param schema - Array schema with optional minItems/maxItems
 * @param explicitCount - Explicit count override from plugin options
 * @returns Number of array items to generate
 */
export function determineArrayCount(
  schema: JSONSchema7,
  explicitCount?: number,
): number {
  if (explicitCount !== undefined) {
    // Handle negative or invalid counts
    if (explicitCount < 0) {
      return 0;
    }
    return explicitCount;
  }

  if (schema.minItems !== undefined && schema.maxItems !== undefined) {
    return (
      Math.floor(Math.random() * (schema.maxItems - schema.minItems + 1)) +
      schema.minItems
    );
  }

  if (schema.minItems !== undefined) {
    return Math.max(schema.minItems, DEFAULT_ARRAY_COUNT);
  }

  if (schema.maxItems !== undefined) {
    return Math.min(schema.maxItems, DEFAULT_ARRAY_COUNT);
  }

  return DEFAULT_ARRAY_COUNT;
}

/**
 * Apply overrides to generated data with support for templates
 * Supports nested paths (dot notation), templates with {{params.id}}, and state access
 * @param data - Generated data to apply overrides to
 * @param overrides - Override values (can use templates)
 * @param params - Route parameters for template expansion
 * @param state - Plugin state for template expansion
 * @param query - Query parameters for template expansion
 * @returns Data with overrides applied
 */
export function applyOverrides(
  data: any,
  overrides?: Record<string, any>,
  params?: Record<string, string>,
  state?: any,
  query?: Record<string, string>,
): any {
  if (!overrides) return data;

  const result = structuredClone(data);

  for (const [key, value] of Object.entries(overrides)) {
    // Handle nested paths like "data.id" or "pagination.page"
    if (key.includes(".")) {
      setNestedProperty(result, key, value, { params, state, query });
    } else {
      // Handle flat keys and nested objects
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        // Recursively apply nested overrides
        if (result[key] && typeof result[key] === "object") {
          result[key] = applyOverrides(
            result[key],
            value,
            params,
            state,
            query,
          );
        } else {
          result[key] = applyOverrides({}, value, params, state, query);
        }
      } else if (typeof value === "string" && value.includes("{{")) {
        // Template processing
        result[key] = processTemplate(value, { params, state, query });
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

function setNestedProperty(
  obj: any,
  path: string,
  value: any,
  context: {
    params?: Record<string, string>;
    state?: any;
    query?: Record<string, string>;
  },
): void {
  const parts = path.split(".");
  let current = obj;

  // Navigate to the parent of the target property
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      !(part in current) ||
      typeof current[part] !== "object" ||
      current[part] === null
    ) {
      current[part] = {};
    }
    current = current[part];
  }

  // Set the final property
  const finalKey = parts[parts.length - 1];
  if (typeof value === "string" && value.includes("{{")) {
    current[finalKey] = processTemplate(value, context);
  } else {
    current[finalKey] = value;
  }
}

function processTemplate(
  template: string,
  context: {
    params?: Record<string, string>;
    state?: any;
    query?: Record<string, string>;
  },
): any {
  // Check if the template is just a single template expression
  const singleTemplateMatch = template.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if (singleTemplateMatch) {
    // For single templates, return the actual value without string conversion
    const expression = singleTemplateMatch[1];
    const parts = expression.trim().split(".");
    let result: any = context;

    for (const part of parts) {
      if (result && typeof result === "object") {
        result = result[part];
      } else {
        return template; // Return original if can't resolve
      }
    }

    return result !== undefined ? result : template;
  }

  // For templates mixed with other text, do string replacement
  const processed = template.replace(
    /\{\{\s*([^}]+)\s*\}\}/g,
    (match, expression) => {
      const parts = expression.trim().split(".");
      let result: any = context;

      for (const part of parts) {
        if (result && typeof result === "object") {
          result = result[part];
        } else {
          return match; // Return original if can't resolve
        }
      }

      return result !== undefined ? String(result) : match;
    },
  );

  return processed;
}
