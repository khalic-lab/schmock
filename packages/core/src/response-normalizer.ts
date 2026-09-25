import { isBinaryBody } from "./binary.js";
import { errorMessage, InvalidResponseError } from "./errors.js";
import { hasHeader } from "./headers.js";

const BODY_FORBIDDEN_STATUSES = new Set([204, 205, 304]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FRAMING_HEADERS = new Set([
  "content-length",
  "trailer",
  "transfer-encoding",
]);
/**
 * Headers that describe the connection rather than the message (RFC 9110 §7.6.1).
 * Kept separate from {@link FRAMING_HEADERS}, which is parameterised by
 * `preserveContentLength`: these are never a route's to send, so the strip is
 * unconditional.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "upgrade",
]);
type OwnedBytes = ReturnType<typeof Uint8Array.of>;

interface NormalizableResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function hasInvalidHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || (code >= 10 && code <= 31) || code === 127) return true;
  }
  return false;
}

function validateStatus(status: number): void {
  if (
    typeof status !== "number" ||
    !Number.isFinite(status) ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599
  ) {
    throw new InvalidResponseError(
      "status must be a finite integer from 200 through 599",
      { status },
    );
  }
}

function headerEntries(
  headers: Record<string, string>,
): Array<[string, string]> {
  if (
    typeof headers !== "object" ||
    headers === null ||
    Array.isArray(headers)
  ) {
    throw new InvalidResponseError("headers must be a string record");
  }

  try {
    const entries: Array<[string, string]> = [];

    for (const name of Reflect.ownKeys(headers)) {
      const descriptor = Object.getOwnPropertyDescriptor(headers, name);
      if (!descriptor?.enumerable) continue;
      if (typeof name !== "string") {
        throw new InvalidResponseError("header names must be strings");
      }

      const value: unknown = headers[name];
      if (typeof value !== "string") {
        throw new InvalidResponseError("header values must be strings", {
          headerName: name,
        });
      }
      entries.push([name, value]);
    }

    return entries;
  } catch (error) {
    if (error instanceof InvalidResponseError) throw error;
    throw new InvalidResponseError("headers could not be read", {
      cause: errorMessage(error),
    });
  }
}

function normalizeHeadersWithPlatform(
  entries: Array<[string, string]>,
  PlatformHeaders: typeof Headers,
): Record<string, string> {
  try {
    const normalized: Record<string, string> = {};
    for (const [name, value] of entries) {
      try {
        const headers = new PlatformHeaders([[name, value]]);
        normalized[name] = headers.get(name) ?? value;
      } catch (error) {
        throw new InvalidResponseError("header is invalid", {
          cause: errorMessage(error),
          headerName: name,
        });
      }
    }
    return normalized;
  } catch (error) {
    if (error instanceof InvalidResponseError) throw error;
    throw new InvalidResponseError("headers could not be normalized", {
      cause: errorMessage(error),
    });
  }
}

function normalizeHeadersWithoutPlatform(
  entries: Array<[string, string]>,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [name, value] of entries) {
    if (!HEADER_NAME_PATTERN.test(name) || hasInvalidHeaderValue(value)) {
      throw new InvalidResponseError("header is invalid", {
        headerName: name,
      });
    }

    normalized[name] = value.replace(/^[\t ]+|[\t ]+$/g, "");
  }

  return normalized;
}

function normalizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const entries = headerEntries(headers);
  const seenNames = new Set<string>();
  for (const [name, value] of entries) {
    const normalizedName = name.toLowerCase();
    if (seenNames.has(normalizedName)) {
      throw new InvalidResponseError("header names must be unique", {
        headerName: name,
      });
    }
    if (!HEADER_NAME_PATTERN.test(name) || hasInvalidHeaderValue(value)) {
      throw new InvalidResponseError("header is invalid", {
        headerName: name,
      });
    }
    seenNames.add(normalizedName);
  }
  const PlatformHeaders = globalThis.Headers;

  return typeof PlatformHeaders === "function"
    ? normalizeHeadersWithPlatform(entries, PlatformHeaders)
    : normalizeHeadersWithoutPlatform(entries);
}

function copyBinaryBody(body: ArrayBuffer | ArrayBufferView): OwnedBytes {
  try {
    if (body instanceof Uint8Array) {
      // Uint8Array.prototype.slice species-creates, so subclasses such as
      // Node's Buffer keep their type while the bytes are still copied.
      // body.slice() would not: Buffer overrides slice() to return a view.
      return Uint8Array.prototype.slice.call(body);
    }
    const source =
      body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return Uint8Array.from(source);
  } catch (error) {
    throw new InvalidResponseError("binary body could not be copied", {
      cause: errorMessage(error),
    });
  }
}

function bodyType(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;

  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "object";
  }
}

function hasFunctionProperty(value: object, property: PropertyKey): boolean {
  return typeof Reflect.get(value, property) === "function";
}

function assertJsonCompatible(value: unknown): void {
  if (value === null) return;

  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (Number.isFinite(value)) return;
      throw new InvalidResponseError("body contains a non-finite number", {
        bodyType: "number",
      });
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new InvalidResponseError(
        `body contains an unsupported ${typeof value} value`,
        { bodyType: typeof value },
      );
    case "object":
      break;
  }

  try {
    if (isBinaryBody(value)) {
      throw new InvalidResponseError(
        "binary values are supported only as the top-level body",
        { bodyType: bodyType(value) },
      );
    }

    if (
      hasFunctionProperty(value, "then") ||
      hasFunctionProperty(value, "getReader") ||
      hasFunctionProperty(value, "getWriter") ||
      (hasFunctionProperty(value, "pipe") &&
        hasFunctionProperty(value, "on")) ||
      hasFunctionProperty(value, Symbol.asyncIterator)
    ) {
      throw new InvalidResponseError(
        "promise, iterable, and stream bodies are unsupported",
        { bodyType: bodyType(value) },
      );
    }

    for (const key of Reflect.ownKeys(value)) {
      if (
        typeof key === "symbol" &&
        Object.getOwnPropertyDescriptor(value, key)?.enumerable
      ) {
        throw new InvalidResponseError(
          "body contains an enumerable symbol property",
          { bodyType: bodyType(value) },
        );
      }
    }

    if (
      !Array.isArray(value) &&
      Object.prototype.toString.call(value) !== "[object Object]"
    ) {
      throw new InvalidResponseError("body contains an unsupported object", {
        bodyType: bodyType(value),
      });
    }
  } catch (error) {
    if (error instanceof InvalidResponseError) throw error;
    throw new InvalidResponseError("body could not be inspected", {
      bodyType: bodyType(value),
      cause: errorMessage(error),
    });
  }
}

function stringifyJsonBody(body: unknown): string {
  try {
    const serialized = JSON.stringify(body, (_key, value: unknown) => {
      assertJsonCompatible(value);
      return value;
    });

    if (serialized !== undefined) return serialized;
    throw new InvalidResponseError("body did not produce JSON", {
      bodyType: bodyType(body),
    });
  } catch (error) {
    if (error instanceof InvalidResponseError) throw error;
    throw new InvalidResponseError("body is not JSON-serializable", {
      bodyType: bodyType(body),
      cause: errorMessage(error),
    });
  }
}

function normalizeBody(body: unknown): unknown {
  if (body === undefined || typeof body === "string") return body;
  if (isBinaryBody(body)) return copyBinaryBody(body);
  return JSON.parse(stringifyJsonBody(body));
}

function removeFramingHeaders(
  headers: Record<string, string>,
  preserveContentLength = false,
): void {
  for (const name of Object.keys(headers)) {
    const normalizedName = name.toLowerCase();
    if (
      FRAMING_HEADERS.has(normalizedName) &&
      !(preserveContentLength && normalizedName === "content-length")
    ) {
      delete headers[name];
    }
  }
}

function removeHopByHopHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) delete headers[name];
  }
}

/**
 * Validate and stabilize a response before it reaches a transport adapter.
 */
export function normalizeResponse(
  response: NormalizableResponse,
  method: string,
): Schmock.Response {
  const status = response.status;
  validateStatus(status);
  const headers = normalizeHeaders(response.headers ?? {});
  const normalizedMethod = method.toUpperCase();
  const body =
    normalizedMethod === "HEAD" || BODY_FORBIDDEN_STATUSES.has(status)
      ? undefined
      : normalizeBody(response.body);

  // HEAD and 304 may keep an entity Content-Length (RFC 9110), but 204/205
  // never carry one. Trailer and Transfer-Encoding are always removed —
  // Node's writeHead rejects them on bodyless responses, killing the socket
  // before any bytes reach the client.
  if (status === 204 || status === 205) {
    removeFramingHeaders(headers);
  } else {
    removeFramingHeaders(
      headers,
      normalizedMethod === "HEAD" || status === 304,
    );
  }

  // A hop-by-hop header belongs to the connection, which the transport owns:
  // a route that emits `Connection: close` announces a close the server will
  // not perform, and a conformant client then discards the next response on
  // that socket. Adapters that genuinely mean it (an ingress rejection) add it
  // after normalization, through their own extra-headers channel.
  removeHopByHopHeaders(headers);

  return {
    status,
    body,
    headers,
  };
}

/**
 * Encode a response body using its normalized content type semantics.
 */
export function serializeResponseBody(
  response: Schmock.Response,
): OwnedBytes | undefined {
  const status = response.status;
  validateStatus(status);
  if (BODY_FORBIDDEN_STATUSES.has(status)) return undefined;

  const body = response.body;
  if (body === undefined) return undefined;
  if (isBinaryBody(body)) return copyBinaryBody(body);

  // A string body is treated as pre-serialized wire bytes regardless of
  // content type: quoting it under application/json would double-encode
  // routes that return JSON.stringify(...) themselves.
  const serialized = typeof body === "string" ? body : stringifyJsonBody(body);
  return new TextEncoder().encode(serialized);
}

/**
 * Give a response the content type its body implies when it declares none:
 * `application/octet-stream` for a binary body, `application/json` for any
 * other non-string body (`null` included, which serializes as JSON). A string
 * body is sent as-is and gets no default.
 *
 * Total: it never throws and never mutates `response`. The result is not
 * normalized; pass it to `normalizeResponse` when it still needs to be.
 */
export function withDefaultContentType(
  response: Schmock.Response,
): Schmock.Response {
  const headers = { ...response.headers };
  const body = response.body;
  if (body !== undefined && !hasHeader(headers, "content-type")) {
    if (isBinaryBody(body)) {
      headers["content-type"] = "application/octet-stream";
    } else if (typeof body !== "string") {
      headers["content-type"] = "application/json";
    }
  }
  return { status: response.status, body, headers };
}

/**
 * A formatted error body is always JSON, whatever the replaced response
 * declared. Every case variant of content-type is dropped first: a leftover
 * `Content-Type` beside the lowercase key makes the pair untransportable.
 */
function withJsonContentType(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === "content-type") continue;
    result[name] = value;
  }
  result["content-type"] = "application/json";
  return result;
}

