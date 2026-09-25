import type {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from "@angular/common/http";
import {
  HTTP_INTERCEPTORS,
  HttpErrorResponse,
  HttpHeaders,
  HttpResponse,
} from "@angular/common/http";
import { Injectable } from "@angular/core";
import type * as Schmock from "@schmock/core";
import {
  buildFormattedErrorResponse,
  getHeader,
  getResponseException,
  isHttpMethod,
  isRouteNotFound,
  matchPathPrefix,
  normalizeResponse,
  parsePathPrefix,
  SchmockError,
  schmock,
  serializeResponseBody,
} from "@schmock/core";
import { Observable, type Subscriber } from "rxjs";

type AngularResponseType = HttpRequest<unknown>["responseType"];

/**
 * Fold request header names to lowercase. Every other adapter delivers
 * lowercase keys (the fetch interceptor lowercases explicitly, Express
 * receives Node's already-folded names), so handlers can always read
 * `headers.authorization` regardless of how the caller spelled it.
 */
function lowercaseHeaderKeys(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    result[name.toLowerCase()] = value;
  }
  return result;
}

/** Copy bytes into a standalone ArrayBuffer with no trailing slack. */
function toArrayBufferCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * The value Angular delivers when a response carries no wire bytes.
 * HttpXhrBackend nulls the body only at 204 (`HTTP_STATUS_CODE_NO_CONTENT`);
 * at every other status an empty payload still surfaces as `''`, an empty
 * `ArrayBuffer` or an empty `Blob`, so a subscriber typed
 * `Observable<string>` never receives null and `res.trim()` keeps working.
 */
function emptyResponseBody(
  status: number,
  headers: Record<string, string>,
  responseType: AngularResponseType,
): unknown {
  if (status === 204) return null;
  switch (responseType) {
    case "text":
      return "";
    case "arraybuffer":
      return new ArrayBuffer(0);
    case "blob":
      // The package builds for the browser but its tests run under Bun, so
      // fall back to the ArrayBuffer where Blob is unavailable.
      return typeof Blob === "function"
        ? new Blob([], { type: getHeader(headers, "content-type") ?? "" })
        : new ArrayBuffer(0);
    default:
      return null;
  }
}

/**
 * Shape the emitted body to the request's `responseType`. Angular's own
 * HttpXhrBackend promises a `string` for 'text', an `ArrayBuffer` for
 * 'arraybuffer' and a `Blob` for 'blob'; handing back a plain object breaks
 * that contract. 'json' is typed `any`/`T`, so a string body legitimately
 * satisfies it and is deliberately left untouched — parsing here would turn
 * a route returning `'true'` into the boolean `true`.
 */
function applyResponseType(
  body: unknown,
  status: number,
  headers: Record<string, string>,
  responseType: AngularResponseType,
): unknown {
  if (responseType === "json") return body;
  // The bodyless cases (HEAD, 204, 205, 304, or an explicitly null body).
  // `null` must not fall through to the serializer, which would encode it as
  // the literal string "null" for a body that never reaches the wire.
  if (body === undefined || body === null) {
    return emptyResponseBody(status, headers, responseType);
  }

  let bytes: Uint8Array | undefined;
  try {
    bytes = serializeResponseBody({ status, body, headers });
  } catch {
    // A formatter output the serializer rejects must not break the emission.
    return body;
  }
  // A body the status forbids (204/205/304) still produced no bytes.
  if (bytes === undefined) {
    return emptyResponseBody(status, headers, responseType);
  }

  switch (responseType) {
    case "text":
      return typeof body === "string" ? body : new TextDecoder().decode(bytes);
    case "arraybuffer":
      return toArrayBufferCopy(bytes);
    case "blob":
      // The package builds for the browser but its tests run under Bun, so
      // fall back to the ArrayBuffer where Blob is unavailable.
      return typeof Blob === "function"
        ? new Blob([toArrayBufferCopy(bytes)], {
            type: getHeader(headers, "content-type") ?? "",
          })
        : toArrayBufferCopy(bytes);
    default:
      return body;
  }
}

