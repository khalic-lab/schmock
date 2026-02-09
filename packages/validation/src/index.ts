/// <reference path="../../core/schmock.d.ts" />

import { isStatusTuple } from "@schmock/core";
import Ajv, { type ValidateFunction } from "ajv";
import type { JSONSchema7 } from "json-schema";

interface ValidationRules {
  request?: {
    body?: JSONSchema7;
    query?: JSONSchema7;
    headers?: JSONSchema7;
  };
  response?: {
    body?: JSONSchema7;
  };
}

interface ValidationPluginOptions extends ValidationRules {
  /** Custom status code for request validation failures (default: 400) */
  requestErrorStatus?: number;
  /** Custom status code for response validation failures (default: 500) */
  responseErrorStatus?: number;
}

export function validationPlugin(
  options: ValidationPluginOptions,
): Schmock.Plugin {
  const requestErrorStatus = options.requestErrorStatus ?? 400;
  const responseErrorStatus = options.responseErrorStatus ?? 500;

  // Pre-compile all validators at plugin creation time
  const ajv = new Ajv({ allErrors: true });
  const validators: {
    requestBody?: ValidateFunction;
    requestQuery?: ValidateFunction;
    requestHeaders?: ValidateFunction;
    responseBody?: ValidateFunction;
  } = {};

  if (options.request?.body) {
    validators.requestBody = ajv.compile(options.request.body);
  }
  if (options.request?.query) {
    validators.requestQuery = ajv.compile(options.request.query);
  }
  if (options.request?.headers) {
    validators.requestHeaders = ajv.compile(options.request.headers);
  }
  if (options.response?.body) {
    validators.responseBody = ajv.compile(options.response.body);
  }

  return {
    name: "validation",
    version: "1.0.0",

    process(
      context: Schmock.PluginContext,
      response?: unknown,
    ): Schmock.PluginResult {
      // Validate request body (skip when no body provided, e.g. GET requests)
      if (validators.requestBody && context.body !== undefined) {
        if (!validators.requestBody(context.body)) {
          return {
            context,
            response: {
              status: requestErrorStatus,
              body: {
                error: "Request validation failed",
                code: "REQUEST_VALIDATION_ERROR",
                details: validators.requestBody.errors,
              },
            },
          };
        }
      }

      // Validate request query parameters
      if (validators.requestQuery && context.query) {
        if (!validators.requestQuery(context.query)) {
          return {
            context,
            response: {
              status: requestErrorStatus,
              body: {
                error: "Query parameter validation failed",
                code: "QUERY_VALIDATION_ERROR",
                details: validators.requestQuery.errors,
              },
            },
          };
        }
      }

      // Validate request headers
      if (validators.requestHeaders && context.headers) {
        // Lowercase all header names for comparison
        const normalizedHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(context.headers)) {
          normalizedHeaders[key.toLowerCase()] = value;
        }
        if (!validators.requestHeaders(normalizedHeaders)) {
          return {
            context,
            response: {
              status: requestErrorStatus,
              body: {
                error: "Header validation failed",
                code: "HEADER_VALIDATION_ERROR",
                details: validators.requestHeaders.errors,
              },
            },
          };
        }
      }

      // Validate response body (if response exists)
      if (validators.responseBody && response !== undefined) {
        // Unwrap tuple responses: [status, body] or [status, body, headers]
        const responseBody = isStatusTuple(response) ? response[1] : response;

        if (!validators.responseBody(responseBody)) {
          return {
            context,
            response: {
              status: responseErrorStatus,
              body: {
                error: "Response validation failed",
                code: "RESPONSE_VALIDATION_ERROR",
                details: validators.responseBody.errors,
              },
            },
          };
        }
      }

      return { context, response };
    },
  };
}
