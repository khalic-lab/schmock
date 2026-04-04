/// <reference path="../../core/schmock.d.ts" />

import { generateFromSchema } from "@schmock/faker";
import Ajv from "ajv";
import type { JSONSchema7 } from "json-schema";
import { negotiateContentType } from "./content-negotiation.js";
import type { ParsedResponseEntry, SecurityScheme } from "./parser.js";
import type { OnSchemaCallback } from "./plugin.js";
import { parsePreferHeader } from "./prefer.js";
import { isRecord } from "./utils.js";

// Type-safe route config accessors (avoid `as` casts on `[key: string]: unknown`)
function getRouteSecurity(route: Schmock.RouteConfig): string[][] | undefined {
  const value = route["openapi:security"];
  return Array.isArray(value) ? value : undefined;
}

function getRouteResponses(
  route: Schmock.RouteConfig,
): Map<number, ParsedResponseEntry> | undefined {
  const value = route["openapi:responses"];
  return value instanceof Map ? value : undefined;
}

function getRouteRequestBody(
  route: Schmock.RouteConfig,
): JSONSchema7 | undefined {
  const value = route["openapi:requestBody"];
  return isRecord(value) ? value : undefined;
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
      return checkSchemePresence(scheme, context.headers);
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
  headers: Record<string, string>,
): boolean {
  if (scheme.type === "http") {
    const auth = headers.authorization ?? headers.Authorization ?? "";
    if (scheme.scheme === "bearer") {
      return auth.toLowerCase().startsWith("bearer ");
    }
    if (scheme.scheme === "basic") {
      return auth.toLowerCase().startsWith("basic ");
    }
    // Other http schemes — just check authorization exists
    return auth.length > 0;
  }

  if (scheme.type === "apiKey") {
    if (scheme.in === "header" && scheme.name) {
      const headerName = scheme.name.toLowerCase();
      return (headers[headerName] ?? headers[scheme.name] ?? "") !== "";
    }
    // query and cookie api keys can't be checked from headers alone
    // For simplicity, pass through (they'd need query/cookie context)
    return true;
  }

  // oauth2 / openIdConnect — just check for bearer token
  if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
    const auth = headers.authorization ?? headers.Authorization ?? "";
    return auth.toLowerCase().startsWith("bearer ");
  }

  return true;
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
): Schmock.PluginResult | undefined {
  const accept = context.headers.accept ?? context.headers.Accept;
  if (!accept || accept === "*/*") return undefined;

  const responses = getRouteResponses(context.route);
  if (!responses) return undefined;

  // Collect all available content types across responses
  const allContentTypes = new Set<string>();
  for (const entry of responses.values()) {
    if (entry.contentTypes) {
      for (const ct of entry.contentTypes) {
        allContentTypes.add(ct);
      }
    }
  }

  // No content types defined in spec → skip negotiation
  if (allContentTypes.size === 0) return undefined;

  const matched = negotiateContentType(accept, [...allContentTypes]);
  if (!matched) {
    return {
      context,
      response: [
        406,
        {
          error: "Not Acceptable",
          code: "NOT_ACCEPTABLE",
          acceptable: [...allContentTypes],
        },
      ],
    };
  }

  return undefined;
}

const ajv = new Ajv({ allErrors: true });
const schemaCache = new WeakMap<object, import("ajv").ValidateFunction>();

/**
 * Validate request body against the spec's requestBody schema.
 * Returns a PluginResult with 400 status if validation fails, or undefined to continue.
 */
export function validateRequestBody(
  context: Schmock.PluginContext,
): Schmock.PluginResult | undefined {
  const requestBodySchema = getRouteRequestBody(context.route);

  if (!requestBodySchema || context.body === undefined) {
    return undefined;
  }

  let validate = schemaCache.get(requestBodySchema);
  if (!validate) {
    validate = ajv.compile(requestBodySchema);
    schemaCache.set(requestBodySchema, validate);
  }
  if (!validate(context.body)) {
    const errors =
      validate.errors?.map((e) => ({
        path: e.instancePath || "/",
        message: e.message ?? "validation failed",
        keyword: e.keyword,
      })) ?? [];

    return {
      context,
      response: [
        400,
        {
          error: "Request validation failed",
          code: "VALIDATION_ERROR",
          details: errors,
        },
      ],
    };
  }

  return undefined;
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
    const entry = responses.get(prefer.code);
    if (entry) {
      const body = entry.schema
        ? await generateResponseBody(entry.schema, fakerSeed, onSchema, context)
        : {};
      return { context, response: [prefer.code, body] };
    }
  }

  // Prefer: example=name — find a named example across responses
  if (prefer.example !== undefined) {
    for (const [code, entry] of responses) {
      if (entry.examples?.has(prefer.example)) {
        return {
          context,
          response: [code, entry.examples.get(prefer.example)],
        };
      }
    }
  }

  // Prefer: dynamic=true — regenerate from schema
  if (prefer.dynamic) {
    for (const [code, entry] of responses) {
      if (code >= 200 && code < 300 && entry.schema) {
        const body = await generateResponseBody(
          entry.schema,
          fakerSeed,
          onSchema,
          context,
        );
        return { context, response: [code, body] };
      }
    }
  }

  return { context, response };
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