function toSupportedHttpMethod(method: string): Schmock.HttpMethod | undefined {
  const upper = method.toUpperCase();
  if (isHttpMethod(upper)) {
    return upper;
  }
  return undefined;
}

/**
 * Canonical reason phrases from the IANA HTTP status code registry.
 *
 * The phrasing follows Node's `http.STATUS_CODES`, which is what an app
 * talking to a real backend through the same code sees. This is a static
 * table on purpose: the package builds for the browser, so `node:http` is not
 * available to it — its tests merely happen to run under Bun.
 */
const statusTexts: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};

/**
 * Get HTTP status text for a status code.
 *
 * A status outside the registry falls back the way Angular's own classes do:
 * `HttpResponse` defaults to "OK" and `HttpErrorResponse` to "Unknown Error",
 * and the adapter emits on exactly those channels — 2xx as `HttpResponse`,
 * everything else as `HttpErrorResponse` — so the fallback follows the status
 * class.
 */
function getStatusText(status: number): string {
  const text = statusTexts[status];
  if (text !== undefined) return text;
  return status >= 200 && status < 300 ? "OK" : "Unknown Error";
}

/**
 * Configuration options for Angular adapter
 */
export interface AngularAdapterOptions {
  /**
   * Base URL to intercept (e.g., '/api')
   * If not provided, intercepts all requests
   */
  baseUrl?: string;

  /**
   * Whether to pass through requests that don't match any route
   * @default true
   */
  passthrough?: boolean;

  /**
   * Custom error formatter
   * @param error - The error that occurred
   * @param request - Angular HTTP request
   * @returns Custom error response
   */
  errorFormatter?: (error: Error, request: HttpRequest<unknown>) => unknown;

  /**
   * Request transformer - modify request before passing to Schmock
   * @param request - Angular HTTP request
   * @returns Modified request data
   */
  transformRequest?: (
    request: HttpRequest<unknown>,
  ) => Schmock.AdapterRequestOverride;

  /**
   * Response transformer - modify Schmock response before returning
   * @param response - Response from Schmock
   * @param request - Original Angular request
   * @returns Modified response
   */
  transformResponse?: (
    response: Schmock.Response,
    request: HttpRequest<unknown>,
  ) => Schmock.Response;

  /**
   * Request hook under the name the fetch interceptor, React, Vue and Express
   * use. Like `transformRequest`, but it may be async, and returning nothing
   * leaves the request unchanged. When both are set, `transformRequest` is
   * used.
   * @param request - Angular HTTP request
   * @returns Request overrides, or nothing to keep the request as is
   */
  beforeRequest?: (request: HttpRequest<unknown>) =>
    | Schmock.AdapterRequestOverride
    // biome-ignore lint/suspicious/noConfusingVoidType: as in InterceptOptions, a hook declared to return void must be accepted
    | void
    | Promise<Schmock.AdapterRequestOverride | undefined>;

  /**
   * Response hook under the name the fetch interceptor, React, Vue and
   * Express use. Like `transformResponse`, but it may be async, and returning
   * nothing keeps the response. When both are set, `transformResponse` is
   * used.
   * @param response - Response from Schmock
   * @param request - Original Angular request
   * @returns The response to emit, or nothing to keep Schmock's
   */
  beforeResponse?: (
    response: Schmock.Response,
    request: HttpRequest<unknown>,
  ) =>
    | Schmock.Response
    // biome-ignore lint/suspicious/noConfusingVoidType: as in InterceptOptions, a hook declared to return void must be accepted
    | void
    | Promise<Schmock.Response | undefined>;
}

/**
 * Extract query parameters from an Angular HttpRequest: the query already in
 * the URL string, then Angular's HttpParams. That is the order Angular writes
 * them into `urlWithParams`, so a key repeated anywhere resolves to its LAST
 * value on the wire, the rule the CLI, Express and the fetch interceptor
 * follow. HttpParams are read directly rather than re-parsed from
 * `urlWithParams`, so a custom parameter codec cannot skew the values.
 */
