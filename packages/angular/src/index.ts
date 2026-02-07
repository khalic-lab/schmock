/// <reference path="../../../types/schmock.d.ts" />

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
import type { CallableMockInstance } from "@schmock/core";
import { ROUTE_NOT_FOUND_CODE, toHttpMethod } from "@schmock/core";
import { Observable } from "rxjs";

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
    response: Schmock.Response,
    request: HttpRequest<any>,
  ) => Schmock.Response;
}

/**
 * Extract query parameters from URL
 */
function extractQueryParams(url: string): Record<string, string> {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return {};

  const params = new URLSearchParams(url.slice(queryStart + 1));
  const result: Record<string, string> = {};

  params.forEach((value, key) => {
    result[key] = value;
  });

  return result;
}

/**
 * Extract path without query parameters
 */
function extractPath(url: string): string {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
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
      // Check if we should intercept this request
      if (baseUrl && !req.url.startsWith(baseUrl)) {
        return next.handle(req);
      }

      // Extract request data
      const path = extractPath(req.url);
      const query = extractQueryParams(req.url);

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
          method: toHttpMethod(transformed.method || requestData.method),
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
            const body = schmockResponse.body;
            const isRouteNotFound =
              schmockResponse.status === 404 &&
              body &&
              typeof body === "object" &&
              "code" in body &&
              body.code === ROUTE_NOT_FOUND_CODE;

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

              // Convert Schmock response to Angular HttpResponse
              const httpResponse = new HttpResponse({
                body: response.body,
                status: response.status ?? 200,
                statusText: "OK",
                url: req.url,
                headers: new HttpHeaders(response.headers || {}),
              });

              observer.next(httpResponse);
              observer.complete();
            }
          })
          .catch((error: unknown) => {
            // Handle errors
            const isError = error instanceof Error;
            let errorBody: unknown;

            if (isError && errorFormatter) {
              errorBody = errorFormatter(error, req);
            } else {
              const hasCode =
                error &&
                typeof error === "object" &&
                "code" in error &&
                typeof error.code === "string";
              errorBody = {
                error: isError ? error.message : "Internal Server Error",
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
