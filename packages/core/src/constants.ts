import type { HttpMethod } from "./types.js";

export const ROUTE_NOT_FOUND_CODE = "ROUTE_NOT_FOUND" as const;

interface ResponseLike {
  status: number;
  body: unknown;
}

type ResponseOrigin =
  | { kind: "route-not-found" }
  | { kind: "exception"; error: Error };

const RESPONSE_ORIGIN = Symbol.for("@schmock/core.response-origin");

function setResponseOrigin(response: object, origin: ResponseOrigin): void {
  Object.defineProperty(response, RESPONSE_ORIGIN, {
    configurable: true,
    value: origin,
  });
}

function getResponseOrigin(response: object): ResponseOrigin | undefined {
  const origin: unknown = Reflect.get(response, RESPONSE_ORIGIN);
  if (typeof origin !== "object" || origin === null || !("kind" in origin)) {
    return undefined;
  }
  if (origin.kind === "route-not-found") return { kind: "route-not-found" };
  if (
    origin.kind === "exception" &&
    "error" in origin &&
    origin.error instanceof Error
  ) {
    return { kind: "exception", error: origin.error };
  }
  return undefined;
}

export function markRouteNotFound<T extends ResponseLike>(response: T): T {
  setResponseOrigin(response, { kind: "route-not-found" });
  return response;
}

export function markResponseException<T extends ResponseLike>(
  response: T,
  error: Error,
): T {
  setResponseOrigin(response, { kind: "exception", error });
  return response;
}

export function getResponseException(
  response: ResponseLike,
): Error | undefined {
  const origin = getResponseOrigin(response);
  return origin?.kind === "exception" ? origin.error : undefined;
}

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

export function normalizePath(path: string): string {
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}

export function toRouteKey(method: HttpMethod, path: string): Schmock.RouteKey {
  const key: `${HttpMethod} ${string}` = `${method} ${path}`;
  return key;
}

/**
 * Check if a Schmock response is a route-not-found response.
 * Used by adapters to decide whether to pass through to the real backend.
 */
export function isRouteNotFound(response: {
  status: number;
  body: unknown;
}): boolean {
  if (getResponseOrigin(response)?.kind === "route-not-found") return true;

  const { status, body } = response;
  return (
    status === 404 &&
    body !== null &&
    typeof body === "object" &&
    "code" in body &&
    body.code === ROUTE_NOT_FOUND_CODE
  );
}

/**
 * Check if a value is a status tuple: [status, body] or [status, body, headers]
 * Guards against misinterpreting numeric arrays like [1, 2, 3] as tuples.
 *
 * Known ambiguity: a length-2 numeric array whose first element happens to
 * be in the HTTP-status range (e.g. [200, 300] as legitimate data) is
 * indistinguishable from a status tuple by shape alone. Prefer the explicit
 * status() helper or return an object response when the data could collide.
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
