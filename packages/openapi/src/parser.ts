import type * as Schmock from "@schmock/core";
import { toHttpMethod } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { type LoadDocumentOptions, loadDocument } from "./load-document.js";
import {
  createSchemaNormalizer,
  extractCallbacks,
  extractParameters,
  extractRequestBody,
  extractResponses,
  extractSecurityRequirements,
  extractSecuritySchemes,
  getString,
  getStringArray,
  HTTP_METHOD_KEYS,
  isNotBodyParam,
  mergeParameters,
  type ParseContext,
} from "./operation-extract.js";
import {
  describePathTemplateProblem,
  templateToRoutePath,
} from "./path-template.js";
import type { ResponseStatusKey } from "./response-status.js";
import { isRecord } from "./utils.js";

export { enrichResolverError } from "./load-document.js";

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
  paths: ParsedPath[];
  securitySchemes?: Map<string, SecurityScheme>;
  globalSecurity?: string[][];
  /**
   * Everything the parser skipped rather than failed on, one line each.
   *
   * Always collected, never fatal: `strict` decides whether the document is
   * validated up-front, this decides whether the caller can find out what was
   * dropped along the way. Surfaced by the plugin under `debug: true`.
   */
  warnings: string[];
}

export interface ParsedResponseEntry {
  schema?: JSONSchema7;
  description: string;
  headers?: Record<string, Schmock.ResponseHeaderDef>;
  examples?: Map<string, unknown>;
  contentTypes?: string[];
  /** Response schemas and examples keyed by their declared media type. */
  content?: Map<string, ParsedResponseContent>;
}

