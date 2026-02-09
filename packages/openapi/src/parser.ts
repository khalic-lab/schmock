/// <reference path="../../core/schmock.d.ts" />

import SwaggerParser from "@apidevtools/swagger-parser";
import { toHttpMethod } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import type { OpenAPI } from "openapi-types";
import { normalizeSchema } from "./normalizer.js";
import { isRecord } from "./utils.js";

export interface SecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  /** For apiKey: header, query, or cookie */
  in?: "header" | "query" | "cookie";
  /** For apiKey: the header/query/cookie name */
  name?: string;
  /** For http: bearer, basic, etc. */
  scheme?: string;
}

export interface ParsedSpec {
  title: string;
  version: string;
  basePath: string;
  paths: ParsedPath[];
  securitySchemes?: Map<string, SecurityScheme>;
  globalSecurity?: string[][];
}

export interface ParsedResponseEntry {
  schema?: JSONSchema7;
  description: string;
  headers?: Record<string, Schmock.ResponseHeaderDef>;
  examples?: Map<string, unknown>;
  contentTypes?: string[];
}

export interface ParsedCallback {
  /** Runtime expression for the callback URL (e.g. "{$request.body#/callbackUrl}") */
  urlExpression: string;
  /** HTTP method for the callback request */
  method: Schmock.HttpMethod;
  /** JSON Schema for the callback request body */
  requestBody?: JSONSchema7;
}

export interface ParsedPath {
  /** Express-style path e.g. "/pets/:petId" */
  path: string;
  method: Schmock.HttpMethod;
  operationId?: string;
  parameters: ParsedParameter[];
  requestBody?: JSONSchema7;
  responses: Map<number, ParsedResponseEntry>;
  tags: string[];
  /** Per-operation security requirements (each entry is OR, keys within are AND) */
  security?: string[][];
  /** OAS3 callbacks defined on this operation */
  callbacks?: ParsedCallback[];
}

export interface ParsedParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema?: JSONSchema7;
}

const HTTP_METHOD_KEYS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
]);

