import type * as Schmock from "@schmock/core";
import { toHttpMethod } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import type { OpenAPI } from "openapi-types";
import { normalizeSchema } from "./normalizer.js";
import type {
  ParsedCallback,
  ParsedParameter,
  ParsedPath,
  ParsedResponseContent,
  ParsedResponseEntry,
  SecurityScheme,
} from "./parser.js";
import {
  parseResponseStatusKey,
  type ResponseStatusKey,
} from "./response-status.js";
import { isRecord, normalizeMediaType } from "./utils.js";

/*
 * Reading one operation's contract out of a dereferenced document: its
 * parameters, request body, responses and their headers, security schemes and
 * requirements, and callbacks. `parser.ts` walks the paths and calls these.
 */

export const HTTP_METHOD_KEYS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
]);

type SchemaDirection = "request" | "response";
type SchemaNormalizer = (
  schema: Record<string, unknown>,
  direction: SchemaDirection,
) => JSONSchema7;

/**
 * What every extractor needs to know about the document being parsed. Built
 * once per `parseSpec` call and passed as one argument, in place of a dialect
 * flag, the normalizer and the warning sink threaded through each signature.
 */
export interface ParseContext {
  /** Swagger 2.0 or OpenAPI 3.x: where schemas, media types and schemes live. */
  dialect: "swagger2" | "oas3";
  /** Normalizes a schema, caching by source identity per direction. */
  normalize: SchemaNormalizer;
  /** Collects what was skipped rather than failed on (`ParsedSpec.warnings`). */
  warnings: string[];
  /** Swagger 2.0 root `consumes`, for operations that declare none. */
  rootConsumes?: string[];
  /** Swagger 2.0 root `produces`, for operations that declare none. */
  rootProduces?: string[];
}

export function createSchemaNormalizer(): SchemaNormalizer {
  // Dereferenced component refs share identity. Reusing their normalized form
  // avoids cloning large schema graphs once per operation and media type.
  const requestSchemas = new WeakMap<object, JSONSchema7>();
  const responseSchemas = new WeakMap<object, JSONSchema7>();

  return (schema, direction) => {
    const schemas = direction === "request" ? requestSchemas : responseSchemas;
    const cached = schemas.get(schema);
    if (cached) return cached;

    const normalized = normalizeSchema(schema, direction);
    schemas.set(schema, normalized);
    return normalized;
  };
}

export function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((v): v is string => typeof v === "string");
  return entries.length > 0 ? entries : undefined;
}

export function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

interface InternalParameter {
  name: string;
  in: "path" | "query" | "header" | "body";
  required: boolean;
  schema?: JSONSchema7;
}

function isValidParamLocation(
  location: string,
  dialect: ParseContext["dialect"],
): location is "path" | "query" | "header" | "body" {
  const validLocations =
    dialect === "swagger2"
      ? ["path", "query", "header", "body"]
      : ["path", "query", "header"];
  return validLocations.includes(location);
}

export function isNotBodyParam(
  param: InternalParameter,
): param is ParsedParameter {
  return param.in !== "body";
}

/**
 * The parameters declared at one level (a path item or an operation), with
 * Swagger 2.0's `body` parameter kept for {@link extractRequestBody}.
 * `params` is the raw `parameters` value; anything but an array declares none.
 */