function extractQueryParams(
  request: HttpRequest<unknown>,
): Record<string, string> {
  const url = request.url;
  const queryStart = url.indexOf("?");
  const entries: Array<[string, string]> =
    queryStart === -1
      ? []
      : [...new URLSearchParams(url.slice(queryStart + 1))];

  for (const key of request.params.keys()) {
    const values = request.params.getAll(key);
    if (values !== null && values.length > 0) {
      entries.push([key, values[values.length - 1]]);
    }
  }

  // Own-property definition, so a `__proto__` key stays an ordinary entry.
  return Object.fromEntries(entries);
}

/**
 * Split an Angular request URL into its origin (null for a relative URL) and
 * its pathname, dropping the query:
 * - "http://localhost:4200/api/users" → origin "http://localhost:4200", "/api/users"
 * - "/api/users?foo=bar" → origin null, "/api/users"
 * - "api/users" → origin null, "/api/users"
 *
 * The query is dropped before looking for "://", so a relative URL carrying an
 * absolute one in its query (`/r?to=https://x`) stays relative.
 */
function splitRequestUrl(url: string): { origin: string | null; path: string } {
  const queryStart = url.indexOf("?");
  const urlWithoutQuery = queryStart === -1 ? url : url.slice(0, queryStart);

  if (urlWithoutQuery.includes("://")) {
    try {
      const parsed = new URL(urlWithoutQuery);
      return { origin: parsed.origin, path: parsed.pathname };
    } catch {
      // Not a URL after all: read it as a relative path below.
    }
  }

  return {
    origin: null,
    path: urlWithoutQuery.startsWith("/")
      ? urlWithoutQuery
      : `/${urlWithoutQuery}`,
  };
}

/**
 * The path a request is routed under once the `baseUrl` prefix is stripped,
 * or `undefined` when the request lies outside it and is passed through.
 *
 * Matching is core's, so raw and percent-encoded spellings of the prefix
 * match alike, exactly as in the fetch interceptor. Stripping is Angular's
 * own (docs/angular.md): it removes as many leading segments as the prefix
 * has, so the remainder keeps the spelling the request used. Canonicalizing
 * never adds or removes a "/", which is what makes the segment count carry
 * over from the canonical prefix to the raw path.
 */
function routePathUnderPrefix(
  prefix: Schmock.PathPrefix | undefined,
  url: string,
): string | undefined {
  const { origin, path } = splitRequestUrl(url);
  if (!prefix) return path;
  // An origin-form base also requires the request's origin; a relative
  // request, which has none, never matches it.
  if (prefix.origin !== null && origin !== prefix.origin) return undefined;
  if (!matchPathPrefix(prefix, path)) return undefined;
  if (prefix.path === "") return path;

  const prefixSegments = prefix.path.split("/").length;
  const rawPrefix = path.split("/").slice(0, prefixSegments).join("/");
  return path.slice(rawPrefix.length) || "/";
}

/**
 * Convert Angular headers to plain object.
 *
 * A repeated header is combined into one field value with ", " (RFC 9110
 * field-list combining) rather than reduced to its first value. That is what
 * the browser puts on the wire: XHR and fetch both fold repeated request
 * headers into one comma-joined line, and the fetch interceptor reads through
 * `Headers`, which does the same. Node-based transports (Express, the CLI,
 * `mock.listen()`) only differ when a raw client sends a header as separate
 * lines: Node then keeps the FIRST value of its single-value headers
 * (authorization, content-type, host, user-agent and the rest of its discard
 * list), joins `cookie` with "; ", and comma-joins everything else. A browser
 * never sends those separate lines, so no Angular request reaches that case.
 * `set-cookie` is a response header and never reaches this function, so the
 * join is safe here.
 *
 * Casing is deliberately NOT folded here: it is folded once at the
 * `mock.handle()` call site so a `transformHeaders` override sees the same
 * shape Angular gave it.
 */
