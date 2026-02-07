import type { HttpMethod } from "./types.js";

export const ROUTE_NOT_FOUND_CODE = "ROUTE_NOT_FOUND" as const;

export const HTTP_METHODS: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
] as const;

export function isHttpMethod(method: string): method is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(method);
}

export function toHttpMethod(method: string): HttpMethod {
  const upper = method.toUpperCase();
  if (!isHttpMethod(upper)) {
    throw new Error(`Invalid HTTP method: "${method}"`);
  }
  return upper;
}

/**
 * Check if a value is a status tuple: [status, body] or [status, body, headers]
 * Guards against misinterpreting numeric arrays like [1, 2, 3] as tuples.
 */
export function isStatusTuple(
  value: unknown,
): value is [number, unknown] | [number, unknown, Record<string, string>] {
  return (
    Array.isArray(value) &&
    (value.length === 2 || value.length === 3) &&
    typeof value[0] === "number" &&
    value[0] >= 100 &&
    value[0] <= 599
  );
}
