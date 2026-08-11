import { isBinaryBody } from "./binary.js";
import { serializeResponseBody } from "./response-normalizer.js";

interface RequestWithHeaders {
  readonly headers: {
    readonly [header: string]: string | string[] | undefined;
  };
}

interface BodyReadable {
  on(event: "aborted", listener: () => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "data", listener: (chunk: Uint8Array) => void): this;
  on(event: "end", listener: () => void): this;
  destroy(error?: Error): this;
}

interface ResponseWritable {
  writeHead(status: number, headers: Record<string, string>): this;
  end(body?: string | Uint8Array): this;
}

export type HttpIngressErrorCode = "MALFORMED_JSON" | "PAYLOAD_TOO_LARGE";

/** An HTTP client error raised while collecting an incoming request body. */
export class HttpIngressError extends Error {
  constructor(
    public readonly status: 400 | 413,
    public readonly code: HttpIngressErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpIngressError";
  }
}

/**
 * Convert Node.js IncomingMessage headers to a flat Record<string, string>.
 * Drops array-valued headers (keeps only string values).
 */
export function parseNodeHeaders(
  req: RequestWithHeaders,
): Record<string, string> {
  // Object.fromEntries defines own properties, so a header literally named
  // `__proto__` is preserved instead of being swallowed by the prototype
  // setter. The prototype is retained so consumers keep Object.prototype.
  return Object.fromEntries(
    Object.entries(req.headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * Extract query parameters from a URL as a flat Record<string, string>.
 */
export function parseNodeQuery(url: URL): Record<string, string> {
  // Own-property definition for the same reason as parseNodeHeaders, and it
  // matches how the fetch interceptor builds its query record.
  return Object.fromEntries(url.searchParams);
}

/** Default body size limit: 10 MB */
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;
const DECIMAL_CONTENT_LENGTH = /^\d+$/;

function payloadTooLargeError(): HttpIngressError {
  return new HttpIngressError(
    413,
    "PAYLOAD_TOO_LARGE",
    "Request body too large",
  );
}

function requestAbortedError(): Error {
  const error = new Error("Request body collection aborted");
  error.name = "AbortError";
  return error;
}

function isJsonMediaType(contentType: string): boolean {
  const baseMediaType =
    contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    baseMediaType === "application/json" || baseMediaType.endsWith("+json")
  );
}

/**
 * Collect and parse the request body from a Node.js IncomingMessage.
 * Returns parsed JSON for application/json and +json media types, otherwise the
 * raw string.
 * Returns undefined for empty bodies.
 * @param req - Node.js IncomingMessage
 * @param headers - Parsed request headers
 * @param maxBodySize - Maximum body size in bytes (default: 10 MB)
 */
export function collectBody(
  req: BodyReadable,
  headers: Record<string, string>,
  maxBodySize = DEFAULT_MAX_BODY_SIZE,
): Promise<unknown> {
  const contentLength = headers["content-length"];
  const declaredBodyTooLarge =
    contentLength !== undefined &&
    DECIMAL_CONTENT_LENGTH.test(contentLength) &&
    Number(contentLength) > maxBodySize;

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };

    const resolveOnce = (body: unknown): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      resolve(body);
    };

    if (declaredBodyTooLarge) {
      rejectOnce(payloadTooLargeError());
    }

    req.on("error", rejectOnce);
    req.on("aborted", () => rejectOnce(requestAbortedError()));
    req.on("close", () => rejectOnce(requestAbortedError()));

    req.on("data", (chunk: Uint8Array) => {
      if (settled) return;

      totalSize += chunk.byteLength;
      if (totalSize > maxBodySize) {
        rejectOnce(payloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;

      const raw = Buffer.concat(chunks).toString();
      if (!raw) {
        resolveOnce(undefined);
        return;
      }
      const contentType = headers["content-type"] ?? "";
      if (isJsonMediaType(contentType)) {
        try {
          resolveOnce(JSON.parse(raw));
        } catch {
          rejectOnce(
            new HttpIngressError(
              400,
              "MALFORMED_JSON",
              "Malformed JSON request body",
            ),
          );
        }
      } else {
        resolveOnce(raw);
      }
    });
  });
}

