/// <reference path="../../../types/schmock.d.ts" />

import SwaggerParser from "@apidevtools/swagger-parser";
import { toHttpMethod } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import type { OpenAPI } from "openapi-types";
import { normalizeSchema } from "./normalizer.js";
import { isRecord } from "./utils.js";

export interface ParsedSpec {
  title: string;
  version: string;
  basePath: string;
  paths: ParsedPath[];
}

export interface ParsedPath {
  /** Express-style path e.g. "/pets/:petId" */
  path: string;
  method: Schmock.HttpMethod;
  operationId?: string;
  parameters: ParsedParameter[];
  requestBody?: JSONSchema7;
  responses: Map<number, { schema?: JSONSchema7; description: string }>;
  tags: string[];
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

  const paths: ParsedPath[] = [];
  const rawPaths =
    "paths" in api && isRecord(api.paths) ? api.paths : undefined;

  if (!rawPaths) {
    return { title, version, basePath, paths };
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
      });
    }
  }

  return { title, version, basePath, paths };
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
): Map<number, { schema?: JSONSchema7; description: string }> {
  const result = new Map<
    number,
    { schema?: JSONSchema7; description: string }
  >();

  if (!responses) return result;

  for (const [statusCode, response] of Object.entries(responses)) {
    if (statusCode === "default") continue;
    if (!isRecord(response)) continue;

    const code = Number.parseInt(statusCode, 10);
    if (Number.isNaN(code)) continue;

    const description = getString(response.description) ?? "";

    let schema: JSONSchema7 | undefined;
    if (isSwagger2) {
      // Swagger 2.0: schema is directly on the response
      if (isRecord(response.schema)) {
        schema = normalizeSchema(response.schema, "response");
      }
    } else {
      // OpenAPI 3.x: schema is nested in content
      const content = isRecord(response.content) ? response.content : undefined;
      if (content) {
        const jsonEntry = findJsonContent(content);
        if (jsonEntry && isRecord(jsonEntry.schema)) {
          schema = normalizeSchema(jsonEntry.schema, "response");
        }
      }
    }

    result.set(code, { schema, description });
  }

  return result;
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