export function extractParameters(
  params: unknown,
  ctx: ParseContext,
  label: string,
): InternalParameter[] {
  if (!Array.isArray(params)) return [];

  return params
    .filter((p): p is Record<string, unknown> => isRecord(p))
    .map((p): InternalParameter | null => {
      const location = getString(p.in);
      if (!location || !isValidParamLocation(location, ctx.dialect)) {
        ctx.warnings.push(
          `${label}: parameter "${getString(p.name) ?? "?"}" has unsupported location "${location ?? "(none)"}", skipped`,
        );
        return null;
      }

      let schema: JSONSchema7 | undefined;
      if (ctx.dialect === "swagger2") {
        // Swagger 2.0: schema is inline on the parameter (type, format, etc.)
        if (location === "body") {
          schema = isRecord(p.schema)
            ? ctx.normalize(p.schema, "request")
            : undefined;
        } else {
          schema = p.type
            ? ctx.normalize(
                { type: p.type, format: p.format, enum: p.enum },
                "request",
              )
            : undefined;
        }
      } else {
        // OpenAPI 3.x: schema is nested
        schema = isRecord(p.schema)
          ? ctx.normalize(p.schema, "request")
          : undefined;
      }

      const name = getString(p.name);
      if (!name) {
        ctx.warnings.push(`${label}: parameter without a name, skipped`);
        return null;
      }

      return {
        name,
        in: location,
        required: getBoolean(p.required, false),
        schema,
      };
    })
    .filter((p): p is InternalParameter => p !== null);
}

export function mergeParameters(
  pathLevel: InternalParameter[],
  operationLevel: InternalParameter[],
): InternalParameter[] {
  const merged = new Map<string, InternalParameter>();

  // Path-level first
  for (const p of pathLevel) {
    merged.set(`${p.in}:${p.name}`, p);
  }
  // Operation-level overwrites
  for (const p of operationLevel) {
    merged.set(`${p.in}:${p.name}`, p);
  }

  return [...merged.values()];
}

/** An operation's request-body contract, as `ParsedPath` carries it. */
type ExtractedRequestBody = Pick<
  ParsedPath,
  "requestBody" | "requestBodyRequired" | "requestContent"
>;

/**
 * The request body an operation declares: a Swagger 2.0 `body` parameter
 * (among `params`, the merged path and operation parameters) accepted as the
 * `consumes` media types, or an OpenAPI 3.x `requestBody`.
 */
export function extractRequestBody(
  operation: Record<string, unknown>,
  params: InternalParameter[],
  ctx: ParseContext,
): ExtractedRequestBody {
  if (ctx.dialect === "swagger2") {
    const requestBody = extractSwagger2RequestBody(params);
    return {
      requestBody,
      requestBodyRequired:
        params.find((parameter) => parameter.in === "body")?.required ?? false,
      requestContent: buildSwagger2RequestContent(
        getStringArray(operation.consumes) ?? ctx.rootConsumes,
        requestBody,
      ),
    };
  }

  const rawRequestBody = isRecord(operation.requestBody)
    ? operation.requestBody
    : undefined;
  return {
    requestBody: extractOpenApi3RequestBody(rawRequestBody, ctx.normalize),
    requestBodyRequired: rawRequestBody
      ? getBoolean(rawRequestBody.required, false)
      : false,
    requestContent: extractOpenApi3RequestContent(
      rawRequestBody,
      ctx.normalize,
    ),
  };
}

function extractSwagger2RequestBody(
  params: InternalParameter[],
): JSONSchema7 | undefined {
  const bodyParam = params.find((p) => p.in === "body");
  return bodyParam?.schema;
}

function extractOpenApi3RequestBody(
  requestBody: Record<string, unknown> | undefined,
  normalizeParsedSchema: SchemaNormalizer,
): JSONSchema7 | undefined {
  if (!requestBody) return undefined;

  const content = isRecord(requestBody.content)
    ? requestBody.content
    : undefined;
  if (!content) return undefined;

  const jsonEntry = findJsonContent(content);
  if (!jsonEntry) return undefined;

  const schema = isRecord(jsonEntry.schema) ? jsonEntry.schema : undefined;
  if (!schema) return undefined;

  return normalizeParsedSchema(schema, "request");
}

/**
 * Every declared request media type with its own schema.
 *
 * Distinct from {@link extractOpenApi3RequestBody}, which collapses the whole
 * `content` map to one JSON-ish schema — the reason a JSON+XML operation used
 * to validate an XML body against the JSON contract. Distinct source schemas
 * remain distinct; repeated refs share one normalized identity per direction
 * and compile once in the pipeline's validator cache.
 */
