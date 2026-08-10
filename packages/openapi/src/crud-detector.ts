import type * as Schmock from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { collectSchemaProperties, findArrayProperty } from "./generators.js";
import type { ParsedPath } from "./parser.js";
import { findSuccessResponse } from "./response-status.js";
import { hasType, isRecord, toJsonSchema } from "./utils.js";

export type CrudOperation = "list" | "create" | "read" | "update" | "delete";

/** How new identifier values are minted for a resource. */
export type IdKind = "integer" | "string" | "uuid";

/**
 * One concrete, spec-declared HTTP method mapped onto a CRUD role.
 *
 * There is exactly one descriptor per declared operation, so `PUT` and `PATCH`
 * on the same item path each keep their own response contract instead of
 * collapsing onto a single shared `update` entry.
 */
export interface CrudRouteDescriptor {
  /** CRUD role this concrete method plays. */
  op: CrudOperation;
  /** Concrete declared method e.g. "PUT". */
  method: Schmock.HttpMethod;
  /** Concrete path this method was declared on e.g. "/pets/:petId". */
  path: string;
  /** The ParsedPath this descriptor came from (the object install() mutates). */
  parsed: ParsedPath;
  /** Metadata built from THIS method's own operation object. */
  meta: Schmock.CrudOperationMeta;
}

export interface CrudResource {
  /** Resource name e.g. "pets" */
  name: string;
  /** Collection path e.g. "/pets" */
  basePath: string;
  /** Item path e.g. "/pets/:petId" */
  itemPath: string;
  /** ID parameter name e.g. "petId" — always the path segment, never renamed */
  idParam: string;
  /**
   * Property carrying the primary key on stored and created items.
   *
   * The lookup VALUE always comes from `ctx.params[idParam]`; only the stored
   * property NAME follows this field, so path routing is untouched.
   */
  idProperty: string;
  /** How new identifier values are minted for this resource. */
  idKind: IdKind;
  /** Detected CRUD operations, deduped, in discovery order */
  operations: CrudOperation[];
  /** One entry per declared method — the registration source of truth */
  routes: CrudRouteDescriptor[];
  /** Response schema for the resource item */
  schema?: JSONSchema7;
}

interface DetectionResult {
  resources: CrudResource[];
  /** Paths that didn't match any CRUD pattern */
  nonCrudPaths: ParsedPath[];
}

/**
 * Detect CRUD resource patterns from parsed OpenAPI paths.
 *
 * Patterns:
 * - GET /resources       → list
 * - POST /resources      → create
 * - GET /resources/:id   → read
 * - PUT/PATCH /resources/:id → update
 * - DELETE /resources/:id    → delete
 */
export function detectCrudResources(paths: ParsedPath[]): DetectionResult {
  // Group paths by their base path (strip trailing /:param)
  const groups = new Map<string, ParsedPath[]>();
  const nonCrudPaths: ParsedPath[] = [];

  for (const p of paths) {
    const basePath = getCollectionPath(p.path);
    if (!basePath) {
      nonCrudPaths.push(p);
      continue;
    }
    const existing = groups.get(basePath) ?? [];
    existing.push(p);
    groups.set(basePath, existing);
  }

  const resources: CrudResource[] = [];

  for (const [basePath, groupPaths] of groups) {
    const { resource, leftovers } = buildResource(basePath, groupPaths);
    if (resource) {
      resources.push(resource);
    }
    // Either the whole group (no CRUD pattern detected) or the methods the CRUD
    // generators cannot serve — both are registered as static routes rather
    // than silently swallowed.
    nonCrudPaths.push(...leftovers);
  }

  return { resources, nonCrudPaths };
}

/**
 * Extract the collection base path from a path.
 * "/pets" → "/pets"
 * "/pets/:petId" → "/pets"
 * "/owners/:ownerId/pets" → "/owners/:ownerId/pets"
 * "/owners/:ownerId/pets/:petId" → "/owners/:ownerId/pets"
 */
function getCollectionPath(path: string): string | undefined {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;

  // If last segment is a param (:xyz), remove it to get collection path
  const last = segments[segments.length - 1];
  if (last.startsWith(":")) {
    return `/${segments.slice(0, -1).join("/")}`;
  }

  // Otherwise the path itself is a potential collection path
  return `/${segments.join("/")}`;
}

interface BuildResourceResult {
  resource?: CrudResource;
  /** Paths in this group that no CRUD generator can serve. */
  leftovers: ParsedPath[];
}

/**
 * Split a path in a group into its trailing `:param` segment, if it has exactly
 * one and the path really sits under `basePath`.
 */
function itemIdParam(basePath: string, path: string): string | undefined {
  if (!path.startsWith(basePath)) return undefined;
  const segments = path.slice(basePath.length).split("/").filter(Boolean);
  if (segments.length !== 1 || !segments[0].startsWith(":")) return undefined;
  return segments[0].slice(1);
}

