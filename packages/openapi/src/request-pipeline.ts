/// <reference path="../../core/schmock.d.ts" />

import { isStatusTuple } from "@schmock/core";
import { generateFromSchema } from "@schmock/faker";
import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { JSONSchema7 } from "json-schema";
import { negotiateContentType } from "./content-negotiation.js";
import type { ParsedResponseEntry, SecurityScheme } from "./parser.js";
import type { OnSchemaCallback } from "./plugin.js";
import { parsePreferHeader } from "./prefer.js";
import {
  findResponseEntry,
  findSuccessResponse,
  type ResponseStatusKey,
} from "./response-status.js";
import { isRecord } from "./utils.js";

// Type-safe route config accessors (avoid `as` casts on `[key: string]: unknown`)
function getRouteSecurity(route: Schmock.RouteConfig): string[][] | undefined {
  const value = route["openapi:security"];
  return Array.isArray(value) ? value : undefined;
}

function getRouteResponses(
  route: Schmock.RouteConfig,
): Map<ResponseStatusKey, ParsedResponseEntry> | undefined {
  const value = route["openapi:responses"];
  return value instanceof Map ? value : undefined;
}

function getRouteRequestBody(
  route: Schmock.RouteConfig,
): JSONSchema7 | undefined {
  const value = route["openapi:requestBody"];
  return isRecord(value) ? value : undefined;
}

function isRouteRequestBodyRequired(route: Schmock.RouteConfig): boolean {
  return route["openapi:requestBodyRequired"] === true;
}

/**
 * Validate security requirements for the request.
 * Returns 401 if auth is required and missing/invalid.
 */
export function validateSecurity(
  context: Schmock.PluginContext,
  schemes: Map<string, SecurityScheme>,
  globalSecurity?: string[][],
): Schmock.PluginResult | undefined {
  // Determine applicable security: operation-level overrides global
  const routeSecurity = getRouteSecurity(context.route);
  const security = routeSecurity ?? globalSecurity;

  // No security requirements
  if (!security || security.length === 0) return undefined;

  // Check each OR group — if any group passes, request is authorized
  for (const group of security) {
    // Empty group = public endpoint (security: [{}])
    if (group.length === 0) return undefined;

    // All schemes in the group must pass (AND)
    const allPass = group.every((schemeName) => {
      const scheme = schemes.get(schemeName);
      if (!scheme) return false;
      return checkSchemePresence(scheme, context);
    });

    if (allPass) return undefined;
  }

  // No group passed — build WWW-Authenticate header
  const wwwAuth = buildWwwAuthenticate(security, schemes);
  const headers: Record<string, string> = {};
  if (wwwAuth) {
    headers["www-authenticate"] = wwwAuth;
  }

  return {
    context,
    response: [
      401,
      {
        error: "Unauthorized",
        code: "UNAUTHORIZED",
      },
      headers,
    ],
  };
}

function checkSchemePresence(
  scheme: SecurityScheme,
  context: Schmock.PluginContext,
): boolean {
  if (scheme.type === "http") {
    const auth = getHeader(context.headers, "authorization") ?? "";
    if (scheme.scheme === "bearer") {
      return /^bearer\s+\S+/i.test(auth);
    }
    if (scheme.scheme === "basic") {
      return /^basic\s+\S+/i.test(auth);
    }
    return false;
  }

  if (scheme.type === "apiKey") {
    if (!scheme.name) return false;
    if (scheme.in === "header") {
      return hasValue(getHeader(context.headers, scheme.name));
    }
    if (scheme.in === "query") {
      return hasValue(context.query[scheme.name]);
    }
    if (scheme.in === "cookie") {
      return hasCookieValue(getHeader(context.headers, "cookie"), scheme.name);
    }
    return false;
  }

  if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
    const auth = getHeader(context.headers, "authorization") ?? "";
    return /^bearer\s+\S+/i.test(auth);
  }

  return false;
}

function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === target) return value;
  }
  return undefined;
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function hasCookieValue(
  cookieHeader: string | undefined,
  name: string,
): boolean {
  if (!cookieHeader) return false;

  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const cookieName = segment.slice(0, separator).trim();
    const cookieValue = segment.slice(separator + 1).trim();
    if (cookieName === name) return cookieValue.length > 0;
  }

  return false;
}