function extractOpenApi3RequestContent(
  requestBody: Record<string, unknown> | undefined,
  normalizeParsedSchema: SchemaNormalizer,
): Map<string, JSONSchema7 | undefined> | undefined {
  const content = isRecord(requestBody?.content)
    ? requestBody.content
    : undefined;
  if (!content) return undefined;

  const result = new Map<string, JSONSchema7 | undefined>();
  for (const [mediaType, entry] of Object.entries(content)) {
    const schema =
      isRecord(entry) && isRecord(entry.schema)
        ? normalizeParsedSchema(entry.schema, "request")
        : undefined;
    result.set(normalizeMediaType(mediaType), schema);
  }

  return result.size > 0 ? result : undefined;
}

/**
 * Swagger 2.0 has one body parameter and a list of media types it may arrive
 * as, so every declared type maps to that same schema. No `consumes` means no
 * declared surface at all: stay lenient and never answer 415.
 */
function buildSwagger2RequestContent(
  consumes: string[] | undefined,
  requestBody: JSONSchema7 | undefined,
): Map<string, JSONSchema7 | undefined> | undefined {
  if (!consumes || consumes.length === 0) return undefined;

  const result = new Map<string, JSONSchema7 | undefined>();
  for (const mediaType of consumes) {
    result.set(normalizeMediaType(mediaType), requestBody);
  }
  return result.size > 0 ? result : undefined;
}

/**
 * The responses an operation declares, keyed by status. Swagger 2.0 media
 * types come from the operation's `produces`, else the document root's.
 */
export function extractResponses(
  operation: Record<string, unknown>,
  ctx: ParseContext,
  label: string,
): Map<ResponseStatusKey, ParsedResponseEntry> {
  const result = new Map<ResponseStatusKey, ParsedResponseEntry>();

  const responses = isRecord(operation.responses)
    ? operation.responses
    : undefined;
  if (!responses) return result;

  const produces = getStringArray(operation.produces) ?? ctx.rootProduces;

  for (const [statusCode, response] of Object.entries(responses)) {
    if (!isRecord(response)) {
      ctx.warnings.push(
        `${label}: response "${statusCode}" is not an object, skipped`,
      );
      continue;
    }

    const code = parseResponseStatusKey(statusCode);
    if (code === undefined) {
      ctx.warnings.push(
        `${label}: response status key "${statusCode}" is not recognized, skipped`,
      );
      continue;
    }

    const description = getString(response.description) ?? "";

    let schema: JSONSchema7 | undefined;
    let examples: Map<string, unknown> | undefined;
    let contentTypes: string[] | undefined;
    let responseContent: Map<string, ParsedResponseContent> | undefined;

    if (ctx.dialect === "swagger2") {
      if (isRecord(response.schema)) {
        schema = ctx.normalize(response.schema, "response");
      }
      // Swagger 2.0 single example
      if (response.examples !== undefined && isRecord(response.examples)) {
        examples = new Map();
        for (const [key, value] of Object.entries(response.examples)) {
          examples.set(key, value);
        }
      }
      // `produces` gives Swagger 2.0 the media types negotiation needs.
      // Deliberately NOT a `content` map: `validateResponse` treats a populated
      // `content` as the authoritative per-media-type contract, and Swagger 2.0
      // declares exactly one schema for all of them.
      if (produces && produces.length > 0) {
        contentTypes = produces.map(normalizeMediaType);
      }
    } else {
      const content = isRecord(response.content) ? response.content : undefined;
      if (content) {
        contentTypes = Object.keys(content);
        responseContent = extractResponseContent(content, ctx.normalize);
        const jsonEntry = findJsonContent(content);
        if (jsonEntry && isRecord(jsonEntry.schema)) {
          schema = ctx.normalize(jsonEntry.schema, "response");
        }
        // OAS3 named examples
        if (jsonEntry) {
          examples = extractExamples(jsonEntry);
        }
      }
    }

    const headers = extractResponseHeaders(response, ctx);
    result.set(code, {
      schema,
      description,
      headers,
      examples,
      contentTypes,
      content: responseContent,
    });
  }

  return result;
}

