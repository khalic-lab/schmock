import type { JSONSchema7 } from "json-schema";
import { DEFAULT_ARRAY_COUNT } from "./constants.js";
import { cloneOwned } from "./jsf-config.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Determine number of items to generate for array schema
 * Prefers explicit count, then schema minItems/maxItems, with sane defaults
 * @param schema - Array schema with optional minItems/maxItems
 * @param explicitCount - Explicit count override from plugin options; negative
 *   counts yield 0, fractional counts round down, and NaN is treated as absent
 * @returns Number of array items to generate
 */
export function determineArrayCount(
  schema: JSONSchema7,
  explicitCount?: number,
  random: () => number = Math.random,
): number {
  // A NaN count carries no intent, so the schema decides instead. Fractions
  // round down; +Infinity is kept so the caller still hits the array-size limit.
  if (explicitCount !== undefined && !Number.isNaN(explicitCount)) {
    if (explicitCount < 0) {
      return 0;
    }
    return Math.floor(explicitCount);
  }

  if (schema.minItems !== undefined && schema.maxItems !== undefined) {
    const min = schema.minItems;
    const max = Math.max(min, schema.maxItems);
    return Math.floor(random() * (max - min + 1)) + min;
  }

  if (schema.minItems !== undefined) {
    return Math.max(schema.minItems, DEFAULT_ARRAY_COUNT);
  }

  if (schema.maxItems !== undefined) {
    return Math.min(schema.maxItems, DEFAULT_ARRAY_COUNT);
  }

  if (Array.isArray(schema.items)) {
    return schema.items.length;
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
  data: unknown,
  overrides?: Record<string, unknown>,
  params?: Record<string, string>,
  state?: Record<string, unknown>,
  query?: Record<string, string>,
): unknown {
  if (!overrides) return data;
  if (!isRecord(data)) return data;

  const result = structuredClone(data);

  applyOverridesInto(result, overrides, { params, state, query });
  return result;
}

function applyOverridesInto(
  container: Container,
  overrides: Record<string, unknown>,
  context: TemplateContext,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    // Handle nested paths like "data.id" or "pagination.page"
    if (key.includes(".")) {
      setNestedProperty(container, key, value, context);
    } else {
      applyOverrideEntry(container, key, value, context);
    }
  }
}

/** A generated container an override path can step into. */
type Container = Record<string, unknown> | unknown[];

/** A canonical, in-bounds array index: "0", "12" — never "01", "-1" or "1.5". */
function arrayIndex(items: unknown[], segment: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
  const index = Number(segment);
  return index < items.length ? index : undefined;
}

/**
 * Resolve the slot `segment` names in `container`, or undefined when the
 * override cannot address it: an array only takes an existing index, so an
 * override never grows, holes or re-types a generated array.
 */
function slotOf(
  container: Container,
  segment: string,
): { read: () => unknown; write: (value: unknown) => void } | undefined {
  if (DANGEROUS_KEYS.has(segment)) return undefined;
  if (Array.isArray(container)) {
    const index = arrayIndex(container, segment);
    if (index === undefined) return undefined;
    return {
      read: () => container[index],
      write: (value) => {
        container[index] = value;
      },
    };
  }
  return {
    read: () => container[segment],
    write: (value) => {
      container[segment] = value;
    },
  };
}

function resolveLeaf(value: unknown, context: TemplateContext): unknown {
  if (typeof value === "string" && value.includes("{{")) {
    return processTemplate(value, context);
  }
  return cloneOwned(value);
}

/**
 * Apply one flat-key override. An object value is merged into the generated
 * value it names: a generated object key by key, a generated array index by
 * index. A missing (or null) value becomes a new object; a generated primitive
 * is left alone rather than replaced by an object.
 */
function applyOverrideEntry(
  container: Container,
  key: string,
  value: unknown,
  context: TemplateContext,
): void {
  const slot = slotOf(container, key);
  if (!slot) return;
  if (!isRecord(value)) {
    slot.write(resolveLeaf(value, context));
    return;
  }
  const existing = slot.read();
  if (isRecord(existing) || Array.isArray(existing)) {
    applyOverridesInto(existing, value, context);
  } else if (existing === undefined || existing === null) {
    const created: Record<string, unknown> = {};
    applyOverridesInto(created, value, context);
    slot.write(created);
  }
}

function setNestedProperty(
  container: Container,
  path: string,
  value: unknown,
  context: TemplateContext,
): void {
  const parts = path.split(".");
  let current: Container = container;

  // Navigate to the parent of the target property. Arrays are entered by
  // index; a missing step becomes an object; a primitive (or an index the
  // array does not have) stops the override instead of re-typing the value.
  for (let i = 0; i < parts.length - 1; i++) {
    const slot = slotOf(current, parts[i]);
    if (!slot) return;
    const next = slot.read();
    if (isRecord(next) || Array.isArray(next)) {
      current = next;
    } else if (next === undefined || next === null) {
      const nested: Record<string, unknown> = {};
      slot.write(nested);
      current = nested;
    } else {
      return;
    }
  }

  // Set the final property
  const slot = slotOf(current, parts[parts.length - 1]);
  if (slot) slot.write(resolveLeaf(value, context));
}

interface TemplateContext {
  params?: Record<string, string>;
  state?: Record<string, unknown>;
  query?: Record<string, string>;
}

function resolveTemplatePath(
  context: TemplateContext,
  expression: string,
): unknown {
  const parts = expression.trim().split(".");
  let result: unknown = context;

  for (const part of parts) {
    if (isRecord(result)) {
      result = result[part];
    } else {
      return undefined;
    }
  }

  return result;
}

function processTemplate(template: string, context: TemplateContext): unknown {
  // Check if the template is just a single template expression
  const singleTemplateMatch = template.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if (singleTemplateMatch) {
    // For single templates, return the actual value without string conversion
    const result = resolveTemplatePath(context, singleTemplateMatch[1]);
    return result !== undefined ? cloneOwned(result) : template;
  }

  // For templates mixed with other text, do string replacement
  return template.replace(
    /\{\{\s*([^}]+)\s*\}\}/g,
    (match, expression: string) => {
      const result = resolveTemplatePath(context, expression);
      return result !== undefined ? String(result) : match;
    },
  );
}
