import { isBinaryBody } from "./binary.js";
import { isStatusTuple } from "./constants.js";
import { InvalidResponseError } from "./errors.js";
import { hasHeader } from "./headers.js";

const BINARY_CONTENT_TYPE = "application/octet-stream";

/**
 * Take ownership of caller-supplied response headers.
 *
 * Parsing injects a content type into the header record, so the caller's object
 * must never be aliased — a generator reusing a module-level header object would
 * otherwise leak the content type of one response into the next. Only the shape
 * is checked here; per-value type checks stay in `normalizeResponse` so its
 * distinct messages ("header names/values must be strings") are preserved.
 */
function toOwnHeaderRecord(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidResponseError("headers must be a string record");
  }
  // Per-value types are `normalizeResponse`'s job (it keeps its own distinct
  // message), so a non-string value is carried through here rather than
  // rejected; this pass only shape-checks and detaches the caller's object.
  const record: Record<string, string> = {};
  Object.assign(record, value);
  return record;
}

function hasContentType(headers: Record<string, string>): boolean {
  return hasHeader(headers, "content-type");
}

/**
 * Detect the object response envelope `{ status, body, headers? }`.
 *
 * Detection is by shape, so a legitimate domain object carrying a numeric
 * `status` next to a `body` is unwrapped instead of being delivered as the
 * payload. Callers who need to return such a shape as data should nest it or
 * use an explicit `[status, body]` tuple for the envelope. An object whose
 * `headers` is present but not a string record is deliberately NOT an envelope
 * and is delivered whole — plugins that inspect responses read them through
 * {@link getResponseParts}, which applies this same rule, or they will judge
 * an undelivered payload.
 */
function isResponseObject(value: unknown): value is {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "status" in value &&
    typeof value.status === "number" &&
    "body" in value &&
    (!("headers" in value) ||
      value.headers === undefined ||
      isStringRecord(value.headers))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/** A route result split on the envelope rules, headers not yet checked. */
interface DecomposedResponse {
  kind: Schmock.ResponseParts["kind"];
  status: number;
  body: unknown;
  /** The carried headers exactly as given: absent, a record, or anything. */
  rawHeaders: unknown;
}

/**
 * The single place a route result is split into status, body and headers.
 * `parseResponse` and the exported `getResponseParts` both build on it, so
 * what a plugin inspects is what core delivers.
 */
function decomposeResponse(result: unknown): DecomposedResponse {
  // Handle already-formed response objects (from plugin error recovery)
  if (isResponseObject(result)) {
    return {
      kind: "object",
      status: result.status,
      body: result.body,
      rawHeaders: result.headers,
    };
  }
  // Handle tuple response format [status, body, headers?]
  if (isStatusTuple(result)) {
    return {
      kind: "tuple",
      status: result[0],
      body: result[1],
      rawHeaders: result[2],
    };
  }
  return { kind: "plain", status: 200, body: result, rawHeaders: undefined };
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Split a route or plugin result into the status, body and headers core will
 * answer with, using exactly the guards `handle()` applies: an object is an
 * envelope only when it has a numeric `status`, a `body`, and `headers` that
 * are absent or a string record; anything else is delivered whole as the body.
 *
 * `body` is the element as carried (`null` stays `null`, though core sends no
 * body for it), `status` is what core answers with (a plain `null` or
 * `undefined` result is 204), and `headers` is a fresh copy, `{}` when the
 * carried headers are not a string record.
 */
export function getResponseParts(response: unknown): Schmock.ResponseParts {
  const parts = decomposeResponse(response);
  return {
    kind: parts.kind,
    status:
      parts.kind === "plain" && isNullish(parts.body) ? 204 : parts.status,
    body: parts.body,
    headers: isStringRecord(parts.rawHeaders) ? { ...parts.rawHeaders } : {},
  };
}

/**
 * Put `body` in place of the body `response` carries, keeping its shape: a
 * tuple stays a tuple of the same length, an envelope keeps its status and
 * headers (other properties are dropped, as core ignores them), and a plain
 * result is replaced by `body` itself. Never mutates `response`.
 */
export function replaceResponseBody(response: unknown, body: unknown): unknown {
  if (isResponseObject(response)) {
    return response.headers === undefined
      ? { status: response.status, body }
      : { status: response.status, body, headers: response.headers };
  }
  if (isStatusTuple(response)) {
    return response.length === 3
      ? [response[0], body, response[2]]
      : [response[0], body];
  }
  return body;
}

/**
 * Parse and normalize response result into Response object
 * Handles tuple format [status, body, headers], direct values, and response objects
 */
export function parseResponse(
  result: unknown,
  routeConfig: Schmock.RouteConfig,
): Schmock.Response {
  const parts = decomposeResponse(result);
  let status = parts.status;
  let body: unknown = parts.body;
  const headers = toOwnHeaderRecord(parts.rawHeaders);
  const tupleFormat = parts.kind !== "plain";

  // Handle null/undefined responses with 204 No Content
  // But don't auto-convert if tuple format was used (status was explicitly provided)
  if (body === null || body === undefined) {
    if (!tupleFormat) {
      status = status === 200 ? 204 : status; // Only change to 204 if status wasn't explicitly set via tuple
    }
    body = undefined; // Ensure body is undefined for null responses
  }

  const binaryBody = isBinaryBody(body);

  // Binary response values need a transport-safe MIME type. Tuple headers still
  // take precedence, while a non-JSON route override (for example image/png)
  // remains authoritative for non-tuple responses.
  if (!hasContentType(headers) && binaryBody) {
    headers["content-type"] =
      !tupleFormat &&
      routeConfig.contentType &&
      routeConfig.contentType !== "application/json"
        ? routeConfig.contentType
        : BINARY_CONTENT_TYPE;
  }

  // Add content-type header from route config if it exists and headers don't already have it
  // But only if this isn't a tuple response (where headers are explicitly controlled)
  let appliedRouteContentType = false;
  if (!hasContentType(headers) && routeConfig.contentType && !tupleFormat) {
    headers["content-type"] = routeConfig.contentType;
    appliedRouteContentType = true;
  }

  // Handle special conversion cases when contentType is explicitly set. A
  // binary body keeps its bytes even when a custom MIME type is configured.
  if (
    appliedRouteContentType &&
    routeConfig.contentType === "text/plain" &&
    body !== undefined &&
    !binaryBody
  ) {
    if (typeof body === "object") {
      body = JSON.stringify(body);
    } else if (typeof body !== "string") {
      body = String(body);
    }
  }

  return {
    status,
    body,
    headers,
  };
}
