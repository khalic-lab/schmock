import { isStatusTuple } from "./constants.js";

function isResponseObject(value: unknown): value is {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof (value as Record<string, unknown>).status === "number" &&
    "body" in value
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
    return {
      status: result.status,
      body: result.body,
      headers: result.headers || {},
    };
  }

  // Handle tuple response format [status, body, headers?]
  if (isStatusTuple(result)) {
    [status, body, headers = {}] = result;
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

  // Add content-type header from route config if it exists and headers don't already have it
  // But only if this isn't a tuple response (where headers are explicitly controlled)
  if (!headers["content-type"] && routeConfig.contentType && !tupleFormat) {
    headers["content-type"] = routeConfig.contentType;

    // Handle special conversion cases when contentType is explicitly set
    if (routeConfig.contentType === "text/plain" && body !== undefined) {
      if (typeof body === "object" && !Buffer.isBuffer(body)) {
        body = JSON.stringify(body);
      } else if (typeof body !== "string") {
        body = String(body);
      }
    }
  }

  return {
    status,
    body,
    headers,
  };
}