function buildWwwAuthenticate(
  security: string[][],
  schemes: Map<string, SecurityScheme>,
): string {
  const challenges: string[] = [];

  for (const group of security) {
    for (const schemeName of group) {
      const scheme = schemes.get(schemeName);
      if (!scheme) continue;

      if (scheme.type === "http" && scheme.scheme === "bearer") {
        if (!challenges.includes("Bearer")) challenges.push("Bearer");
      } else if (scheme.type === "http" && scheme.scheme === "basic") {
        if (!challenges.includes("Basic")) challenges.push("Basic");
      } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
        if (!challenges.includes("Bearer")) challenges.push("Bearer");
      }
    }
  }

  return challenges.join(", ");
}

/**
 * Check Accept header against available content types. Returns 406 if no match.
 */
export function processContentNegotiation(
  context: Schmock.PluginContext,
  defaultStatus?: number,
): Schmock.PluginResult | undefined {
  const accept = context.headers.accept ?? context.headers.Accept;
  if (!accept || accept === "*/*") return undefined;

  const responses = getRouteResponses(context.route);
  if (!responses) return undefined;

  const prefer = parsePreferHeader(getHeader(context.headers, "prefer") ?? "");
  let selectedEntry: ParsedResponseEntry | undefined;
  if (prefer.code !== undefined) {
    selectedEntry = findResponseEntry(responses, prefer.code);
  } else if (prefer.example !== undefined) {
    selectedEntry = [...responses.values()].find(
      (entry) =>
        selectResponseExample(context, entry, prefer.example ?? "").found,
    );
  } else if (defaultStatus !== undefined) {
    selectedEntry = findResponseEntry(responses, defaultStatus);
  } else {
    return undefined;
  }

  const availableContentTypes = selectedEntry?.contentTypes ?? [];

  // No content types defined in spec → skip negotiation
  if (availableContentTypes.length === 0) return undefined;

  const matched = negotiateContentType(accept, availableContentTypes);
  if (!matched) {
    return {
      context,
      response: [
        406,
        {
          error: "Not Acceptable",
          code: "NOT_ACCEPTABLE",
          acceptable: availableContentTypes,
        },
      ],
    };
  }

  return undefined;
}

/**
 * Per-plugin validator context. Each openapi() call creates its own
 * AJV instance and schema cache so that loading multiple specs in the
 * same process can't collide on duplicate \$id values.
 */
export interface BodyValidatorContext {
  ajv: Ajv2020;
  cache: WeakMap<object, ValidateFunction>;
}

export function createBodyValidatorContext(): BodyValidatorContext {
  const ajv = new Ajv2020({
    allErrors: true,
    strictSchema: false,
    strictTypes: false,
  });
  addFormats(ajv);

  return {
    ajv,
    cache: new WeakMap(),
  };
}

/**
 * Validate request body against the spec's requestBody schema.
 * Returns a PluginResult with 400 status if validation fails, or undefined to continue.
 */
export function validateRequestBody(
  context: Schmock.PluginContext,
  validatorCtx: BodyValidatorContext,
): Schmock.PluginResult | undefined {
  const requestBodySchema = getRouteRequestBody(context.route);
  const requestBodyRequired = isRouteRequestBodyRequired(context.route);

  if (context.body === undefined) {
    if (requestBodyRequired) {
      return requestValidationError(context, [
        {
          path: "/",
          message: "request body is required",
          keyword: "required",
        },
      ]);
    }
    return undefined;
  }

  if (!requestBodySchema) {
    return undefined;
  }

  let validate = validatorCtx.cache.get(requestBodySchema);
  if (!validate) {
    try {
      validate = validatorCtx.ajv.compile(requestBodySchema);
      validatorCtx.cache.set(requestBodySchema, validate);
    } catch (error) {
      return requestValidationError(context, [
        {
          path: "/",
          message:
            error instanceof Error
              ? `request schema could not be compiled: ${error.message}`
              : "request schema could not be compiled",
          keyword: "schema",
        },
      ]);
    }
  }
  if (!validate(context.body)) {
    const errors =
      validate.errors?.map((e) => ({
        path: e.instancePath || "/",
        message: e.message ?? "validation failed",
        keyword: e.keyword,
      })) ?? [];

    return requestValidationError(context, errors);
  }

  return undefined;
}

interface ValidationDetail {
  path: string;
  message: string;
  keyword: string;
}

function requestValidationError(
  context: Schmock.PluginContext,
  details: ValidationDetail[],
): Schmock.PluginResult {
  return {
    context,
    response: [
      400,
      {
        error: "Request validation failed",
        code: "VALIDATION_ERROR",
        details,
      },
    ],
  };
}

interface ResponseParts {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  kind: "plain" | "tuple" | "object";
}

