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

/**
 * Compile a JSON Schema `pattern` the one way every faker step reads it: with
 * the `u` flag first, then without it for patterns only the legacy grammar
 * accepts (`^x\-[a-z]+$` has an identity escape that `u` forbids). Key
 * invention, key matching and pattern validation all go through here, so they
 * agree on which patterns exist. Undefined when neither form compiles.
 */
export function compilePattern(source: string): RegExp | undefined {
  for (const flags of ["u", ""]) {
    try {
      return new RegExp(source, flags);
    } catch {
      // Try the next flag set; a pattern neither accepts is skipped.
    }
  }
  return undefined;
}
