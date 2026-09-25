import type * as Schmock from "@schmock/core";
import {
  buildFormattedErrorResponse,
  getResponseException,
  isRouteNotFound,
  normalizeResponse,
  parseNodeQuery,
  SchmockError,
  serializeResponseBody,
  toHttpMethod,
  withDefaultContentType,
} from "@schmock/core";
import {
  acquireRequestAdmission,
  awaitWithAbort,
  type MockRequestHandler,
  type RequestAdmission,
} from "@schmock/core/adapter";
import type { NextFunction, Request, RequestHandler, Response } from "express";

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
   * Custom query transformation.
   *
   * Without it, the adapter ignores `req.query` and re-reads the query string
   * of `req.url` (the URL `req.path` comes from, so a rewrite by earlier
   * middleware moves path and query together) with the CLI's parser: keys
   * stay literal (`filter[name]`, `sort[]`), a repeated key resolves to its
   * last value, and a `req.query` that earlier middleware assigned or
   * redefined is ignored.
   *
   * Supplying `transformQuery` switches that default off: it receives
   * `req.query` as Express parsed it (qs-nested values under the "extended"
   * parser, plus any change earlier middleware made), and its return value
   * is the query the mock sees.
   * @param query - `req.query` as Express, or earlier middleware, left it
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
  const response = normalizeResponse(
    withDefaultContentType(schmockResponse),
    method,
  );
  res.status(response.status);
  // Node's raw setter, not Express's res.set(): the latter appends a
  // mime-types charset to content-type, rewriting a header the route set
  // explicitly (the CLI and the fetch interceptor send it verbatim).
  for (const [name, value] of Object.entries(response.headers)) {
    res.setHeader(name, value);
  }
  const body = serializeResponseBody(response);
  res.end(body === undefined ? undefined : Buffer.from(body));
}

interface FormattedErrorSend {
  errorFormatter: (error: Error, req: Request) => unknown;
  error: Error;
  req: Request;
  res: Response;
  method: Schmock.HttpMethod;
  /**
   * The (post-hook) headers of the response being replaced, so metadata such
   * as `retry-after` is not lost, matching the Angular adapter.
   */
  inheritedHeaders?: Record<string, string>;
}

/**
 * Send the errorFormatter's result as a 500. Core's
 * `buildFormattedErrorResponse` runs the formatter exactly once and owns the
 * fallbacks (untransportable inherited headers, a throwing formatter, an
 * unserializable body), so what is left here is the write. That write is
 * guarded too: a throw escaping into the middleware's catch would run the
 * formatter a second time and then reach Express's default handler, which
 * leaks an HTML stack trace with absolute source paths.
 */
function sendFormattedError(send: FormattedErrorSend): void {
  const { errorFormatter, req, res, method } = send;
  const response = buildFormattedErrorResponse({
    formatter: (error) => errorFormatter(error, req),
    error: send.error,
    inheritedHeaders: send.inheritedHeaders,
    method,
  });
  try {
    schmockToExpressResponse(response, method, res);
  } catch {
    if (!res.headersSent) {
      res.status(500);
      res.setHeader("content-type", "application/json");
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
 * Flatten one parsed query value into `result`, restoring the bracket keys a
 * nested parser (qs "extended") folded away: `{filter: {name: "rex"}}` becomes
 * `filter[name]=rex`. A repeated key keeps its last value, as in the CLI.
 */
function flattenQueryValue(
  result: Record<string, string>,
  key: string,
  value: unknown,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) result[key] = "";
    for (const item of value) flattenQueryValue(result, key, item);
  } else if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) {
      flattenQueryValue(result, `${key}[${childKey}]`, child);
    }
  } else if (value !== null && value !== undefined) {
    result[key] = String(value);
  }
}

/**
 * Fallback query transformer, used only when the request carries no URL to
 * re-read (hand-built request objects).
 */
function defaultTransformQuery(
  query: Request["query"],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    flattenQueryValue(result, key, value);
  }
  return result;
}

/**
 * Default query: re-read the raw URL with the CLI's own parser, so the mock
 * sees the same record whatever `query parser` the Express app configures.
 * `req.query` is shaped by that setting: qs "extended" (Express 4's default)
 * nests `filter[name]` and strips `sort[]` down to `sort`.
 *
 * It reads `req.url`, not `req.originalUrl`: `req.path` is derived from
 * `req.url`, so a middleware that rewrites the URL moves path and query
 * together. A router mount point strips only the path prefix, never the query
 * string. A `req.query` that middleware replaced is ignored; `transformQuery`
 * is the way to honour it.
 */
function defaultQuery(req: Request): Record<string, string> {
  const rawUrl: unknown = req.url ?? req.originalUrl;
  if (typeof rawUrl === "string") {
    try {
      return parseNodeQuery(new URL(rawUrl, "http://localhost"));
    } catch {
      // An unparseable URL falls back to Express's own parse.
    }
  }
  return defaultTransformQuery(req.query ?? {});
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
    transformQuery,
    beforeRequest,
    beforeResponse,
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    const abortController = new AbortController();
    const abortRequest = () => abortController.abort();
    const abortPrematureResponse = () => {
      if (!res.writableFinished) abortController.abort();
    };
    const observesRequestAbort = typeof req.once === "function";
    const observesResponseClose = typeof res.once === "function";
    if (observesRequestAbort) req.once("aborted", abortRequest);
    if (observesResponseClose) res.once("close", abortPrematureResponse);
    // Admission acquisition and method sniffing run INSIDE the try: a mock
    // with a malformed request-admission hook, or a request without a usable
    // `method`, would otherwise reject the returned promise (unhandled in
    // Express 4) and skip the finally that releases admission and unregisters
    // the abort listeners.
    let admission: RequestAdmission | undefined;
    let responseMethod: Schmock.HttpMethod = "GET";
    try {
      admission = acquireRequestAdmission(mock);
      const handleRequest: MockRequestHandler =
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
        query: transformQuery ? transformQuery(req.query) : defaultQuery(req),
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
      // a backstop on the abort wiring: a normal response close does not abort
      // pending hook work, while a premature close does. The `finally` below
      // still releases admission and unregisters the abort listeners.
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
        sendFormattedError({
          errorFormatter,
          error: internalError,
          req,
          res,
          method: requestData.method,
          inheritedHeaders: schmockResponse.headers,
        });
        return;
      }

      // Convert and send Schmock response
      schmockToExpressResponse(schmockResponse, requestData.method, res);
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (res.headersSent) {
        // A formatter or adapter error body cannot safely replace bytes that
        // are already on the wire. Express's error chain owns that response
        // when enabled; otherwise end an open response without another body.
        if (passErrorsToNext) {
          next(error);
        } else if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      if (res.writableEnded) return;
      // Handle errors based on configuration
      if (errorFormatter) {
        // Fires for any Error from the handler/pipeline, not just
        // SchmockError — matches the Angular adapter's behavior.
        const err = error instanceof Error ? error : new Error(String(error));
        sendFormattedError({
          errorFormatter,
          error: err,
          req,
          res,
          method: responseMethod,
        });
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
      if (observesResponseClose) res.off("close", abortPrematureResponse);
      admission?.release();
    }
  };
}