function extractResponseContent(
  content: Record<string, unknown>,
  normalizeParsedSchema: SchemaNormalizer,
): Map<string, ParsedResponseContent> | undefined {
  const result = new Map<string, ParsedResponseContent>();

  for (const [mediaType, entryRaw] of Object.entries(content)) {
    if (!isRecord(entryRaw)) continue;

    const schema = isRecord(entryRaw.schema)
      ? normalizeParsedSchema(entryRaw.schema, "response")
      : undefined;
    const examples = extractExamples(entryRaw);
    result.set(mediaType, { schema, examples });
  }

  return result.size > 0 ? result : undefined;
}

function extractExamples(
  contentEntry: Record<string, unknown>,
): Map<string, unknown> | undefined {
  const result = new Map<string, unknown>();

  // Single `example` value
  if ("example" in contentEntry && contentEntry.example !== undefined) {
    result.set("default", contentEntry.example);
  }

  // Named `examples` map
  if (isRecord(contentEntry.examples)) {
    for (const [name, exampleObj] of Object.entries(contentEntry.examples)) {
      if (isRecord(exampleObj) && "value" in exampleObj) {
        result.set(name, exampleObj.value);
      }
    }
  }

  return result.size > 0 ? result : undefined;
}

function extractResponseHeaders(
  response: Record<string, unknown>,
  ctx: ParseContext,
): Record<string, Schmock.ResponseHeaderDef> | undefined {
  const rawHeaders = isRecord(response.headers) ? response.headers : undefined;
  if (!rawHeaders) return undefined;

  const headers: Record<string, Schmock.ResponseHeaderDef> = {};
  let hasHeaders = false;

  for (const [name, headerRaw] of Object.entries(rawHeaders)) {
    if (!isRecord(headerRaw)) continue;

    const desc = getString(headerRaw.description) ?? "";
    let headerSchema: JSONSchema7 | undefined;

    if (ctx.dialect === "swagger2") {
      // Swagger 2.0: type/format/enum are inline on the header
      if (headerRaw.type) {
        headerSchema = ctx.normalize(
          {
            type: headerRaw.type,
            format: headerRaw.format,
            enum: headerRaw.enum,
          },
          "response",
        );
      }
    } else {
      // OpenAPI 3.x: schema is nested
      if (isRecord(headerRaw.schema)) {
        headerSchema = ctx.normalize(headerRaw.schema, "response");
      }
    }

    headers[name] = { schema: headerSchema, description: desc };
    hasHeaders = true;
  }

  return hasHeaders ? headers : undefined;
}

/**
 * Find the best JSON-like content type entry from an OpenAPI content map.
 * Prefers application/json, then any *+json or *json* type.
 */
function findJsonContent(
  content: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // Prefer exact application/json
  if (isRecord(content["application/json"])) {
    return content["application/json"];
  }
  // Try any JSON-like content type (application/problem+json, etc.)
  for (const [type, value] of Object.entries(content)) {
    if (type.includes("json") && isRecord(value)) {
      return value;
    }
  }
  // Fallback to first content type
  return Object.values(content).find((v): v is Record<string, unknown> =>
    isRecord(v),
  );
}

export function extractSecuritySchemes(
  api: OpenAPI.Document,
  ctx: ParseContext,
): Map<string, SecurityScheme> | undefined {
  const schemes = new Map<string, SecurityScheme>();

  let rawSchemes: Record<string, unknown> | undefined;

  if (ctx.dialect === "swagger2") {
    // Swagger 2.0: securityDefinitions
    if ("securityDefinitions" in api) {
      const defs = api.securityDefinitions;
      if (isRecord(defs)) {
        rawSchemes = defs;
      }
    }
  } else {
    // OpenAPI 3.x: components.securitySchemes
    if ("components" in api && isRecord(api.components)) {
      const comp = api.components;
      if ("securitySchemes" in comp && isRecord(comp.securitySchemes)) {
        rawSchemes = comp.securitySchemes;
      }
    }
  }

  if (!rawSchemes) return schemes.size > 0 ? schemes : undefined;

  for (const [name, schemeDef] of Object.entries(rawSchemes)) {
    if (!isRecord(schemeDef)) continue;

    const type = getString(schemeDef.type);
    if (!type) continue;

    const scheme = toSecurityScheme(type, schemeDef, ctx.dialect);
    if (scheme) {
      schemes.set(name, scheme);
    }
  }

  return schemes.size > 0 ? schemes : undefined;
}

