import { HTTP_METHODS, isHttpMethod } from "./constants.js";
import { SchmockError } from "./errors.js";
import { getHeader, hasHeader } from "./headers.js";
import {
  normalizeResponse,
  serializeResponseBody,
  withDefaultContentType,
} from "./response-normalizer.js";

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

export type HttpIngressErrorCode =
  | "MALFORMED_JSON"
  | "JSON_TOO_DEEP"
  | "MALFORMED_MULTIPART"
  | "PAYLOAD_TOO_LARGE";

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
 * A repeated key resolves to its LAST value; every adapter follows this rule.
 */
export function parseNodeQuery(url: URL): Record<string, string> {
  // Own-property definition for the same reason as parseNodeHeaders, and it
  // matches how the fetch interceptor builds its query record.
  return Object.fromEntries(url.searchParams);
}

/** Default body size limit: 10 MB */
export const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;
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

/**
 * Deepest JSON nesting a request body may carry. A body nested far deeper
 * parses fine but cannot be serialized back (JSON.stringify overflows the
 * stack), so a handler that stores it poisons every later response that
 * includes it. Rejecting it at ingress keeps that from ever happening.
 */
const MAX_JSON_BODY_DEPTH = 256;

function baseMediaTypeOf(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/** Whether a parsed JSON value nests deeper than `maxDepth` containers. */
function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next.value !== "object" || next.value === null) continue;
    const depth = next.depth + 1;
    if (depth > maxDepth) return true;
    for (const child of Object.values(next.value)) {
      pending.push({ value: child, depth });
    }
  }
  return false;
}

function parseJsonBody(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpIngressError(
      400,
      "MALFORMED_JSON",
      "Malformed JSON request body",
    );
  }
  if (exceedsJsonDepth(parsed, MAX_JSON_BODY_DEPTH)) {
    throw new HttpIngressError(
      400,
      "JSON_TOO_DEEP",
      `JSON request body nests deeper than ${MAX_JSON_BODY_DEPTH} levels`,
    );
  }
  return parsed;
}