function isResponseObject(value: unknown): value is {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
} {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    "body" in value &&
    (value.headers === undefined || isStringRecord(value.headers))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function getResponseParts(response: unknown): ResponseParts {
  if (isStatusTuple(response)) {
    return {
      status: response[0],
      body: response[1],
      headers: response.length === 3 ? response[2] : {},
      kind: "tuple",
    };
  }

  if (isResponseObject(response)) {
    return {
      status: response.status,
      body: response.body,
      headers: response.headers ?? {},
      kind: "object",
    };
  }

  return {
    status: response === null || response === undefined ? 204 : 200,
    body: response === null ? undefined : response,
    headers: {},
    kind: "plain",
  };
}

function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function findDeclaredMediaType(
  entry: ParsedResponseEntry,
  mediaType: string,
): string | undefined {
  const normalized = normalizeMediaType(mediaType);
  return entry.contentTypes?.find(
    (candidate) => normalizeMediaType(candidate) === normalized,
  );
}

function selectResponseMediaType(
  context: Schmock.PluginContext,
  entry: ParsedResponseEntry,
  headers: Record<string, string>,
): string | undefined {
  const explicit = getHeader(headers, "content-type");
  if (explicit) return normalizeMediaType(explicit);

  const accept = getHeader(context.headers, "accept");
  if (accept && entry.contentTypes && entry.contentTypes.length > 0) {
    return negotiateContentType(accept, entry.contentTypes) ?? undefined;
  }

  return entry.contentTypes?.[0];
}

interface AppliedResponseContentType {
  response: unknown;
  rejected: boolean;
}

/** Add the media type selected for the actual response status. */
export function applyResponseContentType(
  context: Schmock.PluginContext,
  response: unknown,
): AppliedResponseContentType {
  const responses = getRouteResponses(context.route);
  if (!responses) return { response, rejected: false };

  const parts = getResponseParts(response);
  const entry = findResponseEntry(responses, parts.status);
  if (!entry) return { response, rejected: false };

  const accept = getHeader(context.headers, "accept");
  const explicitContentType = getHeader(parts.headers, "content-type");
  const availableContentTypes = explicitContentType
    ? [normalizeMediaType(explicitContentType)]
    : (entry.contentTypes ?? []);
  if (
    accept &&
    accept !== "*/*" &&
    availableContentTypes.length > 0 &&
    !negotiateContentType(accept, availableContentTypes)
  ) {
    return {
      response: [
        406,
        {
          error: "Not Acceptable",
          code: "NOT_ACCEPTABLE",
          acceptable: availableContentTypes,
        },
      ],
      rejected: true,
    };
  }

  const mediaType = selectResponseMediaType(context, entry, parts.headers);
  if (!mediaType || getHeader(parts.headers, "content-type")) {
    return { response, rejected: false };
  }

  const headers = { ...parts.headers, "content-type": mediaType };
  if (parts.kind === "object") {
    return {
      response: { status: parts.status, body: parts.body, headers },
      rejected: false,
    };
  }
  return {
    response: [parts.status, parts.body, headers],
    rejected: false,
  };
}

/** Validate a response against the schema for its actual status and media type. */
export function validateResponse(
  context: Schmock.PluginContext,
  response: unknown,
  validatorCtx: BodyValidatorContext,
): Schmock.PluginResult | undefined {
  const responses = getRouteResponses(context.route);
  if (!responses) return undefined;

  const parts = getResponseParts(response);
  const entry = findResponseEntry(responses, parts.status);
  if (!entry) {
    return responseValidationError(context, parts.status, undefined, [
      {
        path: "/",
        message: `status ${parts.status} is not declared by the operation`,
        keyword: "status",
      },
    ]);
  }

  const mediaType = selectResponseMediaType(context, entry, parts.headers);
  let schema = entry.schema;

  if (entry.content && entry.content.size > 0) {
    if (!mediaType) {
      return responseValidationError(context, parts.status, undefined, [
        {
          path: "/",
          message: "response media type could not be determined",
          keyword: "contentType",
        },
      ]);
    }

    const declaredMediaType = findDeclaredMediaType(entry, mediaType);
    const mediaEntry = declaredMediaType
      ? entry.content.get(declaredMediaType)
      : undefined;
    if (!mediaEntry) {
      return responseValidationError(context, parts.status, mediaType, [
        {
          path: "/",
          message: `media type ${mediaType} is not declared for status ${parts.status}`,
          keyword: "contentType",
        },
      ]);
    }
    schema = mediaEntry.schema;
  }

  if (!schema) return undefined;

  let validate = validatorCtx.cache.get(schema);
  try {
    if (!validate) {
      validate = validatorCtx.ajv.compile(schema);
      validatorCtx.cache.set(schema, validate);
    }
  } catch (error) {
    return responseValidationError(context, parts.status, mediaType, [
      {
        path: "/",
        message:
          error instanceof Error
            ? `response schema could not be compiled: ${error.message}`
            : "response schema could not be compiled",
        keyword: "schema",
      },
    ]);
  }

  if (validate(parts.body)) return undefined;

  const details =
    validate.errors?.map((error) => ({
      path: error.instancePath || "/",
      message: error.message ?? "validation failed",
      keyword: error.keyword,
    })) ?? [];
  return responseValidationError(context, parts.status, mediaType, details);
}

function responseValidationError(
  context: Schmock.PluginContext,
  status: number,
  mediaType: string | undefined,
  details: ValidationDetail[],
): Schmock.PluginResult {
  return {
    context,
    response: [
      500,
      {
        error: "Response validation failed",
        code: "RESPONSE_VALIDATION_ERROR",
        status,
        mediaType,
        details,
      },
    ],
  };
}

/**
 * Handle Prefer header directives: code=N, example=name, dynamic=true
 */
export async function processPreferHeader(
  context: Schmock.PluginContext,
  response: unknown,
  fakerSeed?: number,
  onSchema?: OnSchemaCallback,
): Promise<Schmock.PluginResult> {
  const preferValue = context.headers.prefer ?? context.headers.Prefer;
  if (!preferValue) {
    return { context, response };
  }

  const prefer = parsePreferHeader(preferValue);
  const responses = getRouteResponses(context.route);

  if (!responses) {
    return { context, response };
  }

  // Prefer: code=N — return the response for that status code
  if (prefer.code !== undefined) {
    const entry = findResponseEntry(responses, prefer.code);
    if (entry) {
      const schema = selectResponseSchema(context, entry);
      const body = schema
        ? await generateResponseBody(schema, fakerSeed, onSchema, context)
        : prefer.code === 204
          ? undefined
          : {};
      return { context, response: [prefer.code, body] };
    }
  }

  // Prefer: example=name — find a named example across responses
  if (prefer.example !== undefined) {
    for (const [code, entry] of responses) {
      const selectedExample = selectResponseExample(
        context,
        entry,
        prefer.example,
      );
      if (typeof code === "number" && selectedExample.found) {
        return {
          context,
          response: [code, selectedExample.value],
        };
      }
    }
  }

  // Prefer: dynamic=true — regenerate from schema
  if (prefer.dynamic) {
    const success = findSuccessResponse(responses);
    if (success) {
      const [code, entry] = success;
      const schema = selectResponseSchema(context, entry);
      if (!schema)
        return { context, response: [code, code === 204 ? undefined : {}] };
      const body = await generateResponseBody(
        schema,
        fakerSeed,
        onSchema,
        context,
      );
      return { context, response: [code, body] };
    }
  }

  return { context, response };
}

function selectResponseSchema(
  context: Schmock.PluginContext,
  entry: ParsedResponseEntry,
): JSONSchema7 | undefined {
  const mediaType = selectResponseMediaType(context, entry, {});
  if (entry.content && entry.content.size > 0) {
    const declared = mediaType
      ? findDeclaredMediaType(entry, mediaType)
      : undefined;
    return declared ? entry.content.get(declared)?.schema : undefined;
  }

  return entry.schema;
}

type SelectedResponseExample =
  | { found: true; value: unknown }
  | { found: false };

function selectResponseExample(
  context: Schmock.PluginContext,
  entry: ParsedResponseEntry,
  name: string,
): SelectedResponseExample {
  if (entry.content && entry.content.size > 0) {
    const mediaType = selectResponseMediaType(context, entry, {});
    const declared = mediaType
      ? findDeclaredMediaType(entry, mediaType)
      : undefined;
    const examples = declared
      ? entry.content.get(declared)?.examples
      : undefined;
    return examples?.has(name)
      ? { found: true, value: examples.get(name) }
      : { found: false };
  }

  return entry.examples?.has(name)
    ? { found: true, value: entry.examples.get(name) }
    : { found: false };
}

async function generateResponseBody(
  schema: JSONSchema7,
  seed?: number,
  onSchema?: OnSchemaCallback,
  context?: Schmock.PluginContext,
): Promise<unknown> {
  let finalSchema = schema;
  if (onSchema && context) {
    const patched = onSchema(finalSchema, context);
    if (patched) finalSchema = patched;
  }
  try {
    return await generateFromSchema({ schema: finalSchema, seed });
  } catch (error) {
    console.warn(
      "[@schmock/openapi] Response body generation failed:",
      error instanceof Error ? error.message : error,
    );
    return {};
  }
}
