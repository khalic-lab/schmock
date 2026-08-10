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
  getResponseException,
  isHttpMethod,
  isRouteNotFound,
  normalizeResponse,
  serializeResponseBody,
} from "@schmock/core";
import { Observable } from "rxjs";

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

/** Case-insensitive header lookup — normalizeResponse preserves casing. */
function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
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
        ? new Blob([], { type: headerValue(headers, "content-type") ?? "" })
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
            type: headerValue(headers, "content-type") ?? "",
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
}

/**
 * Extract query parameters from Angular HttpRequest
 * Uses Angular's built-in params which are already parsed
 */
function extractQueryParams(
  request: HttpRequest<unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};

  // Use Angular's HttpParams which are already parsed
  request.params.keys().forEach((key) => {
    const value = request.params.get(key);
    if (value !== null) {
      result[key] = value;
    }
  });

  // Also check URL for query params (fallback for params in URL string)
  const url = request.url;
  const queryStart = url.indexOf("?");
  if (queryStart !== -1) {
    const urlParams = new URLSearchParams(url.slice(queryStart + 1));
    urlParams.forEach((value, key) => {
      // Don't overwrite params from Angular's HttpParams
      if (!(key in result)) {
        result[key] = value;
      }
    });
  }

  return result;
}

/**
 * Extract pathname from URL (handles full URLs and relative paths)
 * - "http://localhost:4200/api/users" → "/api/users"
 * - "/api/users?foo=bar" → "/api/users"
 * - "api/users" → "/api/users"
 */
function extractPathname(url: string): string {
  // Remove query string first
  const queryStart = url.indexOf("?");
  const urlWithoutQuery = queryStart === -1 ? url : url.slice(0, queryStart);

  // Check if it's a full URL with protocol
  if (urlWithoutQuery.includes("://")) {
    try {
      const parsed = new URL(urlWithoutQuery);
      return parsed.pathname;
    } catch {
      // If URL parsing fails, fall through to simple extraction
    }
  }

  // Handle relative paths - ensure it starts with /
  if (!urlWithoutQuery.startsWith("/")) {
    return `/${urlWithoutQuery}`;
  }

  return urlWithoutQuery;
}

/**
 * Extract origin from a URL string, or null for relative URLs.
 */
