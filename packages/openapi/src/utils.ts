import type { JSONSchema7 } from "json-schema";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toJsonSchema(node: Record<string, unknown>): JSONSchema7 {
  return Object.assign<JSONSchema7, Record<string, unknown>>({}, node);
}