function isOpenApiDocument(value: unknown): value is OpenAPI.Document {
  return isRecord(value) && ("swagger" in value || "openapi" in value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Strip root-level x-* extensions from a spec object.
 * These may contain $ref to external docs (e.g. markdown files)
 * that swagger-parser cannot resolve.
 */
function stripRootExtensions(spec: object): void {
  for (const key of Object.keys(spec)) {
    if (key.startsWith("x-")) {
      Reflect.deleteProperty(spec, key);
    }
  }
}

/**
 * Ensure a paths key exists on a spec object (required by swagger-parser validation).
 */
function ensurePathsKey(spec: object): void {
  if (!("paths" in spec)) {
    Object.assign(spec, { paths: {} });
  }
}

/**
 * Parse an OpenAPI/Swagger spec into a normalized internal model.
 * Supports Swagger 2.0, OpenAPI 3.0, and 3.1.
 */
export async function parseSpec(source: string | object): Promise<ParsedSpec> {
  let api: OpenAPI.Document;
  if (typeof source === "string") {
    // Parse raw YAML/JSON first (no ref resolution)
    const raw = await SwaggerParser.parse(source);
    stripRootExtensions(raw);
    ensurePathsKey(raw);
    api = await SwaggerParser.dereference(raw);
  } else if (isOpenApiDocument(source)) {
    const copy = structuredClone(source);
    stripRootExtensions(copy);
    ensurePathsKey(copy);
    api = await SwaggerParser.dereference(copy);
  } else {
    throw new Error(
      "Invalid OpenAPI spec: must be a string path or an OpenAPI document object",
    );
  }

  const isSwagger2 = "swagger" in api && typeof api.swagger === "string";
  const title = api.info?.title ?? "Untitled";
  const version = api.info?.version ?? "0.0.0";

  let basePath = "";
  if (isSwagger2 && "basePath" in api) {
    const bp = api.basePath;
    basePath = typeof bp === "string" ? bp : "";
  } else if (
    "servers" in api &&
    Array.isArray(api.servers) &&
    api.servers.length > 0
  ) {
    const firstServer = api.servers[0];
    if (isRecord(firstServer) && typeof firstServer.url === "string") {
      try {
        const url = new URL(firstServer.url, "http://localhost");
        basePath = url.pathname === "/" ? "" : url.pathname;
      } catch {
        basePath = "";
      }
    }
  }
  // Strip trailing slash from basePath
  if (basePath.endsWith("/") && basePath !== "/") {
    basePath = basePath.slice(0, -1);
  }

  // Extract security schemes
  const securitySchemes = extractSecuritySchemes(api, isSwagger2);
  const globalSecurityRaw = "security" in api ? api.security : undefined;
  const globalSecurity = extractSecurityRequirements(
    Array.isArray(globalSecurityRaw) ? globalSecurityRaw : undefined,
  );

  const paths: ParsedPath[] = [];
  const rawPaths =
    "paths" in api && isRecord(api.paths) ? api.paths : undefined;

  if (!rawPaths) {
    return { title, version, basePath, paths, securitySchemes, globalSecurity };
  }

  for (const [pathTemplate, pathItemRaw] of Object.entries(rawPaths)) {
    if (!isRecord(pathItemRaw)) continue;
    const pathItem = pathItemRaw;

    // Extract path-level parameters
    const pathLevelParams = extractParameters(
      Array.isArray(pathItem.parameters) ? pathItem.parameters : undefined,
      isSwagger2,
    );

    for (const methodKey of Object.keys(pathItem)) {
      if (!HTTP_METHOD_KEYS.has(methodKey)) continue;

      const operation = pathItem[methodKey];
      if (!isRecord(operation)) continue;

      const method = toHttpMethod(methodKey.toUpperCase());

      // Merge path-level + operation-level parameters (operation wins)
      const operationParams = extractParameters(
        Array.isArray(operation.parameters) ? operation.parameters : undefined,
        isSwagger2,
      );
      const mergedParams = mergeParameters(pathLevelParams, operationParams);

      // Extract request body
      let requestBody: JSONSchema7 | undefined;
      if (isSwagger2) {
        requestBody = extractSwagger2RequestBody(mergedParams);
      } else {
        requestBody = extractOpenApi3RequestBody(
          isRecord(operation.requestBody) ? operation.requestBody : undefined,
        );
      }

      // Extract responses
      const responses = extractResponses(
        isRecord(operation.responses) ? operation.responses : undefined,
        isSwagger2,
      );

      // Convert path template: {petId} -> :petId
      const expressPath = convertPathTemplate(pathTemplate);

      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((t): t is string => typeof t === "string")
        : [];

      // Extract per-operation security
      const operationSecurity = Array.isArray(operation.security)
        ? extractSecurityRequirements(operation.security)
        : undefined;

      // Extract OAS3 callbacks
      const callbacks =
        !isSwagger2 && isRecord(operation.callbacks)
          ? extractCallbacks(operation.callbacks)
          : undefined;

      // Filter out body parameters from the final parameter list (Swagger 2.0)
      const filteredParams = mergedParams.filter(isNotBodyParam);

      paths.push({
        path: expressPath,
        method,
        operationId: getString(operation.operationId),
        parameters: filteredParams,
        requestBody,
        responses,
        tags,
        security: operationSecurity,
        callbacks,
      });
    }
  }

  return { title, version, basePath, paths, securitySchemes, globalSecurity };
}

interface InternalParameter {
  name: string;
  in: "path" | "query" | "header" | "body";
  required: boolean;
  schema?: JSONSchema7;
}

function isValidParamLocation(
  location: string,
  isSwagger2: boolean,
): location is "path" | "query" | "header" | "body" {
  const validLocations = isSwagger2
    ? ["path", "query", "header", "body"]
    : ["path", "query", "header"];
  return validLocations.includes(location);
}

function isNotBodyParam(param: InternalParameter): param is ParsedParameter {
  return param.in !== "body";
}

function extractParameters(
  params: unknown[] | undefined,
  isSwagger2: boolean,
): InternalParameter[] {
  if (!params || !Array.isArray(params)) return [];

  return params
    .filter((p): p is Record<string, unknown> => isRecord(p))
    .map((p): InternalParameter | null => {
      const location = getString(p.in);
      if (!location || !isValidParamLocation(location, isSwagger2)) {
        return null;
      }

      let schema: JSONSchema7 | undefined;
      if (isSwagger2) {
        // Swagger 2.0: schema is inline on the parameter (type, format, etc.)
        if (location === "body") {
          schema = isRecord(p.schema)
            ? normalizeSchema(p.schema, "request")
            : undefined;
        } else {
          schema = p.type
            ? normalizeSchema(
                { type: p.type, format: p.format, enum: p.enum },
                "request",
              )
            : undefined;
        }
      } else {
        // OpenAPI 3.x: schema is nested
        schema = isRecord(p.schema)
          ? normalizeSchema(p.schema, "request")
          : undefined;
      }

      const name = getString(p.name);
      if (!name) return null;

      return {
        name,
        in: location,
        required: getBoolean(p.required, false),
        schema,
      };
    })
    .filter((p): p is InternalParameter => p !== null);
}

function mergeParameters(
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

function extractSwagger2RequestBody(
  params: InternalParameter[],
): JSONSchema7 | undefined {
  const bodyParam = params.find((p) => p.in === "body");
  return bodyParam?.schema;
}

function extractOpenApi3RequestBody(
  requestBody: Record<string, unknown> | undefined,
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

  return normalizeSchema(schema, "request");
}

function extractResponses(
  responses: Record<string, unknown> | undefined,
  isSwagger2: boolean,
): Map<number, ParsedResponseEntry> {
  const result = new Map<number, ParsedResponseEntry>();

  if (!responses) return result;

  for (const [statusCode, response] of Object.entries(responses)) {
    if (statusCode === "default") continue;
    if (!isRecord(response)) continue;

    const code = Number.parseInt(statusCode, 10);
    if (Number.isNaN(code)) continue;

    const description = getString(response.description) ?? "";

    let schema: JSONSchema7 | undefined;
    let examples: Map<string, unknown> | undefined;
    let contentTypes: string[] | undefined;

    if (isSwagger2) {
      if (isRecord(response.schema)) {
        schema = normalizeSchema(response.schema, "response");
      }
      // Swagger 2.0 single example
      if (response.examples !== undefined && isRecord(response.examples)) {
        examples = new Map();
        for (const [key, value] of Object.entries(response.examples)) {
          examples.set(key, value);
        }
      }
    } else {
      const content = isRecord(response.content) ? response.content : undefined;
      if (content) {
        contentTypes = Object.keys(content);
        const jsonEntry = findJsonContent(content);
        if (jsonEntry && isRecord(jsonEntry.schema)) {
          schema = normalizeSchema(jsonEntry.schema, "response");
        }
        // OAS3 named examples
        if (jsonEntry) {
          examples = extractExamples(jsonEntry);
        }
      }
    }

    const headers = extractResponseHeaders(response, isSwagger2);
    result.set(code, { schema, description, headers, examples, contentTypes });
  }

  return result;
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
  isSwagger2: boolean,
): Record<string, Schmock.ResponseHeaderDef> | undefined {
  const rawHeaders = isRecord(response.headers) ? response.headers : undefined;
  if (!rawHeaders) return undefined;

  const headers: Record<string, Schmock.ResponseHeaderDef> = {};
  let hasHeaders = false;

  for (const [name, headerRaw] of Object.entries(rawHeaders)) {
    if (!isRecord(headerRaw)) continue;

    const desc = getString(headerRaw.description) ?? "";
    let headerSchema: JSONSchema7 | undefined;

    if (isSwagger2) {
      // Swagger 2.0: type/format/enum are inline on the header
      if (headerRaw.type) {
        headerSchema = normalizeSchema(
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
        headerSchema = normalizeSchema(headerRaw.schema, "response");
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

function convertPathTemplate(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

function extractSecuritySchemes(
  api: OpenAPI.Document,
  isSwagger2: boolean,
): Map<string, SecurityScheme> | undefined {
  const schemes = new Map<string, SecurityScheme>();

  let rawSchemes: Record<string, unknown> | undefined;

  if (isSwagger2) {
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

    const scheme = toSecurityScheme(type, schemeDef, isSwagger2);
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
  isSwagger2: boolean,
): SecurityScheme | undefined {
  // Handle Swagger 2.0 basic auth
  if (isSwagger2 && type === "basic") {
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
    scheme.scheme = getString(def.scheme);
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
function extractSecurityRequirements(
  security: unknown[] | undefined,
): string[][] | undefined {
  if (!security || security.length === 0) return undefined;

  const result: string[][] = [];
  for (const entry of security) {
    if (!isRecord(entry)) continue;
    result.push(Object.keys(entry));
  }

  return result.length > 0 ? result : undefined;
}

/**
 * Extract OAS3 callbacks from an operation.
 * Callbacks structure: { callbackName: { urlExpression: { method: { requestBody, ... } } } }
 */
function extractCallbacks(
  callbacks: Record<string, unknown>,
): ParsedCallback[] | undefined {
  const result: ParsedCallback[] = [];

  for (const callbackObj of Object.values(callbacks)) {
    if (!isRecord(callbackObj)) continue;

    // Each key is a URL expression like "{$request.body#/callbackUrl}"
    for (const [urlExpression, pathItem] of Object.entries(callbackObj)) {
      if (!isRecord(pathItem)) continue;

      for (const methodKey of Object.keys(pathItem)) {
        if (!HTTP_METHOD_KEYS.has(methodKey)) continue;

        const operation = pathItem[methodKey];
        if (!isRecord(operation)) continue;

        let reqBody: JSONSchema7 | undefined;
        if (isRecord(operation.requestBody)) {
          reqBody = extractOpenApi3RequestBody(operation.requestBody);
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