function buildResource(
  basePath: string,
  paths: ParsedPath[],
): BuildResourceResult {
  // Pass 1 — the first item-shaped path in the group fixes idParam/itemPath.
  let itemPath = "";
  let idParam = "";
  for (const p of paths) {
    if (p.path === basePath) continue;
    const param = itemIdParam(basePath, p.path);
    if (param) {
      idParam = param;
      itemPath = p.path;
      break;
    }
  }

  // Pass 2 — classify each declared method, preserving iteration order so the
  // `schema = schema ?? …` fallback chain resolves exactly as it did before.
  const routes: CrudRouteDescriptor[] = [];
  const leftovers: ParsedPath[] = [];
  let schema: JSONSchema7 | undefined;

  const classify = (p: ParsedPath, op: CrudOperation) => {
    routes.push({
      op,
      method: p.method,
      path: p.path,
      parsed: p,
      meta: buildOperationMeta(p),
    });
  };

  for (const p of paths) {
    if (p.path === basePath) {
      if (p.method === "GET") {
        const listSchema = getSuccessResponseSchema(p);
        if (listSchema) {
          // Extract item schema from both flat arrays and wrapped lists
          const arrayInfo = findArrayProperty(listSchema);
          if (arrayInfo.itemSchema) {
            schema = schema ?? arrayInfo.itemSchema;
          } else if (hasType(listSchema, "array") && listSchema.items) {
            // Fallback: direct flat array
            const items = Array.isArray(listSchema.items)
              ? listSchema.items[0]
              : listSchema.items;
            if (isRecord(items)) {
              schema = schema ?? toJsonSchema(items);
            }
          }
        }
        classify(p, "list");
      } else if (p.method === "POST") {
        classify(p, "create");
      } else {
        leftovers.push(p);
      }
      continue;
    }

    // Item paths must use the id param the resource settled on: a CRUD
    // generator only ever reads ctx.params[resource.idParam], so an aliased
    // param (PUT /pets/:id next to GET /pets/:petId) would 404 forever.
    if (p.path !== itemPath) {
      leftovers.push(p);
      continue;
    }

    if (p.method === "GET") {
      schema = schema ?? getSuccessResponseSchema(p);
      classify(p, "read");
    } else if (p.method === "PUT" || p.method === "PATCH") {
      classify(p, "update");
    } else if (p.method === "DELETE") {
      classify(p, "delete");
    } else {
      leftovers.push(p);
    }
  }

  const operations = [...new Set(routes.map((r) => r.op))];

  if (operations.length === 0) return { leftovers: paths };

  // Require evidence of a genuine CRUD collection:
  // either item-level operations (read/update/delete) exist,
  // or both list AND create exist on the collection path.
  // Single GET /health or POST /login don't qualify.
  const hasItemOps = operations.some(
    (op) => op === "read" || op === "update" || op === "delete",
  );
  const hasList = operations.includes("list");
  const hasCreate = operations.includes("create");
  if (!hasItemOps && !(hasList && hasCreate)) return { leftovers: paths };

  // If we only have collection operations, infer item path
  if (!itemPath) {
    const resourceName = basePath.split("/").filter(Boolean).pop() ?? "";
    const singular = resourceName.endsWith("s")
      ? resourceName.slice(0, -1)
      : resourceName;
    idParam = `${singular}Id`;
    itemPath = `${basePath}/:${idParam}`;
  }

  const name = basePath.split("/").filter(Boolean).pop() ?? basePath;
  const { idProperty, idKind } = resolveIdentifier(schema, idParam);

  return {
    resource: {
      name,
      basePath,
      itemPath,
      idParam,
      idProperty,
      idKind,
      operations,
      routes,
      schema,
    },
    leftovers,
  };
}

/**
 * Decide which property carries the resource's primary key, and how new values
 * for it are minted. Resolved once per resource from the item schema.
 *
 * - the path parameter's name (`petId`) when the item schema declares it;
 * - otherwise `id` when the schema declares that;
 * - otherwise the path parameter's name, so schema-less specs keep the old
 *   behaviour.
 */
function resolveIdentifier(
  schema: JSONSchema7 | undefined,
  idParam: string,
): { idProperty: string; idKind: IdKind } {
  const props = collectSchemaProperties(schema);
  const idProperty =
    idParam in props ? idParam : "id" in props ? "id" : idParam;
  const declared = props[idProperty];
  const type = Array.isArray(declared?.type)
    ? declared.type.find((t) => t !== "null")
    : declared?.type;

  if (type !== "string") return { idProperty, idKind: "integer" };
  return {
    idProperty,
    idKind: declared?.format === "uuid" ? "uuid" : "string",
  };
}

function buildOperationMeta(p: ParsedPath): Schmock.CrudOperationMeta {
  const meta: Schmock.CrudOperationMeta = {};

  const successResponse = findSuccessResponse(p.responses);
  if (successResponse) {
    const [status, response] = successResponse;
    meta.responseStatus = status;
    if (response.schema) meta.responseSchema = response.schema;
    if (response.headers) meta.responseHeaders = response.headers;

    // Per-media-type contracts, so a CRUD route can honour a negotiated
    // `Accept` the same way a static route already does.
    if (response.contentTypes?.length) {
      meta.responseContentTypes = [...response.contentTypes];
    }
    if (response.content && response.content.size > 0) {
      const byMediaType = new Map<string, JSONSchema7>();
      for (const [mediaType, content] of response.content) {
        if (content.schema) byMediaType.set(mediaType, content.schema);
      }
      if (byMediaType.size > 0) {
        meta.responseSchemasByMediaType = byMediaType;
      }
    }
  }

  // Capture error response schemas (4xx)
  const errorSchemas = new Map<number, JSONSchema7>();
  for (const [code, resp] of p.responses) {
    if (typeof code === "number" && code >= 400 && code < 600 && resp.schema) {
      errorSchemas.set(code, resp.schema);
    }
  }
  if (errorSchemas.size > 0) {
    meta.errorSchemas = errorSchemas;
  }

  return meta;
}

function getSuccessResponseSchema(p: ParsedPath): JSONSchema7 | undefined {
  return findSuccessResponse(p.responses)?.[1].schema;
}
