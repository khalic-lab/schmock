/// <reference path="../../../types/schmock.d.ts" />

import type { JSONSchema7 } from "json-schema";
import type { ParsedPath } from "./parser.js";
import { isRecord, toJsonSchema } from "./utils.js";

export type CrudOperation = "list" | "create" | "read" | "update" | "delete";

export interface CrudResource {
  /** Resource name e.g. "pets" */
  name: string;
  /** Collection path e.g. "/pets" */
  basePath: string;
  /** Item path e.g. "/pets/:petId" */
  itemPath: string;
  /** ID parameter name e.g. "petId" */
  idParam: string;
  /** Detected CRUD operations */
  operations: CrudOperation[];
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
    const resource = buildResource(basePath, groupPaths);
    if (resource) {
      resources.push(resource);
    } else {
      // If no CRUD pattern detected, treat as non-CRUD
      nonCrudPaths.push(...groupPaths);
    }
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

function buildResource(
  basePath: string,
  paths: ParsedPath[],
): CrudResource | undefined {
  const operations: CrudOperation[] = [];
  let itemPath = "";
  let idParam = "";
  let schema: JSONSchema7 | undefined;

  for (const p of paths) {
    const isCollection = p.path === basePath;
    const isItem = !isCollection && p.path.startsWith(basePath);

    if (isCollection) {
      if (p.method === "GET") {
        operations.push("list");
        // Try to extract item schema from list response (array items)
        const listSchema = getSuccessResponseSchema(p);
        if (listSchema && listSchema.type === "array" && listSchema.items) {
          const items = Array.isArray(listSchema.items)
            ? listSchema.items[0]
            : listSchema.items;
          if (isRecord(items)) {
            schema = schema ?? toJsonSchema(items);
          }
        }
      } else if (p.method === "POST") {
        operations.push("create");
      }
    } else if (isItem) {
      // Extract ID param from the item path
      const paramSegments = p.path
        .slice(basePath.length)
        .split("/")
        .filter(Boolean);
      if (paramSegments.length === 1 && paramSegments[0].startsWith(":")) {
        const param = paramSegments[0].slice(1);
        if (!idParam) {
          idParam = param;
          itemPath = p.path;
        }

        if (p.method === "GET") {
          operations.push("read");
          schema = schema ?? getSuccessResponseSchema(p);
        } else if (p.method === "PUT" || p.method === "PATCH") {
          if (!operations.includes("update")) {
            operations.push("update");
          }
        } else if (p.method === "DELETE") {
          operations.push("delete");
        }
      }
    }
  }

  if (operations.length === 0) return undefined;

  // Require evidence of a genuine CRUD collection:
  // either item-level operations (read/update/delete) exist,
  // or both list AND create exist on the collection path.
  // Single GET /health or POST /login don't qualify.
  const hasItemOps = operations.some(
    (op) => op === "read" || op === "update" || op === "delete",
  );
  const hasList = operations.includes("list");
  const hasCreate = operations.includes("create");
  if (!hasItemOps && !(hasList && hasCreate)) return undefined;

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

  return {
    name,
    basePath,
    itemPath,
    idParam,
    operations,
    schema,
  };
}

function getSuccessResponseSchema(p: ParsedPath): JSONSchema7 | undefined {
  // Try 200, then 201, then first 2xx
  for (const code of [200, 201]) {
    const resp = p.responses.get(code);
    if (resp?.schema) return resp.schema;
  }

  for (const [code, resp] of p.responses) {
    if (code >= 200 && code < 300 && resp.schema) return resp.schema;
  }

  return undefined;
}
