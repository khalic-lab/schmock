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
import type {
  CallableMockInstance,
  HttpMethod,
  ResponseResult,
} from "@schmock/core";
import { ROUTE_NOT_FOUND_CODE } from "@schmock/core";
import { Observable } from "rxjs";

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
] as const;

function isHttpMethod(method: string): method is HttpMethod {
  return HTTP_METHODS.includes(method as HttpMethod);
}

function toHttpMethod(method: string): HttpMethod {
  if (isHttpMethod(method)) {
    return method;
  }
  return "GET";
}

/**
 * Get HTTP status text for a status code
 */
function getStatusText(status: number): string {
  const statusTexts: Record<number, string> = {
    200: "OK",
    201: "Created",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    500: "Internal Server Error",
  };
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
  mock: CallableMockInstance,
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

      // Extract request data using Angular's built-in params
      const query = extractQueryParams(req);

      let requestData = {
        method: toHttpMethod(req.method),
        path,
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
          method: toHttpMethod(transformed.method ?? req.method),
        };
      }

      // Handle with Schmock
      return new Observable<HttpEvent<any>>((observer) => {
        let innerSub: { unsubscribe(): void } | undefined;

        mock
          .handle(requestData.method, requestData.path, {
            headers: requestData.headers,
            body: requestData.body,
            query: requestData.query,
          })
          .then((schmockResponse) => {
            // Detect ROUTE_NOT_FOUND responses
            const isRouteNotFound =
              schmockResponse.status === 404 &&
              schmockResponse.body &&
              typeof schmockResponse.body === "object" &&
              (schmockResponse.body as Record<string, unknown>).code ===
                ROUTE_NOT_FOUND_CODE;

            if (isRouteNotFound && passthrough) {
              // No matching route, pass to real backend
              innerSub = next.handle(req).subscribe(observer);
            } else if (isRouteNotFound) {
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

              const status = response.status || 200;

              // Auto-convert error status codes (>= 400) to HttpErrorResponse
              if (status >= 400) {
                let errorBody = response.body;

                // Check if this is a 500 error from a handler that threw an exception
                // and if errorFormatter is configured
                const body = response.body as
                  | Record<string, unknown>
                  | undefined;
                if (
                  status === 500 &&
                  errorFormatter &&
                  body?.error &&
                  body?.code
                ) {
                  // This is an error from Schmock core (handler threw an error)
                  // Apply the custom errorFormatter
                  const error = new Error(body.error as string);
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
            // Handle errors
            let errorBody: unknown;

            if (errorFormatter) {
              errorBody = errorFormatter(
                error instanceof Error ? error : new Error(String(error)),
                req,
              );
            } else {
              const errorWithCode = error as { code?: string };
              errorBody = {
                error:
                  error instanceof Error
                    ? error.message
                    : "Internal Server Error",
                code: errorWithCode.code ?? "INTERNAL_ERROR",
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
  mock: CallableMockInstance,
  options?: AngularAdapterOptions,
) {
  return {
    provide: HTTP_INTERCEPTORS,
    useClass: createSchmockInterceptor(mock, options),
    multi: true,
  };
}

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Helper to create a 404 Not Found response
 * @example mock('GET /api/users/999', notFound('User not found'))
 */
export function notFound(
  message: string | object = "Not Found",
): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [404, body];
}

/**
 * Helper to create a 400 Bad Request response
 * @example mock('POST /api/users', badRequest('Invalid email format'))
 */
export function badRequest(
  message: string | object = "Bad Request",
): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [400, body];
}

/**
 * Helper to create a 401 Unauthorized response
 * @example mock('GET /api/protected', unauthorized('Token expired'))
 */
export function unauthorized(
  message: string | object = "Unauthorized",
): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [401, body];
}

/**
 * Helper to create a 403 Forbidden response
 * @example mock('GET /api/admin', forbidden('Admin access required'))
 */
export function forbidden(
  message: string | object = "Forbidden",
): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [403, body];
}

/**
 * Helper to create a 500 Internal Server Error response
 * @example mock('GET /api/broken', serverError('Database connection failed'))
 */
export function serverError(
  message: string | object = "Internal Server Error",
): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [500, body];
}

/**
 * Helper to create a 201 Created response
 * @example mock('POST /api/users', created({ id: 1, name: 'John' }))
 */
export function created(body: object): [number, object] {
  return [201, body];
}

/**
 * Helper to create a 204 No Content response
 * @example mock('DELETE /api/users/1', noContent())
 */
export function noContent(): [number, null] {
  return [204, null];
}

/**
 * Pagination options
 */
export interface PaginateOptions {
  page?: number;
  pageSize?: number;
}

/**
 * Paginated response structure
 */
export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Helper to create a paginated response
 * @example
 * const items = [{ id: 1 }, { id: 2 }, { id: 3 }]
 * mock('GET /api/items', ({ query }) => paginate(items, {
 *   page: parseInt(query.page || '1'),
 *   pageSize: parseInt(query.pageSize || '10')
 * }))
 */
export function paginate<T>(
  items: T[],
  options: PaginateOptions = {},
): PaginatedResponse<T> {
  const page = options.page || 1;
  const pageSize = options.pageSize || 10;
  const total = items.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const data = items.slice(start, end);

  return {
    data,
    page,
    pageSize,
    total,
    totalPages,
  };
}
