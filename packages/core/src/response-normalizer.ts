import { isBinaryBody } from "./binary.js";
import { errorMessage, InvalidResponseError } from "./errors.js";

const BODY_FORBIDDEN_STATUSES = new Set([204, 205, 304]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FRAMING_HEADERS = new Set([
  "content-length",
  "trailer",
  "transfer-encoding",
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
