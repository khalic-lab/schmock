import type * as Schmock from "@schmock/core";
import {
  getResponseException,
  isBinaryBody,
  isRouteNotFound,
  normalizeResponse,
  SchmockError,
  serializeResponseBody,
  toHttpMethod,
} from "@schmock/core";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const REQUEST_ADMISSION = Symbol.for("@schmock/core.request-admission");

type CoreRequestHandler = (
  method: Schmock.HttpMethod,
  path: string,
  options?: Schmock.RequestOptions,
) => Promise<Schmock.Response>;

interface RequestAdmission {
  handle: CoreRequestHandler;
  release(): void;
}

function isRequestAdmission(value: unknown): value is RequestAdmission {
  return (
    typeof value === "object" &&
    value !== null &&
    "handle" in value &&
    typeof value.handle === "function" &&
    "release" in value &&
    typeof value.release === "function"
  );
}

function acquireRequestAdmission(
  mock: Schmock.CallableMockInstance,
): RequestAdmission | undefined {
  const admit: unknown = Reflect.get(mock, REQUEST_ADMISSION);
  if (typeof admit !== "function") return undefined;

  const admission: unknown = Reflect.apply(admit, mock, []);
  if (!isRequestAdmission(admission)) {
    throw new Error("Schmock returned an invalid request admission");
  }
  return admission;
}

/**
 * Formatted error bodies are always JSON, so the response's own content-type
 * must be replaced rather than inherited. Every case variant is dropped
 * first: leaving a `Content-Type` alongside the forced lowercase key makes
 * the pair transport-invalid and the normalizer rejects it.
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

function abortReason(signal: AbortSignal): unknown {
  if ("reason" in signal && signal.reason !== undefined) return signal.reason;
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function awaitWithAbort<T>(
  value: T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * Configuration options for Express adapter
 */
export interface ExpressAdapterOptions {
  /**
   * Custom error formatter
   * @param error - The error that occurred
   * @param req - Express request
   * @returns Custom error response
   */
  errorFormatter?: (error: Error, req: Request) => unknown;

  /**
   * Whether to pass non-Schmock errors to Express error handler
   * @default true
   */
  passErrorsToNext?: boolean;

  /**
   * Custom header transformation
   * @param headers - Express headers
   * @returns Transformed headers for Schmock
   */
  transformHeaders?: (headers: Request["headers"]) => Record<string, string>;

  /**
   * Custom query transformation
   * @param query - Express query
   * @returns Transformed query for Schmock
   */
  transformQuery?: (query: Request["query"]) => Record<string, string>;

  /**
   * Request interceptor - called before handling request
   * @param req - Express request
   * @param res - Express response
   * @returns Modified request data or void
   */
  beforeRequest?: (
    req: Request,
    res: Response,
  ) =>
    | Schmock.AdapterRequestOverride
    | undefined
    | Promise<Schmock.AdapterRequestOverride | undefined>;

  /**
   * Response interceptor - called before sending response
   * @param schmockResponse - Response from Schmock
   * @param req - Express request
   * @param res - Express response
   * @returns Modified response or void
   */
  beforeResponse?: (
    schmockResponse: Schmock.Response,
    req: Request,
    res: Response,
  ) => Schmock.Response | undefined | Promise<Schmock.Response | undefined>;
}

/**
 * Convert Schmock response to Express response
 */
function schmockToExpressResponse(
  schmockResponse: Schmock.Response,
  method: Schmock.HttpMethod,
  res: Response,
): void {
  const headers = { ...schmockResponse.headers };
  const hasContentType = Object.keys(headers).some(
    (name) => name.toLowerCase() === "content-type",
  );
  if (
    !hasContentType &&
    schmockResponse.body !== null &&
    schmockResponse.body !== undefined
  ) {
    if (isBinaryBody(schmockResponse.body)) {
      headers["content-type"] = "application/octet-stream";
    } else if (typeof schmockResponse.body !== "string") {
      headers["content-type"] = "application/json";
    }
  }

  const response = normalizeResponse({ ...schmockResponse, headers }, method);
  res.status(response.status);
  for (const [name, value] of Object.entries(response.headers)) {
    res.set(name, value);
  }
  const body = serializeResponseBody(response);
  res.end(body === undefined ? undefined : Buffer.from(body));
}