function headersToObject(
  request: HttpRequest<unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};

  request.headers.keys().forEach((key) => {
    const values = request.headers.getAll(key);
    if (values !== null && values.length > 0) {
      headers[key] = values.join(", ");
    }
  });

  return headers;
}

type RequestHook = (
  request: HttpRequest<unknown>,
) =>
  | Schmock.AdapterRequestOverride
  | PromiseLike<Schmock.AdapterRequestOverride>;

type ResponseHook = (
  response: Schmock.Response,
  request: HttpRequest<unknown>,
) => Schmock.Response | PromiseLike<Schmock.Response>;

/** The request as it is handed to `mock.handle()`. */
interface RoutedRequest {
  method: Schmock.HttpMethod;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  query: Record<string, string>;
}

/** Everything a subscription needs that is fixed when the interceptor is built. */
interface InterceptorConfig {
  mock: Schmock.CallableMockInstance;
  passthrough: boolean;
  errorFormatter?: (error: Error, request: HttpRequest<unknown>) => unknown;
  requestHook?: RequestHook;
  responseHook?: ResponseHook;
}

/** The state of one subscription to an intercepted request. */
interface Interception {
  readonly config: InterceptorConfig;
  readonly req: HttpRequest<unknown>;
  readonly next: HttpHandler;
  readonly observer: Subscriber<HttpEvent<unknown>>;
  readonly abortController: AbortController;
  aborted: boolean;
  innerSub?: { unsubscribe(): void };
  /**
   * Shapes error responses. A request hook's rewrite updates it; a throw
   * before that leaves the pre-hook method in place.
   */
  responseMethod: Schmock.HttpMethod;
}

/**
 * Local rather than core's `isThenable`, which `@schmock/core` does not
 * export and which rejects function-typed thenables. A hook may return one,
 * and it must still be awaited.
 */
function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/**
 * Continue with a hook's result: at once when the hook was synchronous, so a
 * sync hook keeps the timing it always had, or once its promise settles.
 */
function whenSettled<T, R>(
  value: T | PromiseLike<T>,
  next: (settled: T) => R,
): R | Promise<R> {
  return isPromiseLike(value) ? Promise.resolve(value).then(next) : next(value);
}

/**
 * The request hook in force: `transformRequest` when set, otherwise
 * `beforeRequest`, whose empty result means "no change".
 */
function resolveRequestHook(
  options: AngularAdapterOptions,
): RequestHook | undefined {
  const { transformRequest, beforeRequest } = options;
  if (transformRequest) return transformRequest;
  if (!beforeRequest) return undefined;
  return (request) =>
    whenSettled(beforeRequest(request), (override) => override ?? {});
}

/**
 * The response hook in force: `transformResponse` when set, otherwise
 * `beforeResponse`, whose empty result keeps the response.
 */
function resolveResponseHook(
  options: AngularAdapterOptions,
): ResponseHook | undefined {
  const { transformResponse, beforeResponse } = options;
  if (transformResponse) return transformResponse;
  if (!beforeResponse) return undefined;
  return (response, request) =>
    whenSettled(
      beforeResponse(response, request),
      (replaced) => replaced ?? response,
    );
}

/**
 * Emit a non-2xx response on Angular's error channel. The body is shaped by
 * the same responseType law as a success body.
 */
function emitHttpError(
  observer: Subscriber<HttpEvent<unknown>>,
  req: HttpRequest<unknown>,
  response: Schmock.Response,
  body: unknown,
): void {
  observer.error(
    new HttpErrorResponse({
      error: applyResponseType(
        body,
        response.status,
        response.headers,
        req.responseType,
      ),
      status: response.status,
      statusText: getStatusText(response.status),
      url: req.urlWithParams,
      headers: new HttpHeaders(response.headers),
    }),
  );
}

/** The unformatted body of an adapter failure: its message and code. */
function defaultErrorBody(error: unknown): { error: string; code: string } {
  return {
    error: error instanceof Error ? error.message : "Internal Server Error",
    code:
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "INTERNAL_ERROR",
  };
}

