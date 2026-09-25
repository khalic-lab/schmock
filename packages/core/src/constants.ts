import { InvalidHttpMethodError } from "./errors.js";
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

/**
 * Uppercase `method` and narrow it to an {@link HttpMethod}.
 * @throws InvalidHttpMethodError (code `INVALID_HTTP_METHOD`) for any other verb
 */
export function toHttpMethod(method: string): HttpMethod {
  const upper = method.toUpperCase();
  if (!isHttpMethod(upper)) {
    throw new InvalidHttpMethodError(method);
  }
  return upper;
}

export function normalizePath(path: string): string {
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}

/**
 * ASCII characters the URL parser percent-encodes inside a path even though
 * they are printable. `?` and `#` are delimiters there rather than encoded, but
 * encoding them here is what makes a route containing one reachable at all.
 */
const PATH_ENCODED_ASCII = new Set([
  " ",
  '"',
  "#",
  "<",
  ">",
  "?",
  "^",
  "`",
  "{",
  "}",
]);

const PERCENT_TRIPLET = /^%[0-9A-Fa-f]{2}$/;
/**
 * Paths made only of characters the loop below copies unchanged: printable
 * ASCII minus {@link PATH_ENCODED_ASCII} and minus `%`, which always takes the
 * loop so a lowercase triplet is still uppercased. `&-;` starts after `%`
 * (0x25) on purpose.
 */
const ALREADY_CANONICAL_PATH = /^[!$&-;=@-\]_a-z|~]*$/;
/** UTF-8 for U+FFFD, the URL parser's substitute for a lone surrogate. */
const ENCODED_REPLACEMENT_CHARACTER = "%EF%BF%BD";

/**
 * Put a path into the single canonical (percent-encoded) transport form.
 *
 * A path reaches core either as `url.pathname` (already encoded by the URL
 * parser) or as whatever string a `handle()` caller typed, so route paths and
 * request paths must be encoded the same way before they can be compared.
 * Encoding is idempotent: an existing valid `%XX` triplet is normalized to
 * uppercase rather than re-encoded, so applying this at route-parse time and
 * again at request time is safe.
 *
 * This deliberately never throws and never resolves `.`/`..` — an unreachable
 * spelling is preferable to silently rewriting the caller's path.
 */
export function canonicalizePath(path: string): string {
  // Fast path for the common case, which runs on every request: nothing to
  // encode and no percent triplet to uppercase.
  if (ALREADY_CANONICAL_PATH.test(path)) return path;

  let result = "";
  for (let index = 0; index < path.length; ) {
    if (
      path[index] === "%" &&
      PERCENT_TRIPLET.test(path.slice(index, index + 3))
    ) {
      result += path.slice(index, index + 3).toUpperCase();
      index += 3;
      continue;
    }

    const codePoint = path.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    index += character.length;

    if (
      codePoint <= 0x1f ||
      codePoint > 0x7e ||
      PATH_ENCODED_ASCII.has(character)
    ) {
      try {
        result += encodeURIComponent(character);
      } catch {
        result += ENCODED_REPLACEMENT_CHARACTER;
      }
    } else {
      result += character;
    }
  }
  return result;
}

/**
 * The one trailing-slash rule for a path prefix: a single trailing slash is
 * dropped, so "/api/" and "/api" are the same prefix, and the root "/" becomes
 * "" (matches every path).
 */
function trimPrefixPath(canonicalPath: string): string {
  return canonicalPath === "/" ? "" : canonicalPath.replace(/\/$/, "");
}

/**
 * Parse a `baseUrl` or namespace into its origin and canonical path prefix.
 *
 * - "/api/"                → { origin: null, path: "/api" }
 * - "api"                  → { origin: null, path: "/api" }
 * - "https://x.com/api/v1" → { origin: "https://x.com", path: "/api/v1" }
 * - "https://x.com"        → { origin: "https://x.com", path: "" }
 *
 * The path is canonicalized like request paths are (so "/café" and
 * "/caf%C3%A9" are one prefix), gains a leading slash when it has none, and
 * loses one trailing slash. A value containing "://" that is not a valid URL
 * is read as a path.
 */
export function parsePathPrefix(prefix: string): Schmock.PathPrefix {
  if (prefix.includes("://")) {
    try {
      const url = new URL(prefix);
      return {
        origin: url.origin,
        path: trimPrefixPath(canonicalizePath(url.pathname)),
      };
    } catch {
      // Not a URL after all: read it as a path below.
    }
  }
  const rooted = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return { origin: null, path: trimPrefixPath(canonicalizePath(rooted)) };
}

/**
 * Whether `path` lies under the prefix, on a segment boundary: "/api" matches
 * "/api" and "/api/users" but never "/apiv2". `path` is canonicalized first,
 * so a raw or an encoded spelling of the same path match alike. Only the path
 * is compared; checking `prefix.origin` against the request's origin is the
 * caller's job.
 */
export function matchPathPrefix(
  prefix: Schmock.PathPrefix,
  path: string,
): boolean {
  if (prefix.path === "") return true;
  const canonicalPath = canonicalizePath(path);
  return (
    canonicalPath === prefix.path || canonicalPath.startsWith(`${prefix.path}/`)
  );
}

/**
 * Decode a single captured path parameter.
 *
 * Decoding happens AFTER segmentation, so an encoded separator (`%2F`) stays
 * inside one parameter and reaches the generator as "/" — the same as Express.
 * A malformed sequence (`%ZZ`) is handed back untouched rather than throwing.
 */
export function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Build a route key from a method and a path.
 *
 * `Schmock.RouteKey` requires a leading slash, so a path without one is
 * normalized rather than rejected — callers feed spec paths and pathnames that
 * are already absolute, and silently producing an unreachable route key would
 * be worse than adding the slash.
 */
export function toRouteKey(method: HttpMethod, path: string): Schmock.RouteKey {
  // Built from the slash rather than concatenated onto it, so the template
  // literal proves the leading slash `RouteKey` requires without an assertion.
  const relativePath = path.startsWith("/") ? path.slice(1) : path;
  return `${method} /${relativePath}`;
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
 * Only the length and the status are checked, so the third element is typed
 * `unknown`: a caller that reads it as headers must check it is a string
 * record first (core's response parser rejects anything else with
 * INVALID_RESPONSE). Rejecting such a tuple here instead would make the parser
 * treat `[200, "x", null]` as plain array data and answer 200.
 *
 * Known ambiguity: a length-2 numeric array whose first element happens to
 * be in the HTTP-status range (e.g. [200, 300] as legitimate data) is
 * indistinguishable from a status tuple by shape alone. Prefer the explicit
 * status() helper or return an object response when the data could collide.
 */
export function isStatusTuple(
  value: unknown,
): value is [number, unknown] | [number, unknown, unknown] {
  return (
    Array.isArray(value) &&
    (value.length === 2 || value.length === 3) &&
    typeof value[0] === "number" &&
    value[0] >= 100 &&
    value[0] <= 599
  );
}