async function parseMultipartBody(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<FormData> {
  try {
    return await new Response(bytes, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new HttpIngressError(
      400,
      "MALFORMED_MULTIPART",
      "Malformed multipart request body",
    );
  }
}

/**
 * Turn the collected bytes into the body shape the fetch interceptor gives
 * the same request, so `mock.listen()`, the CLI and `mock.intercept()` hand a
 * handler the same value:
 *
 * - `application/json` and `+json`: the parsed value
 * - `application/x-www-form-urlencoded`: a flat object, last duplicate wins
 * - `text/*`: a UTF-8 string
 * - `multipart/*`: `FormData`
 * - anything else, including no content type: an `ArrayBuffer`
 */
function decodeRequestBody(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): unknown {
  const mediaType = baseMediaTypeOf(contentType);
  if (isJsonMediaType(mediaType)) {
    return parseJsonBody(new TextDecoder().decode(bytes));
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    return Object.fromEntries(
      new URLSearchParams(new TextDecoder().decode(bytes)),
    );
  }
  if (mediaType.startsWith("text/")) {
    return new TextDecoder().decode(bytes);
  }
  if (mediaType.startsWith("multipart/")) {
    return parseMultipartBody(bytes, contentType);
  }
  return bytes.buffer;
}

/** Copy the chunks into one buffer that the body exclusively owns. */
function concatChunks(
  chunks: readonly Uint8Array[],
  totalSize: number,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Collect and parse the request body from a Node.js IncomingMessage.
 * The body takes the shape the fetch interceptor gives it: parsed JSON for
 * application/json and +json, an object for urlencoded forms, a string for
 * text/*, FormData for multipart/*, and an ArrayBuffer for anything else.
 * Returns undefined for empty bodies.
 * @param req - Node.js IncomingMessage
 * @param headers - Parsed request headers; content-length and content-type
 *   are looked up case-insensitively
 * @param maxBodySize - Maximum body size in bytes (default: 10 MB)
 */
export function collectBody(
  req: BodyReadable,
  headers: Record<string, string>,
  maxBodySize = DEFAULT_MAX_BODY_SIZE,
): Promise<unknown> {
  const contentLength = getHeader(headers, "content-length");
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

      if (totalSize === 0) {
        resolveOnce(undefined);
        return;
      }
      const bytes = concatChunks(chunks, totalSize);
      try {
        // A multipart body decodes asynchronously. Resolving with that promise
        // settles collection now, so the `close` Node emits right after `end`
        // cannot pre-empt the parse as an abort.
        resolveOnce(
          decodeRequestBody(bytes, getHeader(headers, "content-type") ?? ""),
        );
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
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

/** Merge `extraHeaders` over `headers`; an extra header replaces any case variant. */
function mergeExtraHeaders(
  headers: Record<string, string>,
  extraHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...headers };
  if (!extraHeaders) return merged;
  const names = new Map(
    Object.keys(merged).map((name) => [name.toLowerCase(), name]),
  );
  for (const [name, value] of Object.entries(extraHeaders)) {
    const previousName = names.get(name.toLowerCase());
    if (previousName !== undefined) delete merged[previousName];
    merged[name] = value;
    names.set(name.toLowerCase(), name);
  }
  return merged;
}

function prepareWriteableResponse(
  response: Schmock.Response,
  extraHeaders?: Record<string, string>,
): { headers: Record<string, string>; body: Uint8Array | undefined } {
  // Extra headers first, so an extra content type counts before a default one
  // is inferred; the length is declared last, from the serialized bytes.
  const typed = withDefaultContentType({
    ...response,
    headers: mergeExtraHeaders(response.headers, extraHeaders),
  });
  const responseHeaders = typed.headers;
  const body = serializeResponseBody(typed);

  // Declare the length up front: writeHead() commits the header block before
  // end() sees the body, so without it Node frames every response as chunked,
  // unlike Express's res.end(buffer).
  if (body !== undefined && !hasHeader(responseHeaders, "content-length")) {
    responseHeaders["content-length"] = String(body.byteLength);
  }

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

// ===== Node request bridge =====

/** The parts of a Node.js IncomingMessage `serveNodeRequest` uses. */
type NodeRequest = RequestWithHeaders &
  BodyReadable &
  RejectedRequestReadable & {
    readonly headers: { readonly host?: string };
    readonly method?: string;
    readonly url?: string;
    once(event: "aborted", listener: () => void): unknown;
    off(event: "aborted", listener: () => void): unknown;
  };

/** The parts of a Node.js ServerResponse `serveNodeRequest` uses. */
type NodeResponse = RejectedResponseWritable & {
  readonly headersSent: boolean;
  shouldKeepAlive: boolean;
  destroy(error?: Error): unknown;
  off(event: "close", listener: () => void): unknown;
};

/** What `serveNodeRequest` tells `extraHeaders` about the response it writes. */
export interface ServeNodeResponseContext {
  /**
   * `true` for an error answer `serveNodeRequest` writes itself, `false` for
   * the response `handle` produced.
   */
  readonly isError: boolean;
  /** The request pathname, or `undefined` when the request did not parse. */
  readonly path: string | undefined;
}

/**
 * How `serveNodeRequest` answers a failed request. The body is the JSON
 * `{ "error": message, "code": code }`.
 */
export interface HttpErrorReply {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Headers the answer carries besides its content type (a 405's `allow`). */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ServeNodeRequestOptions {
  /** Routes the parsed request: `mock.handle`, or a request admission's `handle`. */
  readonly handle: Schmock.MockRequestHandler;
  /**
   * Largest request body accepted, in bytes. A larger one is answered 413 and
   * the connection is closed.
   */
  readonly maxBodySize: number;
  /**
   * Headers written over every response for this request (CORS headers, for
   * example), replacing any case variant of the same name.
   */
  readonly extraHeaders?: (
    context: ServeNodeResponseContext,
  ) => Record<string, string> | undefined;
  /**
   * Choose the answer for an error. Return `undefined` for the default: 400
   * for a request that does not parse, 405 with `allow` for a method Schmock
   * does not route, the ingress status for a body error (400, or 413 over
   * `maxBodySize`), and 500 `SERVER_ERROR` with the error's message otherwise.
   */
  readonly classifyError?: (error: unknown) => HttpErrorReply | undefined;
}

/** Placeholder origin for origin-form request targets; never contacted. */
const REQUEST_TARGET_ORIGIN = "http://schmock.invalid";
const ALLOWED_METHODS_HEADER = HTTP_METHODS.join(", ");

/**
 * A client error `serveNodeRequest` answers before the mock sees the request:
 * 400 for a request it cannot parse, 405 for a verb Schmock does not route.
 */
class NodeRequestError extends SchmockError {
  constructor(
    readonly status: 400 | 405,
    code: "BAD_REQUEST" | "METHOD_NOT_ALLOWED",
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message, code);
    this.name = "NodeRequestError";
  }
}

/** Whether a Host header value parses as an authority. */
function isParseableHost(host: string): boolean {
  try {
    return new URL(`http://${host}`).host !== "";
  } catch {
    return false;
  }
}

/**
 * Parse a Node request target into a URL without letting it pick the host.
 *
 * Resolving an origin-form target (`/path?q`) against a base reads a leading
 * `//` as a protocol-relative URL: `//users` would become host "users" with
 * path "/" and be served by `GET /`. Appending it to a fixed origin keeps the
 * whole target as the path. The asterisk-form (`OPTIONS *`) keeps the `/*`
 * path it always resolved to; any other target must be an absolute URL.
 */
function parseRequestTarget(target: string): URL {
  try {
    if (target.startsWith("/"))
      return new URL(`${REQUEST_TARGET_ORIGIN}${target}`);
    if (target === "*") return new URL(`${REQUEST_TARGET_ORIGIN}/*`);
    return new URL(target);
  } catch {
    throw new NodeRequestError(400, "BAD_REQUEST", "Malformed request target");
  }
}

/**
 * Check the Host header, then parse the target. The Host must be present and
 * parse as an authority, but only the target's path and query are used.
 */
function parseNodeRequestUrl(req: NodeRequest): URL {
  const host = req.headers.host;
  if (!host) {
    throw new NodeRequestError(400, "BAD_REQUEST", "Missing Host header");
  }
  if (!isParseableHost(host)) {
    throw new NodeRequestError(400, "BAD_REQUEST", "Malformed Host header");
  }
  return parseRequestTarget(req.url ?? "/");
}

function parseNodeRequestMethod(
  method: string | undefined,
): Schmock.HttpMethod {
  const upper = (method ?? "GET").toUpperCase();
  if (!isHttpMethod(upper)) {
    throw new NodeRequestError(
      405,
      "METHOD_NOT_ALLOWED",
      `Unsupported HTTP method: ${upper}`,
      { allow: ALLOWED_METHODS_HEADER },
    );
  }
  return upper;
}

function defaultErrorReply(error: unknown): HttpErrorReply {
  if (error instanceof NodeRequestError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      headers: error.headers,
    };
  }
  if (error instanceof HttpIngressError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: "SERVER_ERROR",
    message: error instanceof Error ? error.message : "Internal Server Error",
  };
}

/**
 * Answer a request that failed. TOTAL: an answer that cannot be written
 * destroys the socket instead, so the client is never left waiting and no
 * error escapes as an unhandled rejection.
 */
function answerFailedRequest(input: {
  req: NodeRequest;
  res: NodeResponse;
  error: unknown;
  method: Schmock.HttpMethod;
  path: string | undefined;
  options: ServeNodeRequestOptions;
}): void {
  const { req, res, error, method, path, options } = input;
  try {
    if (res.headersSent || res.writableEnded) {
      // Bytes are already on the wire, so no answer can replace them.
      if (!res.writableEnded) res.end();
      return;
    }
    const reply = options.classifyError?.(error) ?? defaultErrorReply(error);
    // An ingress failure leaves the request body unread or unusable, so the
    // connection cannot carry another request. `shouldKeepAlive = false`
    // alone emits no Connection header when writeHead is given a header
    // object, so the close is announced explicitly, on the transport's own
    // header channel: normalizeResponse strips hop-by-hop headers from
    // everything a route produces.
    const closeConnection =
      error instanceof HttpIngressError || reply.status === 413;
    if (closeConnection) res.shouldKeepAlive = false;
    const response = normalizeResponse(
      {
        status: reply.status,
        body: { error: reply.message, code: reply.code },
        headers: { "content-type": "application/json", ...reply.headers },
      },
      method,
    );
    const extraHeaders: Record<string, string> = {
      ...options.extraHeaders?.({ isError: true, path }),
      ...(closeConnection ? { connection: "close" } : {}),
    };
    if (reply.status === 413) {
      writeRejectedSchmockResponse(req, res, response, extraHeaders);
    } else {
      writeSchmockResponse(res, response, extraHeaders);
    }
  } catch {
    res.destroy();
  }
}

/**
 * Serve one Node.js request through a mock: the bridge `mock.listen()` runs,
 * usable with any `http.createServer` callback.
 *
 * It rejects a request without a parseable Host header or target (400) and a
 * method Schmock does not route (405, with `allow`), then parses headers,
 * query and body (400 for a malformed JSON or multipart body, 413 over
 * `maxBodySize`) and calls `handle` with an abort signal that fires when the
 * client goes away. Every failure is answered as `{ error, code }` JSON; an
 * ingress failure also closes the connection, and a 413 is flushed while the
 * client may still be uploading so it can read it.
 *
 * The returned promise never rejects. It settles once the response has been
 * handed to Node, which is when per-request resources (a request admission)
 * can be released.
 */
export async function serveNodeRequest(
  req: NodeRequest,
  res: NodeResponse,
  options: ServeNodeRequestOptions,
): Promise<void> {
  const abortController = new AbortController();
  const abortRequest = () => abortController.abort();
  req.once("aborted", abortRequest);
  res.once("close", abortRequest);
  // The method an error answer is shaped for until the verb parses: a HEAD
  // request keeps its bodyless answer even when it is rejected.
  let method: Schmock.HttpMethod =
    req.method?.toUpperCase() === "HEAD" ? "HEAD" : "GET";
  let path: string | undefined;
  try {
    // Client errors are answered in this order: the target, then the verb.
    const url = parseNodeRequestUrl(req);
    path = url.pathname;
    method = parseNodeRequestMethod(req.method);
    const headers = parseNodeHeaders(req);
    const query = parseNodeQuery(url);
    const body = await collectBody(req, headers, options.maxBodySize);
    const response = await options.handle(method, path, {
      headers,
      body,
      query,
      signal: abortController.signal,
    });
    writeSchmockResponse(
      res,
      response,
      options.extraHeaders?.({ isError: false, path }),
    );
  } catch (error) {
    answerFailedRequest({ req, res, error, method, path, options });
  } finally {
    req.off("aborted", abortRequest);
    res.off("close", abortRequest);
  }
}
