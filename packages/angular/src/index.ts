/// <reference path="../../core/schmock.d.ts" />

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
import { isHttpMethod, isRouteNotFound } from "@schmock/core";
import { Observable } from "rxjs";

function toSafeHttpMethod(method: string): Schmock.HttpMethod {
  const upper = method.toUpperCase();
  if (isHttpMethod(upper)) {
    return upper;
  }
  console.warn(
    `[@schmock/angular] Unknown HTTP method "${method}", defaulting to GET`,
  );
  return "GET";
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
  errorFormatter?: (error: Error, request: HttpRequest<any>) => any;

  /**
   * Request transformer - modify request before passing to Schmock
   * @param request - Angular HTTP request
   * @returns Modified request data
   */
  transformRequest?: (request: HttpRequest<any>) => {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: any;
    query?: Record<string, string>;
  };

  /**
   * Response transformer - modify Schmock response before returning
   * @param response - Response from Schmock
   * @param request - Original Angular request
   * @returns Modified response
   */
  transformResponse?: (
    response: {
      status: number;
      body: unknown;
      headers: Record<string, string>;
    },
    request: HttpRequest<any>,
  ) => { status: number; body: unknown; headers: Record<string, string> };
}

/**
 * Extract query parameters from Angular HttpRequest
 * Uses Angular's built-in params which are already parsed
 */
function extractQueryParams(request: HttpRequest<any>): Record<string, string> {
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
 * Convert Angular headers to plain object
 */
function headersToObject(request: HttpRequest<any>): Record<string, string> {
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
      req: HttpRequest<any>,
      next: HttpHandler,
    ): Observable<HttpEvent<any>> {
      // Extract pathname from URL (handles full URLs like http://localhost:4200/api/users)
      const path = extractPathname(req.url);

      // Check if we should intercept this request
      if (baseUrl && !path.startsWith(baseUrl)) {
        return next.handle(req);
      }

      // Strip baseUrl prefix so routes match without it
      const routePath = baseUrl ? path.slice(baseUrl.length) || "/" : path;

      // Extract request data using Angular's built-in params
      const query = extractQueryParams(req);

      let requestData = {
        method: toSafeHttpMethod(req.method),
        path: routePath,
        headers: headersToObject(req),
        body: req.body,
        query,
      };

      // Apply request transformation if provided
      if (transformRequest) {
        const transformed = transformRequest(req);
        requestData = {
          ...requestData,
          ...transformed,
          method: toSafeHttpMethod(transformed.method ?? req.method),
        };
      }

      // Handle with Schmock
      return new Observable<HttpEvent<any>>((observer) => {
        let innerSub: { unsubscribe(): void } | undefined;
        let aborted = false;

        mock
          .handle(requestData.method, requestData.path, {
            headers: requestData.headers,
            body: requestData.body,
            query: requestData.query,
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
              observer.error(
                new HttpErrorResponse({
                  error: { message: "No matching mock route found" },
                  status: 404,
                  statusText: "Not Found",
                  url: req.url,
                }),
              );
            } else {
              // Apply response transformation if provided
              let response = schmockResponse;
              if (transformResponse) {
                response = transformResponse(response, req);
              }

              const status = response.status ?? 200;

              // Auto-convert error status codes (>= 400) to HttpErrorResponse
              if (status >= 400) {
                let errorBody = response.body;

                // Check if this is a 500 error from a handler that threw an exception
                // and if errorFormatter is configured
                const respBody = response.body;
                if (
                  status === 500 &&
                  errorFormatter &&
                  respBody !== null &&
                  typeof respBody === "object" &&
                  "error" in respBody &&
                  "code" in respBody
                ) {
                  // This is an error from Schmock core (handler threw an error)
                  // Apply the custom errorFormatter
                  const errMsg =
                    typeof respBody.error === "string"
                      ? respBody.error
                      : "Unknown error";
                  const error = new Error(errMsg);
                  errorBody = errorFormatter(error, req);
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

            if (errorFormatter) {
              errorBody = errorFormatter(
                error instanceof Error ? error : new Error(String(error)),
                req,
              );
            } else {
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

            observer.error(
              new HttpErrorResponse({
                error: errorBody,
                status: 500,
                statusText: "Internal Server Error",
                url: req.url,
              }),
            );
          });

        return () => {
          aborted = true;
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
  return {
    provide: HTTP_INTERCEPTORS,
    useClass: createSchmockInterceptor(mock, options),
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
  const { schmock } = await (import(coreMod) as Promise<
    typeof import("@schmock/core")
  >);
  const { openapi } = await (import(openapiMod) as Promise<{
    openapi: (opts: Schmock.OpenApiOptions) => Promise<Schmock.Plugin>;
  }>);
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
  return {
    provide: HTTP_INTERCEPTORS,
    useClass: await createSchmockInterceptorFromSpec(
      openapiOptions,
      adapterOptions,
    ),
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