const SECURITY_SCHEME_TYPES = new Set([
  "apiKey",
  "http",
  "oauth2",
  "openIdConnect",
]);
const API_KEY_LOCATIONS = new Set(["header", "query", "cookie"]);

function toSecurityScheme(
  type: string,
  def: Record<string, unknown>,
  dialect: ParseContext["dialect"],
): SecurityScheme | undefined {
  // Handle Swagger 2.0 basic auth
  if (dialect === "swagger2" && type === "basic") {
    return { type: "http", scheme: "basic" };
  }

  if (!SECURITY_SCHEME_TYPES.has(type)) return undefined;

  const scheme: SecurityScheme = {
    type:
      type === "apiKey"
        ? "apiKey"
        : type === "http"
          ? "http"
          : type === "oauth2"
            ? "oauth2"
            : "openIdConnect",
  };

  if (type === "apiKey") {
    const location = getString(def.in);
    if (location && API_KEY_LOCATIONS.has(location)) {
      scheme.in =
        location === "header"
          ? "header"
          : location === "query"
            ? "query"
            : "cookie";
    }
    scheme.name = getString(def.name);
  } else if (type === "http") {
    scheme.scheme = getString(def.scheme)?.toLowerCase();
  }

  return scheme;
}

/**
 * Extract security requirements from a security array.
 * Each entry in the array is an OR condition (any can match).
 * Each entry is an object where keys are scheme names (AND within).
 * Returns array of string arrays: [[schemeA, schemeB], [schemeC]] means (A AND B) OR C.
 * An empty array entry means "no auth required" (public).
 */
export function extractSecurityRequirements(
  security: unknown[] | undefined,
): string[][] | undefined {
  if (!security) return undefined;
  if (security.length === 0) return [];

  const result: string[][] = [];
  for (const entry of security) {
    if (!isRecord(entry)) continue;
    result.push(Object.keys(entry));
  }

  return result.length > 0 ? result : undefined;
}

/**
 * Extract an operation's OAS3 callbacks. Swagger 2.0 has none.
 * Callbacks structure: { callbackName: { urlExpression: { method: { requestBody, ... } } } }
 */
export function extractCallbacks(
  operation: Record<string, unknown>,
  ctx: ParseContext,
): ParsedCallback[] | undefined {
  if (ctx.dialect !== "oas3" || !isRecord(operation.callbacks)) {
    return undefined;
  }

  const result: ParsedCallback[] = [];

  for (const callbackObj of Object.values(operation.callbacks)) {
    if (!isRecord(callbackObj)) continue;

    // Each key is a URL expression like "{$request.body#/callbackUrl}"
    for (const [urlExpression, pathItem] of Object.entries(callbackObj)) {
      if (!isRecord(pathItem)) continue;

      for (const methodKey of Object.keys(pathItem)) {
        if (!HTTP_METHOD_KEYS.has(methodKey)) continue;

        const callbackOperation = pathItem[methodKey];
        if (!isRecord(callbackOperation)) continue;

        let reqBody: JSONSchema7 | undefined;
        if (isRecord(callbackOperation.requestBody)) {
          reqBody = extractOpenApi3RequestBody(
            callbackOperation.requestBody,
            ctx.normalize,
          );
        }

        result.push({
          urlExpression,
          method: toHttpMethod(methodKey.toUpperCase()),
          requestBody: reqBody,
        });
      }
    }
  }

  return result.length > 0 ? result : undefined;
}