/**
 * Invoke the errorFormatter and send its result, falling back to a minimal
 * safe body when the formatter throws or the response normalizer rejects its
 * body (for example a formatted value carrying an Error instance). The
 * formatter runs inside the guard so it fires exactly once; an unguarded
 * throw would re-enter it and then escape to Express's default handler,
 * which leaks an HTML stack trace with absolute source paths.
 *
 * `responseHeaders` carries the (post-hook) headers of the response being
 * replaced so metadata such as `retry-after` is not lost, matching the
 * Angular adapter. There are two distinct fallbacks below. When the headers
 * themselves are untransportable (a non-string value, a control character, a
 * case-duplicate name) the send is retried once with the fixed JSON header
 * set, because the formatter's body is still good and losing it would
 * silently change the user's error contract. Only a failure of the formatter
 * or of its body reaches the minimal fallback, which deliberately inherits
 * nothing: once the formatter has failed, replaying its response's headers is
 * not obviously safe.
 */
function sendFormattedError(
  errorFormatter: (error: Error, req: Request) => unknown,
  error: Error,
  req: Request,
  method: Schmock.HttpMethod,
  res: Response,
  responseHeaders: Record<string, string> = {},
): void {
  try {
    const formatted = errorFormatter(error, req);
    try {
      schmockToExpressResponse(
        {
          status: 500,
          body: formatted,
          headers: withJsonContentType(responseHeaders),
        },
        method,
        res,
      );
    } catch {
      // The inherited post-hook headers were not transportable. The
      // normalizer validates them before anything is written, so nothing is
      // on the wire yet: keep the formatter's body and drop the headers
      // rather than degrading the error contract to the minimal fallback.
      // `formatted` is reused, so the formatter still fires exactly once.
      schmockToExpressResponse(
        {
          status: 500,
          body: formatted,
          headers: { "content-type": "application/json" },
        },
        method,
        res,
      );
    }
  } catch {
    if (!res.headersSent) {
      res.status(500);
      res.set("content-type", "application/json");
    }
    if (!res.writableEnded) {
      // Once headers are on the wire, appending the fallback JSON would
      // concatenate it onto whatever bytes were already written.
      res.end(
        res.headersSent
          ? undefined
          : Buffer.from(
              JSON.stringify({
                error: "Internal Server Error",
                code: "INTERNAL_ERROR",
              }),
            ),
      );
    }
  }
}

/**
 * Default header transformer
 */
function defaultTransformHeaders(
  headers: Request["headers"],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
  );
}

/**
 * Default query transformer
 */
function defaultTransformQuery(
  query: Request["query"],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value[0] ? String(value[0]) : "";
    } else if (value != null) {
      result[key] = String(value);
    }
  }
  return result;
}

/**
 * Convert a Schmock mock instance to Express middleware
 */