/**
 * Shape an out-of-band failure (a throwing hook, a rejected handler) into an
 * HttpErrorResponse, so the Observable always settles. Without an
 * errorFormatter, or when it throws, the body is the failure's own message and
 * code; a formatted body the normalizer rejects falls back to the minimal one.
 */
function emitFailure(interception: Interception, error: unknown): void {
  if (interception.aborted) return;
  const { req, config } = interception;
  const { errorFormatter } = config;

  const response = buildFormattedErrorResponse({
    formatter: (cause) => {
      if (!errorFormatter) return defaultErrorBody(error);
      try {
        return errorFormatter(cause, req);
      } catch {
        return defaultErrorBody(error);
      }
    },
    error: error instanceof Error ? error : new Error(String(error)),
    method: interception.responseMethod,
  });
  emitHttpError(interception.observer, req, response, response.body);
}

/**
 * Emit the routed response: 2xx as an HttpResponse, anything else as an
 * HttpErrorResponse. Only a core-marked exception at 500 is formatted; a
 * domain 500 body is emitted as the route wrote it.
 */
function emitResponse(
  interception: Interception,
  routed: Schmock.Response,
  internalError: Error | undefined,
): void {
  const { req, observer, config, responseMethod } = interception;
  const response = normalizeResponse(routed, responseMethod);
  const { status, headers } = response;

  // Angular treats only final 2xx responses as successful emissions.
  if (status < 200 || status >= 300) {
    const { errorFormatter } = config;
    const errorResponse =
      status === 500 && errorFormatter && internalError
        ? buildFormattedErrorResponse({
            formatter: (error) => errorFormatter(error, req),
            error: internalError,
            inheritedHeaders: headers,
            method: responseMethod,
          })
        : response;
    emitHttpError(observer, req, errorResponse, errorResponse.body);
    return;
  }

  observer.next(
    new HttpResponse({
      body: applyResponseType(response.body, status, headers, req.responseType),
      status,
      statusText: getStatusText(status),
      url: req.urlWithParams,
      headers: new HttpHeaders(headers),
    }),
  );
  observer.complete();
}

/**
 * Handle what the mock answered: pass an unmatched request on (or answer 404
 * when passthrough is off), otherwise run the response hook and emit. The
 * returned promise, when the hook is async, joins the caller's chain so its
 * rejection is shaped like any other failure.
 */
function transformAndEmit(
  interception: Interception,
  schmockResponse: Schmock.Response,
): undefined | Promise<void> {
  if (interception.aborted) return undefined;
  const { req, next, observer, config } = interception;

  if (isRouteNotFound(schmockResponse)) {
    if (config.passthrough) {
      interception.innerSub = next.handle(req).subscribe(observer);
      return undefined;
    }
    const response = normalizeResponse(
      {
        status: 404,
        body: { message: "No matching mock route found" },
        headers: {},
      },
      interception.responseMethod,
    );
    emitHttpError(observer, req, response, response.body);
    return undefined;
  }

  // Exception provenance is a non-enumerable symbol on the response, so it
  // must be read BEFORE the response hook: the documented `{...response}`
  // hook copies only own enumerable properties and would otherwise strip the
  // mark, silently bypassing errorFormatter.
  const internalError = getResponseException(schmockResponse);
  const { responseHook } = config;
  if (!responseHook) {
    emitResponse(interception, schmockResponse, internalError);
    return undefined;
  }

  const hooked = responseHook(schmockResponse, req);
  if (!isPromiseLike(hooked)) {
    emitResponse(interception, hooked, internalError);
    return undefined;
  }
  return Promise.resolve(hooked).then((response) => {
    if (!interception.aborted) {
      emitResponse(interception, response, internalError);
    }
  });
}

/**
 * Apply a request hook's override. A rewrite to a method no route can match
 * is passed on to the real backend untouched.
 */
function applyRequestOverride(
  interception: Interception,
  requestData: RoutedRequest,
  override: Schmock.AdapterRequestOverride,
): void {
  const { req, next, observer } = interception;
  const method = toSupportedHttpMethod(override.method ?? req.method);
  if (!method) {
    interception.innerSub = next.handle(req).subscribe(observer);
    return;
  }
  dispatchRequest(interception, { ...requestData, ...override, method });
}

