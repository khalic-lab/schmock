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
  isHttpMethod,
  isRouteNotFound,
  normalizeResponse,
} from "@schmock/core";
import { Observable } from "rxjs";

const RESPONSE_ORIGIN = Symbol.for("@schmock/core.response-origin");

function responseException(response: Schmock.Response): Error | undefined {
  const origin: unknown = Reflect.get(response, RESPONSE_ORIGIN);
  if (
    typeof origin === "object" &&
    origin !== null &&
    "kind" in origin &&
    origin.kind === "exception" &&
    "error" in origin &&
    origin.error instanceof Error
  ) {
    return origin.error;
  }
  return undefined;
}

function toSupportedHttpMethod(method: string): Schmock.HttpMethod | undefined {
  const upper = method.toUpperCase();
  if (isHttpMethod(upper)) {
    return upper;
  }
  return undefined;
}

const statusTexts: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/**
 * Get HTTP status text for a status code
 */
function getStatusText(status: number): string {
  return statusTexts[status] || "Unknown";
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
 * Convert Angular headers to plain object
 */
function headersToObject(
  request: HttpRequest<unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};

  request.headers.keys().forEach((key) => {
    const value = request.headers.get(key);
    if (value !== null) {
      headers[key] = value;
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

      // Extract request data using Angular's built-in params
      const query = extractQueryParams(req);

      const method = toSupportedHttpMethod(req.method);
      if (!method) {
        return next.handle(req);
      }

      let requestData = {
        method,
        path: routePath,
        headers: headersToObject(req),
        body: req.body,
        query,
      };

      // Apply request transformation if provided
      if (transformRequest) {
        const transformed = transformRequest(req);
        const transformedMethod = toSupportedHttpMethod(
          transformed.method ?? req.method,
        );
        if (!transformedMethod) {
          return next.handle(req);
        }
        requestData = {
          ...requestData,
          ...transformed,
          method: transformedMethod,
        };
      }

      // Handle with Schmock
      return new Observable<HttpEvent<unknown>>((observer) => {
        let innerSub: { unsubscribe(): void } | undefined;
        let aborted = false;
        const abortController = new AbortController();

        mock
          .handle(requestData.method, requestData.path, {
            headers: requestData.headers,
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
            } else if (routeNotFound) {
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
                  error: response.body,
                  status: response.status,
                  statusText: "Not Found",
                  url: req.url,
                  headers: new HttpHeaders(response.headers),
                }),
              );
            } else {
              // Apply response transformation if provided
              let response = schmockResponse;
              if (transformResponse) {
                response = transformResponse(response, req);
              }
              const internalError = responseException(response);
              response = normalizeResponse(response, requestData.method);

              const status = response.status;

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
                    error: errorBody,
                    status,
                    statusText: getStatusText(status),
                    url: req.url,
                    headers: new HttpHeaders(response.headers || {}),
                  }),
                );
              } else {
                // Convert Schmock response to Angular HttpResponse
                const httpResponse = new HttpResponse({
                  body: response.body,
                  status,
                  statusText: getStatusText(status),
                  url: req.url,
                  headers: new HttpHeaders(response.headers || {}),
                });

                observer.next(httpResponse);
                observer.complete();
              }
            }
          })
          .catch((error: unknown) => {
            if (aborted) return;

            // Handle errors
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
                requestData.method,
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
                error: response.body,
                status: response.status,
                statusText: "Internal Server Error",
                url: req.url,
                headers: new HttpHeaders(response.headers),
              }),
            );
          });

        return () => {
          aborted = true;
          abortController.abort();
          innerSub?.unsubscribe();
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
