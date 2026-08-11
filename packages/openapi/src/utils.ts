import type { JSONSchema7 } from "json-schema";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type-aware check that tolerates the union form the normalizer emits for
 * nullable schemas (`type: ["array", "null"]`). A strict `schema.type === t`
 * silently misses those and mis-shapes list responses.
 */
export function hasType(schema: { type?: unknown }, type: string): boolean {
  return (
    schema.type === type ||
    (Array.isArray(schema.type) && schema.type.includes(type))
  );
}

/**
 * Reduce a media type to its comparable form: parameters dropped, lowercased.
 *
 * One implementation on purpose — the parser keys request/response content maps
 * with it and the request pipeline looks media types up with it, so a second
 * copy would be a silent mismatch waiting to happen.
 */
export function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function toJsonSchema(node: Record<string, unknown>): JSONSchema7 {
  return Object.assign<JSONSchema7, Record<string, unknown>>({}, node);
}
