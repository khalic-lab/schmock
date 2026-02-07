/// <reference path="../../../types/schmock.d.ts" />

import Ajv from "ajv";
import type { JSONSchema7 } from "json-schema";

const ajv = new Ajv({ allErrors: true });

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

  return {
    name: "validation",
    version: "1.0.0",

    process(
      context: Schmock.PluginContext,
      response?: any,
    ): Schmock.PluginResult {
      // Validate request body
      if (options.request?.body && context.body !== undefined) {
        const validate = ajv.compile(options.request.body);
        if (!validate(context.body)) {
          return {
            context,
            response: {
              status: requestErrorStatus,
              body: {
                error: "Request validation failed",
                code: "REQUEST_VALIDATION_ERROR",
                details: validate.errors,
              },
            },
          };
        }
      }

      // Validate request query parameters
      if (options.request?.query && context.query) {
        const validate = ajv.compile(options.request.query);
        if (!validate(context.query)) {
          return {
            context,
            response: {
              status: requestErrorStatus,
              body: {
                error: "Query parameter validation failed",
                code: "QUERY_VALIDATION_ERROR",
                details: validate.errors,
              },
            },
          };
        }
      }

      // Validate request headers
      if (options.request?.headers && context.headers) {
        const validate = ajv.compile(options.request.headers);
        // Lowercase all header names for comparison
        const normalizedHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(context.headers)) {
          normalizedHeaders[key.toLowerCase()] = value;
        }
        if (!validate(normalizedHeaders)) {
          return {
            context,
            response: {
              status: requestErrorStatus,
              body: {
                error: "Header validation failed",
                code: "HEADER_VALIDATION_ERROR",
                details: validate.errors,
              },
            },
          };
        }
      }

      // Validate response body (if response exists)
      if (options.response?.body && response !== undefined) {
        // Unwrap tuple responses: [status, body] or [status, body, headers]
        const isTuple =
          Array.isArray(response) && typeof response[0] === "number";
        const responseBody = isTuple ? response[1] : response;

        const validate = ajv.compile(options.response.body);
        if (!validate(responseBody)) {
          return {
            context,
            response: {
              status: responseErrorStatus,
              body: {
                error: "Response validation failed",
                code: "RESPONSE_VALIDATION_ERROR",
                details: validate.errors,
              },
            },
          };
        }
      }

      return { context, response };
    },
  };
}