/** Route the request through the mock and emit what it answers. */
function dispatchRequest(
  interception: Interception,
  routed: RoutedRequest,
): void {
  const { config, abortController } = interception;
  interception.responseMethod = routed.method;

  config.mock
    .handle(routed.method, routed.path, {
      // Fold header casing at the single choke point: doing it inside
      // headersToObject would miss a request hook override that supplies
      // capitalized keys.
      headers: lowercaseHeaderKeys(routed.headers),
      body: routed.body,
      query: routed.query,
      signal: abortController.signal,
    })
    .then((response) => transformAndEmit(interception, response))
    .catch((error: unknown) => emitFailure(interception, error));
}

/**
 * Run one subscription: derive the request, apply the request hook and hand
 * it to the mock. Derivation and the hook run inside the Observable so a
 * throwing hook is shaped into an HttpErrorResponse by the same path as any
 * other adapter failure instead of escaping intercept() as a bare Error.
 */
function runInterception(interception: Interception, routePath: string): void {
  const { req, config } = interception;
  try {
    const requestData: RoutedRequest = {
      method: interception.responseMethod,
      path: routePath,
      headers: headersToObject(req),
      body: req.body,
      // Angular's HttpParams are already parsed
      query: extractQueryParams(req),
    };

    const { requestHook } = config;
    if (!requestHook) {
      dispatchRequest(interception, requestData);
      return;
    }
    const override = requestHook(req);
    if (!isPromiseLike(override)) {
      applyRequestOverride(interception, requestData, override);
      return;
    }
    Promise.resolve(override)
      .then((settled) => {
        if (!interception.aborted) {
          applyRequestOverride(interception, requestData, settled);
        }
      })
      .catch((error: unknown) => emitFailure(interception, error));
  } catch (error) {
    emitFailure(interception, error);
  }
}

/**
 * Create an Angular HTTP interceptor from a Schmock instance
 */
export function createSchmockInterceptor(
  mock: Schmock.CallableMockInstance,
  options: AngularAdapterOptions = {},
): new () => HttpInterceptor {
  const { baseUrl, passthrough = true, errorFormatter } = options;
  const prefix = baseUrl ? parsePathPrefix(baseUrl) : undefined;
  const config: InterceptorConfig = {
    mock,
    passthrough,
    errorFormatter,
    requestHook: resolveRequestHook(options),
    responseHook: resolveResponseHook(options),
  };

  @Injectable()
  class SchmockInterceptor implements HttpInterceptor {
    intercept(
      req: HttpRequest<unknown>,
      next: HttpHandler,
    ): Observable<HttpEvent<unknown>> {
      // baseUrl filter, then the prefix is stripped so routes match without
      // it. An origin-form base also requires the request's origin.
      const routePath = routePathUnderPrefix(prefix, req.url);
      if (routePath === undefined) return next.handle(req);

      const method = toSupportedHttpMethod(req.method);
      if (!method) return next.handle(req);

      return new Observable<HttpEvent<unknown>>((observer) => {
        const interception: Interception = {
          config,
          req,
          next,
          observer,
          abortController: new AbortController(),
          aborted: false,
          responseMethod: method,
        };
        runInterception(interception, routePath);
        return () => {
          interception.aborted = true;
          interception.abortController.abort();
          interception.innerSub?.unsubscribe();
        };
      });
    }
  }

  return SchmockInterceptor;
}

/**
 * Provider configuration for Angular module
 */
export function provideSchmockInterceptor(
  mock: Schmock.CallableMockInstance,
  options?: AngularAdapterOptions,
) {
  // `createSchmockInterceptor` builds the @Injectable() class at runtime, so
  // ngc never sees it. `useClass` would force Angular to compile it via DI,
  // which needs @angular/compiler — absent in AOT apps → NG0204 "needs JIT
  // compiler". `useFactory` + manual `new` sidesteps DI entirely; the class
  // has no injected constructor deps, so instantiation is complete.
  const Interceptor = createSchmockInterceptor(mock, options);
  return {
    provide: HTTP_INTERCEPTORS,
    useFactory: () => new Interceptor(),
    multi: true,
  };
}