function extractOrigin(url: string): string | null {
  if (!url.includes("://")) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Parse a baseUrl option into its origin + path parts. Path-only inputs
 * keep current "pathname prefix" semantics; origin-form inputs require the
 * request's origin to match too.
 */
function parseBaseUrl(baseUrl: string): {
  origin: string | null;
  path: string;
} {
  if (baseUrl.includes("://")) {
    try {
      const parsed = new URL(baseUrl);
      const rawPath = parsed.pathname;
      const path = rawPath === "/" ? "" : rawPath.replace(/\/$/, "");
      return { origin: parsed.origin, path };
    } catch {
      // Fall through to path-only handling
    }
  }
  return { origin: null, path: baseUrl.replace(/\/$/, "") };
}

/**
 * Convert Angular headers to plain object.
 *
 * A repeated header is combined into one field value with ", " (RFC 9110
 * field-list combining) rather than reduced to its first value: that is what
 * `HttpHeaders.get()` would return, and what the other adapters already
 * deliver — the fetch interceptor reads through `Headers`, which comma-joins
 * repeats, and Node comma-joins repeated request headers before Express sees
 * them. `set-cookie` is a response header and never reaches this function, so
 * the join is safe here.
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

/**
 * Create an Angular HTTP interceptor from a Schmock instance
 */
export function createSchmockInterceptor(
  mock: Schmock.CallableMockInstance,
  options: AngularAdapterOptions = {},
): new () => HttpInterceptor {
  const {
    baseUrl,
    passthrough = true,
    errorFormatter,
    transformRequest,
    transformResponse,
  } = options;

  @Injectable()
  class SchmockInterceptor implements HttpInterceptor {
    intercept(
      req: HttpRequest<unknown>,
      next: HttpHandler,
    ): Observable<HttpEvent<unknown>> {
      // Extract pathname from URL (handles full URLs like http://localhost:4200/api/users)
      const path = extractPathname(req.url);

      // baseUrl filter. Path-form keeps current "pathname prefix + strip"
      // semantics. Origin-form additionally requires the request's origin
      // to match — relative-URL requests with no origin won't match an
      // origin-form base.
      let effectiveBasePath = "";
      if (baseUrl) {
        const { origin: baseOrigin, path: basePath } = parseBaseUrl(baseUrl);
        if (baseOrigin) {
          const reqOrigin = extractOrigin(req.url);
          if (reqOrigin !== baseOrigin) {
            return next.handle(req);
          }
        }
        if (basePath && path !== basePath && !path.startsWith(`${basePath}/`)) {
          return next.handle(req);
        }
        effectiveBasePath = basePath;
      }

      // Strip baseUrl path prefix so routes match without it
      const routePath = effectiveBasePath
        ? path.slice(effectiveBasePath.length) || "/"
        : path;

      const method = toSupportedHttpMethod(req.method);
      if (!method) {
        return next.handle(req);
      }

      // Handle with Schmock. Request derivation and transformRequest run
      // INSIDE the Observable so a throwing hook is shaped into an
      // HttpErrorResponse by the same path as any other adapter failure
      // instead of escaping intercept() as a bare Error.
      return new Observable<HttpEvent<unknown>>((observer) => {
        let innerSub: { unsubscribe(): void } | undefined;
        let aborted = false;
        const abortController = new AbortController();
        const teardown = () => {
          aborted = true;
          abortController.abort();
          innerSub?.unsubscribe();
        };

        // Shapes error responses; a transformRequest rewrite updates it, and
        // a throw before that leaves the pre-transform method in place.
        let responseMethod: Schmock.HttpMethod = method;

        const emitError = (error: unknown) => {
          if (aborted) return;

          let errorBody: unknown;
          let formatterFailed = false;

          if (errorFormatter) {
            // A throwing formatter would leave the promise rejected with
            // nothing downstream to catch it, so the Observable would
            // never settle. Fall back to the unformatted body instead.
            try {
              errorBody = errorFormatter(
                error instanceof Error ? error : new Error(String(error)),
                req,
              );
            } catch {
              formatterFailed = true;
            }
          }
          if (!errorFormatter || formatterFailed) {
            const hasCode =
              error !== null &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "string";
            errorBody = {
              error:
                error instanceof Error
                  ? error.message
                  : "Internal Server Error",
              code: hasCode ? error.code : "INTERNAL_ERROR",
            };
          }

          // The Observable must always settle: if the formatter returned a
          // value the normalizer rejects (for example an embedded Error),
          // fall back to a minimal safe body instead of throwing inside
          // this handler and hanging the HttpClient request forever.
          let response: Schmock.Response;
          try {
            response = normalizeResponse(
              {
                status: 500,
                body: errorBody,
                headers: { "content-type": "application/json" },
              },
              responseMethod,
            );
          } catch {
            response = {
              status: 500,
              body: {
                error: "Internal Server Error",
                code: "INTERNAL_ERROR",
              },
              headers: { "content-type": "application/json" },
            };
          }
          observer.error(
            new HttpErrorResponse({
              error: applyResponseType(
                response.body,
                response.status,
                response.headers,
                req.responseType,
              ),
              status: response.status,
              statusText: "Internal Server Error",
              url: req.urlWithParams,
              headers: new HttpHeaders(response.headers),
            }),
          );
        };

        try {
          let requestData = {
            method,
            path: routePath,
            headers: headersToObject(req),
            body: req.body,
            // Angular's HttpParams are already parsed
            query: extractQueryParams(req),
          };

          // Apply request transformation if provided
          if (transformRequest) {
            const transformed = transformRequest(req);
            const transformedMethod = toSupportedHttpMethod(
              transformed.method ?? req.method,
            );
            if (!transformedMethod) {
              innerSub = next.handle(req).subscribe(observer);
              return teardown;
            }
            requestData = {
              ...requestData,
              ...transformed,
              method: transformedMethod,
            };
          }
          responseMethod = requestData.method;

          mock
            .handle(requestData.method, requestData.path, {
              // Fold header casing at the single choke point: doing it
              // inside headersToObject would miss a transformRequest
              // override that supplies capitalized keys.
              headers: lowercaseHeaderKeys(requestData.headers),
              body: requestData.body,
              query: requestData.query,
              signal: abortController.signal,
            })
            .then((schmockResponse: Schmock.Response) => {
              if (aborted) return;

              // Detect ROUTE_NOT_FOUND responses
              const routeNotFound = isRouteNotFound(schmockResponse);

              if (routeNotFound && passthrough) {
                // No matching route, pass to real backend
                innerSub = next.handle(req).subscribe(observer);
                return;
              }

              if (routeNotFound) {
                // No matching route and passthrough disabled
                const response = normalizeResponse(
                  {
                    status: 404,
                    body: { message: "No matching mock route found" },
                    headers: {},
                  },
                  requestData.method,
                );
                observer.error(
                  new HttpErrorResponse({
                    error: applyResponseType(
                      response.body,
                      response.status,
                      response.headers,
                      req.responseType,
                    ),
                    status: response.status,
                    statusText: "Not Found",
                    url: req.urlWithParams,
                    headers: new HttpHeaders(response.headers),
                  }),
                );
                return;
              }

              // Exception provenance is a non-enumerable symbol on the
              // response, so it must be read BEFORE transformResponse: the
              // documented `{...response}` hook copies only own enumerable
              // properties and would otherwise strip the mark, silently
              // bypassing errorFormatter.
              const internalError = getResponseException(schmockResponse);

              // Apply response transformation if provided
              let response = schmockResponse;
              if (transformResponse) {
                response = transformResponse(response, req);
              }
              response = normalizeResponse(response, requestData.method);

              const status = response.status;
              const headers = response.headers || {};

              // Angular treats only final 2xx responses as successful emissions.
              if (status < 200 || status >= 300) {
                let errorBody = response.body;

                // Format only core-marked exceptions, not domain 500 bodies.
                // A throwing formatter must not propagate into .catch, where
                // it would be invoked a second time with its own exception.
                if (status === 500 && errorFormatter && internalError) {
                  try {
                    errorBody = errorFormatter(internalError, req);
                  } catch {
                    errorBody = {
                      error: "Internal Server Error",
                      code: "INTERNAL_ERROR",
                    };
                  }
                }

                observer.error(
                  new HttpErrorResponse({
                    // Shape the formatter's output too — the error channel
                    // obeys the same responseType law as the success one.
                    // Once the formatter has replaced the body the response's
                    // own content-type no longer describes it, so a Blob would
                    // otherwise be labelled with the route's media type.
                    error: applyResponseType(
                      errorBody,
                      status,
                      errorBody === response.body
                        ? headers
                        : { "content-type": "application/json" },
                      req.responseType,
                    ),
                    status,
                    statusText: getStatusText(status),
                    url: req.urlWithParams,
                    headers: new HttpHeaders(headers),
                  }),
                );
              } else {
                // Convert Schmock response to Angular HttpResponse
                const httpResponse = new HttpResponse({
                  body: applyResponseType(
                    response.body,
                    status,
                    headers,
                    req.responseType,
                  ),
                  status,
                  statusText: getStatusText(status),
                  url: req.urlWithParams,
                  headers: new HttpHeaders(headers),
                });

                observer.next(httpResponse);
                observer.complete();
              }
            })
            .catch(emitError);
        } catch (error) {
          // A throwing transformRequest (or request derivation) is shaped by
          // the same path as an async failure, so callers always receive an
          // HttpErrorResponse and the Observable always settles.
          emitError(error);
        }

        return teardown;
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
  // Dynamic imports keep @schmock/openapi optional — string indirection
  // prevents TypeScript from resolving the module at build time.
  const coreMod = "@schmock/core";
  const openapiMod = "@schmock/openapi";
  const coreImport: Promise<typeof import("@schmock/core")> = import(coreMod);
  const openapiImport: Promise<{
    openapi: (opts: Schmock.OpenApiOptions) => Promise<Schmock.Plugin>;
  }> = import(openapiMod);
  const { schmock } = await coreImport;
  const { openapi } = await openapiImport;
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