/**
 * The JSON error envelope `{ "error": message, "code": code }` every transport
 * answers a failure with, normalized for `method`. `headers` are added after
 * the JSON content type (a 405's `allow`). The one constructor of that shape,
 * so `handle()`, `listen()` and `intercept()` cannot drift apart.
 */
export function buildJsonErrorResponse(input: {
  status: number;
  error: string;
  code: string;
  method: string;
  headers?: Readonly<Record<string, string>>;
}): Schmock.Response {
  return normalizeResponse(
    {
      status: input.status,
      body: { error: input.error, code: input.code },
      headers: { "content-type": "application/json", ...input.headers },
    },
    input.method,
  );
}

function internalErrorResponse(method: string): Schmock.Response {
  return buildJsonErrorResponse({
    status: 500,
    error: "Internal Server Error",
    code: "INTERNAL_ERROR",
    method,
  });
}

/**
 * Run an `errorFormatter` and build the normalized 500 that carries its result.
 *
 * Total: it never throws, and the formatter runs exactly once. There are two
 * fallbacks. When the inherited headers cannot be sent (a non-string value, a
 * control character, a case-duplicate name), the formatted body is kept and
 * sent with the fixed JSON header set instead, since losing the body would
 * silently change the caller's error contract. When the formatter throws or
 * its result cannot be serialized, the minimal
 * `{ error: "Internal Server Error", code: "INTERNAL_ERROR" }` body is sent,
 * inheriting nothing.
 */
export function buildFormattedErrorResponse(
  options: Schmock.FormattedErrorOptions,
): Schmock.Response {
  const { formatter, error, inheritedHeaders, method } = options;
  let formatted: unknown;
  try {
    formatted = formatter(error);
  } catch {
    return internalErrorResponse(method);
  }
  try {
    return normalizeResponse(
      {
        status: 500,
        body: formatted,
        headers: withJsonContentType(inheritedHeaders),
      },
      method,
    );
  } catch {
    // The inherited headers were not transportable. `formatted` is reused,
    // so the formatter still fires exactly once.
  }
  try {
    return normalizeResponse(
      {
        status: 500,
        body: formatted,
        headers: { "content-type": "application/json" },
      },
      method,
    );
  } catch {
    return internalErrorResponse(method);
  }
}