/**
 * One code for a missing and a malformed `@schmock/openapi` peer, so callers
 * can tell "the optional peer is unusable" apart from a failing spec.
 */
const OPENAPI_PEER_UNAVAILABLE = "OPENAPI_PEER_UNAVAILABLE";

type OpenapiFactory = (
  options: Schmock.OpenApiOptions,
) => Promise<Schmock.Plugin>;

/**
 * Load the optional `@schmock/openapi` peer at call time.
 *
 * The specifier is assembled at runtime on purpose. A string constant is not
 * enough: `bun build --minify` folds `const m = "@schmock/openapi";
 * import(m)` into a literal `import("@schmock/openapi")`, and a consumer's
 * bundler (esbuild in `ng build`) then fails to resolve the peer even for an
 * app that never calls the spec helpers. A computed specifier is left alone,
 * and TypeScript does not try to resolve it either.
 */
async function loadOptionalOpenapi(): Promise<OpenapiFactory> {
  const specifier = ["@schmock", "openapi"].join("/");
  let mod: unknown;
  try {
    mod = await import(/* @vite-ignore */ specifier);
  } catch (cause) {
    throw new SchmockError(
      "@schmock/openapi could not be loaded; install it to use the spec helpers",
      OPENAPI_PEER_UNAVAILABLE,
      { cause },
    );
  }
  if (
    typeof mod === "object" &&
    mod !== null &&
    "openapi" in mod &&
    typeof mod.openapi === "function"
  ) {
    const factory = mod.openapi;
    return (options) => factory(options);
  }
  throw new SchmockError(
    "@schmock/openapi does not export an openapi() factory",
    OPENAPI_PEER_UNAVAILABLE,
  );
}

/**
 * Create an Angular HTTP interceptor from an OpenAPI spec.
 * Auto-registers all routes from the spec with full CRUD support.
 *
 * Requires `@schmock/openapi` to be installed.
 *
 * @example
 * ```typescript
 * const Interceptor = await createSchmockInterceptorFromSpec(
 *   { spec: './assets/api.yaml', seed: { pets: { count: 10 } } },
 *   { baseUrl: '/api' },
 * );
 * ```
 */
export async function createSchmockInterceptorFromSpec(
  openapiOptions: Schmock.OpenApiOptions,
  adapterOptions?: AngularAdapterOptions,
): Promise<new () => HttpInterceptor> {
  const openapi = await loadOptionalOpenapi();
  const mock = schmock({ debug: openapiOptions.debug, state: {} });
  mock.pipe(await openapi(openapiOptions));
  return createSchmockInterceptor(mock, adapterOptions);
}

/**
 * Angular provider that creates a Schmock interceptor from an OpenAPI spec.
 *
 * Requires `@schmock/openapi` to be installed.
 *
 * @example
 * ```typescript
 * providers: [
 *   await provideSchmockInterceptorFromSpec(
 *     { spec: mySpec, fakerSeed: 42 },
 *     { baseUrl: '/api' },
 *   ),
 * ]
 * ```
 */
export async function provideSchmockInterceptorFromSpec(
  openapiOptions: Schmock.OpenApiOptions,
  adapterOptions?: AngularAdapterOptions,
) {
  // See `provideSchmockInterceptor` — `useFactory` keeps this AOT-safe.
  const Interceptor = await createSchmockInterceptorFromSpec(
    openapiOptions,
    adapterOptions,
  );
  return {
    provide: HTTP_INTERCEPTORS,
    useFactory: () => new Interceptor(),
    multi: true,
  };
}

// Re-export response helpers from core for backwards compatibility
export {
  badRequest,
  created,
  forbidden,
  noContent,
  notFound,
  paginate,
  serverError,
  unauthorized,
} from "@schmock/core";
