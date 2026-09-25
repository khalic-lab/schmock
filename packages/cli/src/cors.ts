import type * as Schmock from "@schmock/core";
import { HTTP_METHODS } from "@schmock/core";

/**
 * A request's raw headers, as Node delivers them. Structural rather than
 * `IncomingMessage`, so it accepts the request whichever `@types/node` copy
 * typed it.
 */
export interface HeaderSource {
  readonly headers: {
    readonly [header: string]: string | string[] | undefined;
  };
}

const ALLOWED_METHODS = HTTP_METHODS.join(", ");
/**
 * What `Access-Control-Allow-Headers` reports when the request names nothing —
 * an ordinary response, or a preflight whose requested list is unusable.
 */
const DEFAULT_ALLOWED_REQUEST_HEADERS = "Content-Type, Authorization";
/** A comma-separated list of RFC 9110 field names, and nothing else. */
const REQUEST_HEADER_LIST =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*,[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+)*$/;

/**
 * A repeated header arrives as an array; treat that as "not presented" rather
 * than joining it, so a duplicated `Authorization` cannot smuggle a token past
 * the comparison.
 */
export function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Echo back the headers the browser asked to send, so a preflight for a custom
 * header (`x-my-token`) is not failed by a fixed list.
 *
 * The value is client input on its way to `res.writeHead`, which merges extra
 * headers without revalidating them, so anything that is not a plain field-name
 * list falls back to the default rather than reaching Node — an invalid
 * character there throws and would turn a malformed preflight into a 500.
 */
function requestedAllowHeaders(req: HeaderSource): string {
  const requested = singleHeader(req.headers["access-control-request-headers"]);
  const trimmed = requested?.trim();
  if (trimmed === undefined || trimmed === "") {
    return DEFAULT_ALLOWED_REQUEST_HEADERS;
  }
  return REQUEST_HEADER_LIST.test(trimmed)
    ? trimmed
    : DEFAULT_ALLOWED_REQUEST_HEADERS;
}

/**
 * The CORS headers for one request. A dev-server convenience, not a policy:
 * the origin is always `*`, which is why credentials are never allowed and no
 * `Vary: Origin` is needed.
 */
export function corsHeadersFor(req: HeaderSource): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": requestedAllowHeaders(req),
  };
}

/**
 * A browser preflight, as opposed to any other OPTIONS request: both `Origin`
 * and `Access-Control-Request-Method` are present. Answering only these leaves
 * a spec-declared `options` operation reachable, and keeps an unrouted path
 * answering 404 instead of a misleading 204.
 */
export function isCorsPreflight(
  req: HeaderSource,
  method: Schmock.HttpMethod,
): boolean {
  return (
    method === "OPTIONS" &&
    singleHeader(req.headers.origin) !== undefined &&
    singleHeader(req.headers["access-control-request-method"]) !== undefined
  );
}
