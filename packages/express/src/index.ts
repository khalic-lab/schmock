/// <reference path="../../../types/schmock.d.ts" />

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { MockInstance } from "@schmock/builder";

/**
 * Convert Schmock response to Express response
 */
function schmockToExpressResponse(
  schmockResponse: { status: number; body: any; headers: Record<string, string> },
  res: Response
): void {
  // Set status code
  if (schmockResponse.status) {
    res.status(schmockResponse.status);
  }

  // Set headers
  if (schmockResponse.headers) {
    Object.entries(schmockResponse.headers).forEach(([key, value]) => {
      if (typeof value === 'string') {
        res.set(key, value);
      }
    });
  }

  // Send body
  if (schmockResponse.body !== undefined) {
    if (typeof schmockResponse.body === 'string') {
      res.send(schmockResponse.body);
    } else {
      res.json(schmockResponse.body);
    }
  } else {
    res.end();
  }
}

/**
 * Convert a Schmock mock instance to Express middleware
 */
export function toExpress(mock: MockInstance): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Handle request with Schmock
      const schmockResponse = await mock.handle(
        req.method as Schmock.HttpMethod,
        req.path,
        {
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([key, value]) => [
              key, 
              Array.isArray(value) ? value[0] : value || ""
            ])
          ),
          body: req.body,
          query: req.query as Record<string, string>
        }
      );
      
      if (schmockResponse) {
        // Convert and send Schmock response
        schmockToExpressResponse(schmockResponse, res);
      } else {
        // No matching route, pass to next middleware
        next();
      }
    } catch (error) {
      // Pass errors to Express error handler
      next(error);
    }
  };
}

export default toExpress;