/// <reference path="../../../types/schmock.d.ts" />

import type { CallableMockInstance } from "@schmock/core";
import {
  ROUTE_NOT_FOUND_CODE,
  SchmockError,
  toHttpMethod,
} from "@schmock/core";
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
  errorFormatter?: (error: Error, req: Request) => any;

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
    | {
        method?: string;
        path?: string;
        headers?: Record<string, string>;
        body?: any;
        query?: Record<string, string>;
      }
    | undefined
    | Promise<any>;

  /**
   * Response interceptor - called before sending response
   * @param schmockResponse - Response from Schmock
   * @param req - Express request
   * @param res - Express response
   * @returns Modified response or void
   */
  beforeResponse?: (
    schmockResponse: {
      status: number;
      body: any;
      headers: Record<string, string>;
    },
    req: Request,
    res: Response,
  ) =>
    | { status: number; body: any; headers: Record<string, string> }
    | undefined
    | Promise<
        | { status: number; body: any; headers: Record<string, string> }
        | undefined
      >;
}

/**
 * Convert Schmock response to Express response
 */
function schmockToExpressResponse(
  schmockResponse: {
    status: number;
    body: any;
    headers: Record<string, string>;
  },
  res: Response,
): void {
  // Set status code
  if (schmockResponse.status != null) {
    res.status(schmockResponse.status);
  }

  // Set headers
  if (schmockResponse.headers) {
    Object.entries(schmockResponse.headers).forEach(([key, value]) => {
      if (typeof value === "string") {
        res.set(key, value);
      }
    });
  }

  // Send body
  if (schmockResponse.body !== undefined) {
    if (typeof schmockResponse.body === "string") {
      res.send(schmockResponse.body);
    } else {
      res.json(schmockResponse.body);
    }
  } else {
    res.end();
  }
}

/**
 * Default header transformer
 */
function defaultTransformHeaders(
  headers: Request["headers"],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value || "",
    ]),
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
  mock: CallableMockInstance,
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
    try {
      // Run request interceptor if provided
      let requestData = {
        method: toHttpMethod(req.method),
        path: req.path,
        headers: transformHeaders(req.headers),
        body: req.body,
        query: transformQuery(req.query),
      };

      if (beforeRequest) {
        const intercepted = await beforeRequest(req, res);
        if (intercepted) {
          requestData = {
            ...requestData,
            ...intercepted,
            method: toHttpMethod(intercepted.method || requestData.method),
          };
        }
      }

      // Handle request with Schmock
      let schmockResponse = await mock.handle(
        requestData.method,
        requestData.path,
        {
          headers: requestData.headers,
          body: requestData.body,
          query: requestData.query,
        },
      );

      // Detect ROUTE_NOT_FOUND responses and pass to next middleware
      const body = schmockResponse.body;
      if (
        schmockResponse.status === 404 &&
        body &&
        typeof body === "object" &&
        "code" in body &&
        body.code === ROUTE_NOT_FOUND_CODE
      ) {
        next();
        return;
      }

      // Run response interceptor if provided
      if (beforeResponse) {
        const intercepted = await beforeResponse(schmockResponse, req, res);
        if (intercepted) {
          schmockResponse = intercepted;
        }
      }

      // Convert and send Schmock response
      schmockToExpressResponse(schmockResponse, res);
    } catch (error) {
      // Handle errors based on configuration
      if (error instanceof SchmockError && errorFormatter) {
        const formatted = errorFormatter(error, req);
        res.status(500).json(formatted);
      } else if (passErrorsToNext) {
        next(error);
      } else {
        res.status(500).json({
          error:
            error instanceof Error ? error.message : "Internal Server Error",
          code: error instanceof SchmockError ? error.code : "INTERNAL_ERROR",
        });
      }
    }
  };
}
