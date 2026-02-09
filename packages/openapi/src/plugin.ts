/// <reference path="../../core/schmock.d.ts" />

import { generateFromSchema } from "@schmock/faker";
import Ajv from "ajv";
import type { JSONSchema7 } from "json-schema";
import { negotiateContentType } from "./content-negotiation.js";
import type { CrudOperation, CrudResource } from "./crud-detector.js";
import { detectCrudResources } from "./crud-detector.js";
import {
  createCreateGenerator,
  createDeleteGenerator,
  createListGenerator,
  createReadGenerator,
  createStaticGenerator,
  createUpdateGenerator,
  findArrayProperty,
} from "./generators.js";
import type {
  ParsedCallback,
  ParsedPath,
  ParsedResponseEntry,
  SecurityScheme,
} from "./parser.js";
import { parseSpec } from "./parser.js";
import { parsePreferHeader } from "./prefer.js";
import type { SeedConfig, SeedSource } from "./seed.js";
import { loadSeed } from "./seed.js";
import { isRecord } from "./utils.js";

export type { SeedConfig, SeedSource };

export interface OpenApiOptions {
  /** File path or inline spec object */
  spec: string | object;
  /** Optional seed data per resource */
  seed?: SeedConfig;
  /** Validate request bodies (default: false) */
  validateRequests?: boolean;
  /** Validate response bodies (default: false) */
  validateResponses?: boolean;
  /** Query features for list endpoints */
  queryFeatures?: {
    pagination?: boolean;
    sorting?: boolean;
    filtering?: boolean;
  };
  /** Override auto-detected response format per resource */
  resources?: Record<string, Schmock.ResourceOverride>;
  /** Log auto-detection decisions to console (default: false) */
  debug?: boolean;
  /** Seed for deterministic random generation */
  fakerSeed?: number;
  /** Validate security schemes (API key, Bearer, Basic) (default: false) */
  security?: boolean;
}

/**
 * Create an OpenAPI plugin that auto-registers CRUD routes from a spec.
 *
 * @example
 * ```typescript
 * const mock = schmock();
 * mock.pipe(await openapi({
 *   spec: "./petstore.yaml",
 *   seed: { pets: { count: 10 } },
 * }));
 * ```
 */
export async function openapi(
  options: OpenApiOptions,
): Promise<Schmock.Plugin> {
  const spec = await parseSpec(options.spec);
  const { resources, nonCrudPaths } = detectCrudResources(spec.paths);
  const seedData = options.seed
    ? loadSeed(options.seed, resources)
    : new Map<string, unknown[]>();

  // Build a lookup of all parsed paths for process() to reference
  const allParsedPaths = new Map<string, ParsedPath>();
  for (const pp of [...spec.paths]) {
    allParsedPaths.set(`${pp.method} ${pp.path}`, pp);
  }

  // Security scheme lookup
  const securitySchemes = spec.securitySchemes;
  const globalSecurity = spec.globalSecurity;

  return {
    name: "@schmock/openapi",
    version: "1.4.0",

    install(instance: Schmock.CallableMockInstance) {
      if (options.debug) {
        console.log(
          `[@schmock/openapi] Detected ${resources.length} CRUD resources, ${nonCrudPaths.length} static routes`,
        );
      }

      // Register CRUD routes with metadata
      for (const resource of resources) {
        const override = options.resources?.[resource.name];
        if (override) {
          applyOverrides(resource, override);
        }

        if (options.debug) {
          logResourceDetection(resource, override);
        }

        registerCrudRoutes(
          instance,
          resource,
          seedData.get(resource.name),
          allParsedPaths,
        );
      }

      // Register non-CRUD routes with static generators
      for (const parsedPath of nonCrudPaths) {
        const routeKey =
          `${parsedPath.method} ${parsedPath.path}` as Schmock.RouteKey;
        const config: Schmock.RouteConfig = {
          "openapi:responses": parsedPath.responses,
          "openapi:path": parsedPath.path,
          "openapi:requestBody": parsedPath.requestBody,
          "openapi:security": parsedPath.security,
          "openapi:callbacks": parsedPath.callbacks,
        };
        instance(
          routeKey,
          createStaticGenerator(parsedPath, options.fakerSeed),
          config,
        );
      }
    },

    process(
      context: Schmock.PluginContext,
      response?: unknown,
    ): Schmock.PluginResult {
      // 1. Security validation (if enabled)
      if (options.security && securitySchemes) {
        const securityResult = validateSecurity(
          context,
          securitySchemes,
          globalSecurity,
        );
        if (securityResult) return securityResult;
      }

      // 2. Content negotiation
      const contentResult = processContentNegotiation(context);
      if (contentResult) return contentResult;

      // 3. Request validation (if enabled)
      if (options.validateRequests) {
        const validationResult = validateRequestBody(context);
        if (validationResult) {
          return validationResult;
        }
      }

      // 4. Prefer header handling
      const result = processPreferHeader(context, response, options.fakerSeed);

      // 5. Fire callbacks (fire-and-forget, after response is determined)
      const callbacks = context.route["openapi:callbacks"] as
        | ParsedCallback[]
        | undefined;
      if (callbacks && callbacks.length > 0) {
        fireCallbacks(callbacks, context, result.response);
      }

      return result;
    },
  };
}

