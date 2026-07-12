/// <reference path="../../core/schmock.d.ts" />

import { isStatusTuple } from "@schmock/core";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { JSONSchema7 } from "json-schema";
import { version as packageVersion } from "../package.json";

interface ValidationRules {
  request?: {
    body?: JSONSchema7;
    /** Reject an absent body before the route generator executes. */
    bodyRequired?: boolean;
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

function isStructuredResponse(
  value: unknown,
): value is { status: number; body: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "number" &&
    "body" in value
  );
}

function getResponseBody(response: unknown): unknown {
  if (isStatusTuple(response)) return response[1];
  if (isStructuredResponse(response)) return response.body;
  return response;
}

export function validationPlugin(
  options: ValidationPluginOptions,
): Schmock.Plugin {
  const requestErrorStatus = options.requestErrorStatus ?? 400;
  const responseErrorStatus = options.responseErrorStatus ?? 500;

  // Pre-compile all validators at plugin creation time
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
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
    version: packageVersion,

    beforeRequest(context: Schmock.PluginContext): Schmock.PluginResult {
      if (context.body === undefined && options.request?.bodyRequired) {
        return {
          context,
          response: {
            status: requestErrorStatus,
            body: {
              error: "Request validation failed",
              code: "REQUEST_VALIDATION_ERROR",
              details: [
                {
                  instancePath: "",
                  keyword: "required",
                  message: "request body is required",
                },
              ],
            },
          },
        };
      }

      // Optional bodies are skipped when absent, but every supplied body is
      // validated before route code can observe or mutate state from it.
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

      return { context };
    },

    process(
      context: Schmock.PluginContext,
      response?: unknown,
    ): Schmock.PluginResult {
      if (context.requestShortCircuited === true) {
        return { context, response };
      }

      // Validate the semantic response body, including explicit no-content
      // results. Supported tuple and structured response forms carry metadata
      // around the body and must not be validated as the payload itself.
      if (validators.responseBody) {
        const responseBody = getResponseBody(response);

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
