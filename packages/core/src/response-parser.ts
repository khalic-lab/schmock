import { isBinaryBody } from "./binary.js";
import { isStatusTuple } from "./constants.js";
import { InvalidResponseError } from "./errors.js";

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
  return Object.keys(headers).some(
    (header) => header.toLowerCase() === "content-type",
  );
}

/**
 * Detect the object response envelope `{ status, body, headers? }`.
 *
 * Detection is by shape, so a legitimate domain object carrying a numeric
 * `status` next to a `body` is unwrapped instead of being delivered as the
 * payload. Callers who need to return such a shape as data should nest it or
 * use an explicit `[status, body]` tuple for the envelope. An object whose
 * `headers` is present but not a string record is deliberately NOT an envelope
 * and is delivered whole — plugins that inspect responses must use this same
 * rule (see `@schmock/validation`) or they will judge an undelivered payload.
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

/**
 * Parse and normalize response result into Response object
 * Handles tuple format [status, body, headers], direct values, and response objects
 */
export function parseResponse(
  result: unknown,
  routeConfig: Schmock.RouteConfig,
): Schmock.Response {
  let status = 200;
  let body: unknown = result;
  let headers: Record<string, string> = {};

  let tupleFormat = false;

  // Handle already-formed response objects (from plugin error recovery)
  if (isResponseObject(result)) {
    status = result.status;
    body = result.body;
    headers = toOwnHeaderRecord(result.headers);
    tupleFormat = true;
  } else if (isStatusTuple(result)) {
    // Handle tuple response format [status, body, headers?]
    [status, body] = result;
    headers = toOwnHeaderRecord(result[2]);
    tupleFormat = true;
  }

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