export interface ParsedResponseContent {
  schema?: JSONSchema7;
  examples?: Map<string, unknown>;
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
  /**
   * The JSON-ish request schema, kept as the default contract and as the
   * fallback used when a request carries no `Content-Type`.
   */
  requestBody?: JSONSchema7;
  requestBodyRequired: boolean;
  /**
   * Request schemas keyed by normalized media type. A media type declared
   * without a schema maps to `undefined`: accepted, but not validated.
   */
  requestContent?: Map<string, JSONSchema7 | undefined>;
  responses: Map<ResponseStatusKey, ParsedResponseEntry>;
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

/** Path-item keys that are legitimately not operations. */
const NON_METHOD_PATH_ITEM_KEYS = new Set([
  "parameters",
  "summary",
  "description",
  "servers",
  "$ref",
  "trace",
]);

function isExtensionKey(key: string): boolean {
  return key.startsWith("x-");
}

/** Options for {@link parseSpec}: how the document is loaded and resolved. */
export type ParseSpecOptions = LoadDocumentOptions;

/**
 * Parse an OpenAPI/Swagger spec into a normalized internal model.
 * Supports Swagger 2.0, OpenAPI 3.0, and 3.1.
 */
export async function parseSpec(
  source: string | object,
  options: ParseSpecOptions = {},
): Promise<ParsedSpec> {
  const api = await loadDocument(source, options);

  const title = api.info?.title ?? "Untitled";
  const version = api.info?.version ?? "0.0.0";

  // Swagger 2.0 `basePath` and OAS3 `servers[].url` pathnames are intentionally
  // ignored: routes register at the spec's own path templates. Mount the mock
  // under a prefix with the adapter's `baseUrl` option instead.

  // Built once and handed to every extractor: the dialect decides where each
  // one looks, and Swagger 2.0's root media types are inherited per operation.
  const rootDocument: Record<string, unknown> = isRecord(api) ? api : {};
  const dialect: ParseContext["dialect"] =
    "swagger" in api && typeof api.swagger === "string" ? "swagger2" : "oas3";
  const ctx: ParseContext = {
    dialect,
    normalize: createSchemaNormalizer(),
    warnings: [],
    rootConsumes:
      dialect === "swagger2"
        ? getStringArray(rootDocument.consumes)
        : undefined,
    rootProduces:
      dialect === "swagger2"
        ? getStringArray(rootDocument.produces)
        : undefined,
  };
  const { warnings } = ctx;

  // Extract security schemes
  const securitySchemes = extractSecuritySchemes(api, ctx);
  const globalSecurityRaw = "security" in api ? api.security : undefined;
  const globalSecurity = extractSecurityRequirements(
    Array.isArray(globalSecurityRaw) ? globalSecurityRaw : undefined,
  );

  const paths: ParsedPath[] = [];
  const rawPaths =
    "paths" in api && isRecord(api.paths) ? api.paths : undefined;

  if (!rawPaths) {
    return { title, version, paths, securitySchemes, globalSecurity, warnings };
  }

  for (const [pathTemplate, pathItemRaw] of Object.entries(rawPaths)) {
    if (!isRecord(pathItemRaw)) {
      warnings.push(`path ${pathTemplate}: not an object, skipped`);
      continue;
    }
    const pathItem = pathItemRaw;

    // Extract path-level parameters
    const pathLevelParams = extractParameters(
      pathItem.parameters,
      ctx,
      `path ${pathTemplate}`,
    );

    for (const methodKey of Object.keys(pathItem)) {
      if (!HTTP_METHOD_KEYS.has(methodKey)) {
        if (
          !NON_METHOD_PATH_ITEM_KEYS.has(methodKey) &&
          !isExtensionKey(methodKey)
        ) {
          warnings.push(
            `path ${pathTemplate}: "${methodKey}" is not an HTTP method, skipped`,
          );
        }
        continue;
      }

      const operation = pathItem[methodKey];
      const label = `${methodKey.toUpperCase()} ${pathTemplate}`;
      if (!isRecord(operation)) {
        warnings.push(`${label}: operation is not an object, skipped`);
        continue;
      }

      const method = toHttpMethod(methodKey.toUpperCase());

      // Merge path-level + operation-level parameters (operation wins)
      const operationParams = extractParameters(
        operation.parameters,
        ctx,
        label,
      );
      const mergedParams = mergeParameters(pathLevelParams, operationParams);

      const { requestBody, requestBodyRequired, requestContent } =
        extractRequestBody(operation, mergedParams, ctx);

      const responses = extractResponses(operation, ctx, label);

      // Convert path template: {petId} -> :petId. A template the route grammar
      // cannot express is skipped with a warning rather than registered as a
      // route that answers the wrong requests.
      const templateProblem = describePathTemplateProblem(pathTemplate);
      if (templateProblem) {
        warnings.push(`${label}: ${templateProblem}, skipped`);
        continue;
      }
      const expressPath = convertPathTemplate(pathTemplate);

      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((t): t is string => typeof t === "string")
        : [];

      // Extract per-operation security
      const operationSecurity = Array.isArray(operation.security)
        ? extractSecurityRequirements(operation.security)
        : undefined;

      const callbacks = extractCallbacks(operation, ctx);

      // Filter out body parameters from the final parameter list (Swagger 2.0)
      const filteredParams = mergedParams.filter(isNotBodyParam);

      paths.push({
        path: expressPath,
        method,
        operationId: getString(operation.operationId),
        parameters: filteredParams,
        requestBody,
        requestBodyRequired,
        requestContent,
        responses,
        tags,
        security: operationSecurity,
        callbacks,
      });
    }
  }

  return { title, version, paths, securitySchemes, globalSecurity, warnings };
}

/**
 * Rewrite an OpenAPI path template into the Express form the router uses:
 * `/pets/{petId}` → `/pets/:petId`, `/jobs/{job}:run` → `/jobs/:job\:run`,
 * `/users/{user.id}` → `/users/:"user.id"` (see path-template.ts).
 *
 * Exported so `options.schemas` keys can be normalized with the SAME function
 * that produced `ParsedPath.path`. A second copy would be a silent mismatch
 * waiting to happen — the exact drift that made a spec-native override key
 * report "the spec declares no ... operation" about an operation it declares.
 */
export function convertPathTemplate(path: string): string {
  return templateToRoutePath(path, { escapeLiteralColons: true });
}
