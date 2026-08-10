import type * as Schmock from "@schmock/core";
import { isStatusTuple } from "@schmock/core";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { JSONSchema7 } from "json-schema";
import { version as packageVersion } from "../package.json";

export interface ValidationRules {
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

export interface ValidationPluginOptions extends ValidationRules {
  /** Custom status code for request validation failures (default: 400) */
  requestErrorStatus?: number;
  /** Custom status code for response validation failures (default: 500) */
  responseErrorStatus?: number;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * Mirrors `isResponseObject` in `@schmock/core`'s response parser. The two
 * guards must agree exactly: whenever core refuses to unwrap an envelope it
 * delivers the whole object as the body, so a looser guard here would validate
 * a payload that never reaches the transport.
 */
function isStructuredResponse(
  value: unknown,
): value is { status: number; body: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "number" &&
    "body" in value &&
    (!("headers" in value) ||
      value.headers === undefined ||
      isStringRecord(value.headers))
  );
}

function getResponseBody(response: unknown): unknown {
  if (isStatusTuple(response)) return response[1];
  if (isStructuredResponse(response)) return response.body;
  return response;
}

function createAjv(): Ajv {
  // `ownProperties` keeps validation aligned with the transport: JSON.stringify
  // emits own enumerable properties only, so inherited members must neither
  // satisfy `required` nor trip `additionalProperties`.
  const ajv = new Ajv({ allErrors: true, ownProperties: true });
  // Schemas produced by @schmock/openapi carry schmock generation markers.
  // Draft-07 Ajv defaults to strictSchema:true and would throw
  // "strict mode: unknown keyword" at compile time on any of them.
  ajv.addVocabulary(["schmockNullable", "schmockTrueProbability"]);
  addFormats(ajv);
  return ajv;
}

export function validationPlugin(
  options: ValidationPluginOptions,
): Schmock.Plugin {
  const requestErrorStatus = options.requestErrorStatus ?? 400;
  const responseErrorStatus = options.responseErrorStatus ?? 500;

  // Pre-compile all validators at plugin creation time. Each slot gets its own
  // Ajv registry so request and response schemas may share an `$id` — a common
  // shape when both describe the same resource — without colliding.
  const validators: {
    requestBody?: ValidateFunction;
    requestQuery?: ValidateFunction;
    requestHeaders?: ValidateFunction;
    responseBody?: ValidateFunction;
  } = {};

  if (options.request?.body) {
    validators.requestBody = createAjv().compile(options.request.body);
  }
  if (options.request?.query) {
    validators.requestQuery = createAjv().compile(options.request.query);
  }
  if (options.request?.headers) {
    validators.requestHeaders = createAjv().compile(options.request.headers);
  }
  if (options.response?.body) {
    validators.responseBody = createAjv().compile(options.response.body);
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
        // Lowercase all header names for comparison. `Object.fromEntries`
        // defines each key as an own data property, so a header literally named
        // `__proto__` lands in the record instead of silently hitting
        // `Object.prototype`'s setter — plain assignment would drop it and let
        // it escape `additionalProperties: false`. The prototype is retained to
        // match how core builds `context.headers`.
        const normalizedHeaders: Record<string, string> = Object.fromEntries(
          Object.entries(context.headers).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        );
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
      //
      // "Semantic" means the value the generator and plugins produced, not the
      // serialized transport payload: core applies content-type conversion
      // (e.g. text/plain stringification) after the pipeline, so a `text/plain`
      // route validated against an object schema is delivered as a string.
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
