import type { JSONSchema7 } from "json-schema";

/** A plain key/value object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A schema object, as opposed to a boolean schema or a malformed entry. The
 * test is structural only; `validateSchema` checks what the object holds.
 */
export function isJSONSchema7(value: unknown): value is JSONSchema7 {
  return isRecord(value);
}