export function toExpress(
  mock: Schmock.CallableMockInstance,
  options: ExpressAdapterOptions = {},
): RequestHandler {
  const {
    errorFormatter,
    passErrorsToNext = true,
    transformHeaders = defaultTransformHeaders,
    transformQuery = defaultTransformQuery,
    beforeRequest,
    beforeResponse,
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    const abortController = new AbortController();
    const abortRequest = () => abortController.abort();
    const observesRequestAbort = typeof req.once === "function";
    const observesResponseClose = typeof res.once === "function";
    if (observesRequestAbort) req.once("aborted", abortRequest);
    if (observesResponseClose) res.once("close", abortRequest);
    // Admission acquisition and method sniffing run INSIDE the try: a mock
    // with a malformed request-admission hook, or a request without a usable
    // `method`, would otherwise reject the returned promise (unhandled in
    // Express 4) and skip the finally that releases admission and unregisters
    // the abort listeners.
    let admission: RequestAdmission | undefined;
    let responseMethod: Schmock.HttpMethod = "GET";
    try {
      admission = acquireRequestAdmission(mock);
      const handleRequest: CoreRequestHandler =
        admission?.handle ??
        ((admittedMethod, admittedPath, admittedOptions) =>
          mock.handle(admittedMethod, admittedPath, admittedOptions));
      responseMethod = req.method.toUpperCase() === "HEAD" ? "HEAD" : "GET";

      // Skip non-standard HTTP methods (e.g. WebDAV PROPFIND, LOCK)
      let method: ReturnType<typeof toHttpMethod>;
      try {
        method = toHttpMethod(req.method);
        responseMethod = method;
      } catch {
        return next();
      }

      // Run request interceptor if provided
      let requestData = {
        method,
        path: req.path,
        headers: transformHeaders(req.headers),
        body: req.body,
        query: transformQuery(req.query),
      };

      if (beforeRequest) {
        const intercepted = await awaitWithAbort(
          beforeRequest(req, res),
          abortController.signal,
        );
        if (intercepted) {
          requestData = {
            ...requestData,
            ...intercepted,
            method: toHttpMethod(intercepted.method || requestData.method),
          };
          responseMethod = requestData.method;
        }
      }

      // A hook that sent — or began sending — the response owns it: stop here
      // rather than running the mock against a response that is already on the
      // wire. `next()` is deliberately NOT called: handing a live response to
      // the rest of the stack is a second bug. This is an explicit check, not
      // a backstop on the abort wiring: `res.once('close', ...)` is registered
      // only when `res.once` is a function, so response doubles and any
      // non-EventEmitter response get no absorption at all, and even a real
      // response only absorbs a FULLY sent one, as a nextTick-vs-microtask
      // race. The `finally` below still releases admission and unregisters the
      // abort listeners.
      if (res.headersSent || res.writableEnded) return;

      // Handle request with Schmock
      let schmockResponse = await awaitWithAbort(
        handleRequest(requestData.method, requestData.path, {
          headers: requestData.headers,
          body: requestData.body,
          query: requestData.query,
          signal: abortController.signal,
        }),
        abortController.signal,
      );

      // Exception provenance is carried on the response as a non-enumerable
      // symbol, so it must be read BEFORE beforeResponse runs: the documented
      // `{...response}` hook pattern copies only own enumerable properties and
      // would otherwise strip the mark, silently bypassing errorFormatter.
      const internalError = getResponseException(schmockResponse);

      // Detect ROUTE_NOT_FOUND responses and pass to next middleware
      if (isRouteNotFound(schmockResponse)) {
        next();
        return;
      }

      // Run response interceptor if provided
      if (beforeResponse) {
        const intercepted = await awaitWithAbort(
          beforeResponse(schmockResponse, req, res),
          abortController.signal,
        );
        if (intercepted) {
          schmockResponse = intercepted;
        }
      }

      // Same ownership rule after the response hook, and it must sit BEFORE
      // the errorFormatter gate: a partially written response plus a
      // core-marked exception would otherwise send a formatted body into a
      // live socket.
      if (res.headersSent || res.writableEnded) return;

      // Only core-marked exceptions reach errorFormatter; a user-defined 500
      // with an error-shaped body remains an ordinary domain response. The
      // POST-hook status gates the replacement (matching Angular): a
      // beforeResponse that rewrites an exception into a 503 or a 200 is
      // honoured instead of being forced back to a formatted 500.
      if (errorFormatter && internalError && schmockResponse.status === 500) {
        sendFormattedError(
          errorFormatter,
          internalError,
          req,
          requestData.method,
          res,
          schmockResponse.headers,
        );
        return;
      }

      // Convert and send Schmock response
      schmockToExpressResponse(schmockResponse, requestData.method, res);
    } catch (error) {
      if (abortController.signal.aborted) return;
      // Same ownership rule as the two in-band exits above: a hook that sent —
      // or began sending — the response still owns it after it throws. Without
      // this, `errorFormatter` runs against a committed socket and its
      // last-resort fallback ends the owner's stream on its behalf (truncating
      // a partially written body), or `next(error)` hands a live response to
      // the rest of the stack. Nothing the middleware itself sends reaches
      // here with an unwritten body: `schmockToExpressResponse` and
      // `sendFormattedError` both guard internally, so suppressing the error
      // path for an already-committed response loses no recoverable handling.
      if (res.headersSent || res.writableEnded) return;
      // Handle errors based on configuration
      if (errorFormatter) {
        // Fires for any Error from the handler/pipeline, not just
        // SchmockError — matches the Angular adapter's behavior.
        const err = error instanceof Error ? error : new Error(String(error));
        sendFormattedError(errorFormatter, err, req, responseMethod, res);
      } else if (passErrorsToNext) {
        next(error);
      } else {
        schmockToExpressResponse(
          {
            status: 500,
            body: {
              error:
                error instanceof Error
                  ? error.message
                  : "Internal Server Error",
              code:
                error instanceof SchmockError ? error.code : "INTERNAL_ERROR",
            },
            headers: { "content-type": "application/json" },
          },
          responseMethod,
          res,
        );
      }
    } finally {
      if (observesRequestAbort) req.off("aborted", abortRequest);
      if (observesResponseClose) res.off("close", abortRequest);
      admission?.release();
    }
  };
}