interface RejectedRequestReadable {
  resume(): unknown;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  off(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  once(event: "end" | "close", listener: () => void): unknown;
}

interface RejectedResponseWritable extends ResponseWritable {
  readonly writableEnded: boolean;
  write(chunk: string | Uint8Array): unknown;
  once(event: "close", listener: () => void): unknown;
}

/** How long a rejected request may stay silent before the response ends. */
const REJECTED_REQUEST_IDLE_MS = 400;
/** Hard cap for a client that keeps streaming after a rejected request. */
const REJECTED_REQUEST_DRAIN_GRACE_MS = 5_000;

function prepareWriteableResponse(
  response: Schmock.Response,
  extraHeaders?: Record<string, string>,
): { headers: Record<string, string>; body: Uint8Array | undefined } {
  const responseHeaders: Record<string, string> = { ...response.headers };
  if (extraHeaders) {
    const names = new Map(
      Object.keys(responseHeaders).map((name) => [name.toLowerCase(), name]),
    );
    for (const [name, value] of Object.entries(extraHeaders)) {
      const previousName = names.get(name.toLowerCase());
      if (previousName !== undefined) delete responseHeaders[previousName];
      responseHeaders[name] = value;
      names.set(name.toLowerCase(), name);
    }
  }

  const hasContentType = Object.keys(responseHeaders).some(
    (header) => header.toLowerCase() === "content-type",
  );

  if (
    !hasContentType &&
    response.body !== undefined &&
    isBinaryBody(response.body)
  ) {
    responseHeaders["content-type"] = "application/octet-stream";
  } else if (
    !hasContentType &&
    response.body !== undefined &&
    typeof response.body !== "string"
  ) {
    responseHeaders["content-type"] = "application/json";
  }

  const body = serializeResponseBody({
    ...response,
    headers: responseHeaders,
  });

  return { headers: responseHeaders, body };
}

/**
 * Write a Schmock Response to a Node.js ServerResponse.
 * Serializes non-string bodies as JSON and sets content-type when missing.
 */
export function writeSchmockResponse(
  res: ResponseWritable,
  response: Schmock.Response,
  extraHeaders?: Record<string, string>,
): void {
  const { headers, body } = prepareWriteableResponse(response, extraHeaders);
  res.writeHead(response.status, headers);
  res.end(body);
}

/**
 * Write a rejection (e.g. 413) while the client may still be uploading.
 *
 * Ending the response immediately makes Node tear the socket down while
 * request bytes are in flight; the resulting TCP reset discards the
 * already-written error from the client's receive buffer, so the client
 * observes ECONNRESET instead of the response. Instead the response body is
 * flushed right away and the end is deferred — a lingering close — until the
 * request finishes, goes idle, or exhausts the grace cap.
 */
export function writeRejectedSchmockResponse(
  req: RejectedRequestReadable,
  res: RejectedResponseWritable,
  response: Schmock.Response,
  extraHeaders?: Record<string, string>,
): void {
  const { headers, body } = prepareWriteableResponse(response, extraHeaders);
  res.writeHead(response.status, headers);
  if (body !== undefined) res.write(body);

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const onData = () => {
    // The client is still sending: keep the socket open so its bytes have
    // somewhere to go, pushing the deferred end out with every chunk.
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(finish, REJECTED_REQUEST_IDLE_MS);
    (idleTimer as { unref?(): void }).unref?.();
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    req.off("data", onData);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (!res.writableEnded) res.end();
  };

  req.on("data", onData);
  req.once("end", finish);
  req.once("close", finish);
  res.once("close", finish);
  onData();
  graceTimer = setTimeout(finish, REJECTED_REQUEST_DRAIN_GRACE_MS);
  (graceTimer as { unref?(): void }).unref?.();
  req.resume();
}