/**
 * Validate security requirements for the request.
 * Returns 401 if auth is required and missing/invalid.
 */
function validateSecurity(
  context: Schmock.PluginContext,
  schemes: Map<string, SecurityScheme>,
  globalSecurity?: string[][],
): Schmock.PluginResult | undefined {
  // Determine applicable security: operation-level overrides global
  const routeSecurity = context.route["openapi:security"] as
    | string[][]
    | undefined;
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
function processContentNegotiation(
  context: Schmock.PluginContext,
): Schmock.PluginResult | undefined {
  const accept = context.headers.accept ?? context.headers.Accept;
  if (!accept || accept === "*/*") return undefined;

  const responses = context.route["openapi:responses"] as
    | Map<number, ParsedResponseEntry>
    | undefined;
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

/**
 * Handle Prefer header directives: code=N, example=name, dynamic=true
 */
function processPreferHeader(
  context: Schmock.PluginContext,
  response: unknown,
  fakerSeed?: number,
): Schmock.PluginResult {
  const preferValue = context.headers.prefer ?? context.headers.Prefer;
  if (!preferValue) {
    return { context, response };
  }

  const prefer = parsePreferHeader(preferValue);
  const responses = context.route["openapi:responses"] as
    | Map<number, ParsedResponseEntry>
    | undefined;

  if (!responses) {
    return { context, response };
  }

  // Prefer: code=N — return the response for that status code
  if (prefer.code !== undefined) {
    const entry = responses.get(prefer.code);
    if (entry) {
      const body = entry.schema
        ? generateResponseBody(entry.schema, fakerSeed)
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
        const body = generateResponseBody(entry.schema, fakerSeed);
        return { context, response: [code, body] };
      }
    }
  }

  return { context, response };
}

const ajv = new Ajv({ allErrors: true });

/**
 * Validate request body against the spec's requestBody schema.
 * Returns a PluginResult with 400 status if validation fails, or undefined to continue.
 */
function validateRequestBody(
  context: Schmock.PluginContext,
): Schmock.PluginResult | undefined {
  const requestBodySchema = context.route["openapi:requestBody"] as
    | JSONSchema7
    | undefined;

  if (!requestBodySchema || context.body === undefined) {
    return undefined;
  }

  const validate = ajv.compile(requestBodySchema);
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
 * Resolve a callback URL expression using runtime values.
 * Handles expressions like "{$request.body#/callbackUrl}" and literal URLs.
 */
function resolveCallbackUrl(
  expression: string,
  context: Schmock.PluginContext,
  response: unknown,
): string | undefined {
  // Replace all runtime expression tokens
  return expression.replace(/\{\$([^}]+)\}/g, (_, expr: string) => {
    // $request.body#/path — JSON pointer into request body
    if (expr.startsWith("request.body#")) {
      const pointer = expr.slice("request.body#".length);
      const value = resolveJsonPointer(context.body, pointer);
      return typeof value === "string" ? value : "";
    }

    // $request.header.name
    if (expr.startsWith("request.header.")) {
      const headerName = expr.slice("request.header.".length).toLowerCase();
      return context.headers[headerName] ?? "";
    }

    // $request.query.name
    if (expr.startsWith("request.query.")) {
      const queryName = expr.slice("request.query.".length);
      return context.query[queryName] ?? "";
    }

    // $request.path.param
    if (expr.startsWith("request.path.")) {
      const paramName = expr.slice("request.path.".length);
      return context.params[paramName] ?? "";
    }

    // $response.body#/path — JSON pointer into response body
    if (expr.startsWith("response.body#")) {
      const pointer = expr.slice("response.body#".length);
      const responseBody = Array.isArray(response) ? response[1] : response;
      const value = resolveJsonPointer(responseBody, pointer);
      return typeof value === "string" ? value : "";
    }

    return "";
  });
}

function resolveJsonPointer(obj: unknown, pointer: string): unknown {
  if (!isRecord(obj) || !pointer.startsWith("/")) return undefined;

  const parts = pointer.slice(1).split("/");
  let current: unknown = obj;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Fire callbacks in a fire-and-forget manner.
 * Silently ignores failures — callbacks are best-effort.
 */
function fireCallbacks(
  callbacks: ParsedCallback[],
  context: Schmock.PluginContext,
  response: unknown,
): void {
  for (const callback of callbacks) {
    const url = resolveCallbackUrl(callback.urlExpression, context, response);
    if (!url || !url.startsWith("http")) continue;

    const body = Array.isArray(response) ? response[1] : response;

    // Fire and forget
    void fetch(url, {
      method: callback.method,
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).catch(() => {
      // Silently ignore callback failures
    });
  }
}

function generateResponseBody(schema: JSONSchema7, seed?: number): unknown {
  try {
    return generateFromSchema({ schema, seed });
  } catch {
    return {};
  }
}

function registerCrudRoutes(
  instance: Schmock.CallableMockInstance,
  resource: CrudResource,
  seedItems: unknown[] | undefined,
  allParsedPaths: Map<string, ParsedPath>,
): void {
  const ensureSeeded = createSeeder(resource, seedItems);

  for (const op of resource.operations) {
    const meta = resource.operationMeta?.get(op);
    const routeEntries = getCrudRouteEntries(op, resource);

    for (const { routeKey, method } of routeEntries) {
      const gen = createCrudGenerator(op, resource, meta);
      const parsedPath =
        allParsedPaths.get(`${method} ${resource.basePath}`) ??
        allParsedPaths.get(`${method} ${resource.itemPath}`);

      const config: Schmock.RouteConfig = {};
      if (parsedPath) {
        config["openapi:responses"] = parsedPath.responses;
        config["openapi:path"] = parsedPath.path;
        config["openapi:requestBody"] = parsedPath.requestBody;
        config["openapi:security"] = parsedPath.security;
        config["openapi:callbacks"] = parsedPath.callbacks;
      }

      instance(routeKey, wrapWithSeeder(ensureSeeded, gen), config);
    }
  }
}

interface RouteEntry {
  routeKey: Schmock.RouteKey;
  method: Schmock.HttpMethod;
}

function getCrudRouteEntries(
  op: CrudOperation,
  resource: CrudResource,
): RouteEntry[] {
  switch (op) {
    case "list":
      return [
        {
          routeKey: `GET ${resource.basePath}` as Schmock.RouteKey,
          method: "GET",
        },
      ];
    case "create":
      return [
        {
          routeKey: `POST ${resource.basePath}` as Schmock.RouteKey,
          method: "POST",
        },
      ];
    case "read":
      return [
        {
          routeKey: `GET ${resource.itemPath}` as Schmock.RouteKey,
          method: "GET",
        },
      ];
    case "update":
      return [
        {
          routeKey: `PUT ${resource.itemPath}` as Schmock.RouteKey,
          method: "PUT",
        },
        {
          routeKey: `PATCH ${resource.itemPath}` as Schmock.RouteKey,
          method: "PATCH",
        },
      ];
    case "delete":
      return [
        {
          routeKey: `DELETE ${resource.itemPath}` as Schmock.RouteKey,
          method: "DELETE",
        },
      ];
  }
}

function createCrudGenerator(
  op: CrudOperation,
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
): Schmock.GeneratorFunction {
  switch (op) {
    case "list":
      return createListGenerator(resource, meta);
    case "create":
      return createCreateGenerator(resource, meta);
    case "read":
      return createReadGenerator(resource, meta);
    case "update":
      return createUpdateGenerator(resource, meta);
    case "delete":
      return createDeleteGenerator(resource, meta);
  }
}

/**
 * Create a seeder function that initializes collection state once.
 */
function createSeeder(
  resource: CrudResource,
  seedItems?: unknown[],
): (state: Record<string, unknown>) => void {
  const stateKey = `openapi:collections:${resource.name}`;
  const counterKey = `openapi:counter:${resource.name}`;
  const seededKey = `openapi:seeded:${resource.name}`;

  return (state: Record<string, unknown>) => {
    if (state[seededKey]) return;
    state[seededKey] = true;

    if (seedItems && seedItems.length > 0) {
      state[stateKey] = [...seedItems];
      let maxId = 0;
      for (const item of seedItems) {
        if (isRecord(item) && resource.idParam in item) {
          const id = item[resource.idParam];
          if (typeof id === "number" && id > maxId) {
            maxId = id;
          }
        }
      }
      state[counterKey] = maxId;
    } else {
      state[stateKey] = [];
      state[counterKey] = 0;
    }
  };
}

function wrapWithSeeder(
  seeder: (state: Record<string, unknown>) => void,
  generator: Schmock.GeneratorFunction,
): Schmock.GeneratorFunction {
  return (ctx: Schmock.RequestContext) => {
    seeder(ctx.state);
    return generator(ctx);
  };
}

/**
 * Apply manual overrides to a resource's operation metadata.
 */
function applyOverrides(
  resource: CrudResource,
  override: Schmock.ResourceOverride,
): void {
  if (!resource.operationMeta) {
    resource.operationMeta = new Map();
  }

  if (
    override.listWrapProperty !== undefined ||
    override.listFlat !== undefined
  ) {
    const listMeta = resource.operationMeta.get("list") ?? {};

    if (override.listFlat) {
      delete listMeta.responseSchema;
    } else if (override.listWrapProperty && listMeta.responseSchema) {
      const arrayInfo = findArrayProperty(listMeta.responseSchema);
      if (
        !arrayInfo.property ||
        arrayInfo.property !== override.listWrapProperty
      ) {
        const itemSchema = arrayInfo.itemSchema ?? resource.schema ?? {};
        listMeta.responseSchema = {
          type: "object",
          properties: {
            [override.listWrapProperty]: {
              type: "array",
              items: itemSchema,
            },
          },
        };
      }
    } else if (override.listWrapProperty) {
      const itemSchema = resource.schema ?? {};
      listMeta.responseSchema = {
        type: "object",
        properties: {
          [override.listWrapProperty]: {
            type: "array",
            items: itemSchema,
          },
        },
      };
    }

    resource.operationMeta.set("list", listMeta);
  }

  if (override.errorSchema) {
    const errorSchemaMap = new Map<number, JSONSchema7>();
    errorSchemaMap.set(404, override.errorSchema);
    errorSchemaMap.set(400, override.errorSchema);
    errorSchemaMap.set(409, override.errorSchema);

    for (const op of ["read", "update", "delete"] as CrudOperation[]) {
      const meta = resource.operationMeta.get(op) ?? {};
      meta.errorSchemas = errorSchemaMap;
      resource.operationMeta.set(op, meta);
    }
  }
}

/**
 * Log resource detection info for debug mode.
 */
function logResourceDetection(
  resource: CrudResource,
  override?: Schmock.ResourceOverride,
): void {
  const listMeta = resource.operationMeta?.get("list");
  let listFormat = "flat";
  if (listMeta?.responseSchema) {
    const arrayInfo = findArrayProperty(listMeta.responseSchema);
    if (arrayInfo.property) {
      const hasAllOf = "allOf" in (listMeta.responseSchema ?? {});
      listFormat = `wrapped("${arrayInfo.property}"${hasAllOf ? " via allOf" : ""})`;
    }
  }

  const readMeta = resource.operationMeta?.get("read");
  const errorFormat = readMeta?.errorSchemas?.has(404)
    ? "schema(404)"
    : "default";

  const headerCount = listMeta?.responseHeaders
    ? Object.keys(listMeta.responseHeaders).length
    : 0;

  console.log(
    `[@schmock/openapi] ${resource.name}: list=${listFormat}, error=${errorFormat}, headers=${headerCount}`,
  );

  if (override) {
    const definedKeys: string[] = [];
    if (override.listWrapProperty !== undefined)
      definedKeys.push("listWrapProperty");
    if (override.listFlat !== undefined) definedKeys.push("listFlat");
    if (override.errorSchema !== undefined) definedKeys.push("errorSchema");

    if (definedKeys.length > 0) {
      console.log(
        `[@schmock/openapi] Override applied: ${resource.name}.${definedKeys.join(", ")}`,
      );
    }
  }
}
