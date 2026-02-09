/// <reference path="../../core/schmock.d.ts" />

import { randomUUID } from "node:crypto";
import { generateFromSchema } from "@schmock/faker";
import type { JSONSchema7 } from "json-schema";
import type { CrudResource } from "./crud-detector.js";
import type { ParsedPath } from "./parser.js";
import { isRecord } from "./utils.js";

const COLLECTION_STATE_PREFIX = "openapi:collections:";

/**
 * Result of finding the array property in a response schema.
 * If property is undefined, the schema is a flat array (or unknown).
 */
interface ArrayPropertyInfo {
  /** Property name holding the array (e.g. "data"), undefined for flat arrays */
  property?: string;
  /** Schema for the array items */
  itemSchema?: JSONSchema7;
}

/**
 * Find which property in a response schema holds the array of items.
 * Handles flat arrays, object wrappers (Stripe), and allOf compositions (Scalar Galaxy).
 */
export function findArrayProperty(schema: JSONSchema7): ArrayPropertyInfo {
  if (!schema || typeof schema === "boolean") return {};

  // Case 1: flat array
  if (schema.type === "array") {
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    const itemSchema = isRecord(items) ? (items as JSONSchema7) : undefined;
    return { itemSchema };
  }

  // Case 2: object with properties — scan for the array property
  if (schema.type === "object" && isRecord(schema.properties)) {
    return findArrayInProperties(schema.properties);
  }

  // Case 3: allOf — merge branches into one virtual object, then scan
  if (Array.isArray(schema.allOf)) {
    const merged: Record<string, JSONSchema7> = {};
    for (const branch of schema.allOf) {
      if (isRecord(branch) && isRecord(branch.properties)) {
        for (const [key, value] of Object.entries(branch.properties)) {
          if (isRecord(value)) {
            merged[key] = value as JSONSchema7;
          }
        }
      }
    }
    if (Object.keys(merged).length > 0) {
      return findArrayInProperties(merged);
    }
  }

  // Case 4: anyOf/oneOf — try first branch
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0) {
      const first = branches[0];
      if (isRecord(first)) {
        return findArrayProperty(first as JSONSchema7);
      }
    }
  }

  return {};
}

function findArrayInProperties(
  properties: Record<string, unknown>,
): ArrayPropertyInfo {
  for (const [key, value] of Object.entries(properties)) {
    if (!isRecord(value)) continue;
    const prop = value as JSONSchema7;
    if (prop.type === "array" && prop.items) {
      const items = Array.isArray(prop.items) ? prop.items[0] : prop.items;
      const itemSchema = isRecord(items) ? (items as JSONSchema7) : undefined;
      return { property: key, itemSchema };
    }
  }
  return {};
}

/**
 * Generate header values from spec-defined response header definitions.
 */
export function generateHeaderValues(
  headerDefs: Record<string, Schmock.ResponseHeaderDef> | undefined,
): Record<string, string> {
  if (!headerDefs) return {};

  const headers: Record<string, string> = {};

  for (const [name, def] of Object.entries(headerDefs)) {
    const value = generateSingleHeaderValue(def.schema);
    if (value !== undefined) {
      headers[name] = value;
    }
  }

  return headers;
}

function generateSingleHeaderValue(
  schema: JSONSchema7 | undefined,
): string | undefined {
  if (!schema || typeof schema === "boolean") return undefined;

  // Has enum → first value
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return String(schema.enum[0]);
  }

  // Has default (from example → default normalization)
  if ("default" in schema && schema.default !== undefined) {
    return String(schema.default);
  }

  // Format-based generation
  if (schema.format === "uuid") {
    return randomUUID();
  }
  if (schema.format === "date-time") {
    return new Date().toISOString();
  }

  // Type-based fallback
  if (schema.type === "integer" || schema.type === "number") {
    return "0";
  }
  if (schema.type === "string") {
    return "";
  }

  return undefined;
}

function toTuple(status: number, body: unknown): [number, unknown] {
  return [status, body];
}

function collectionKey(resourceName: string): string {
  return `${COLLECTION_STATE_PREFIX}${resourceName}`;
}

function getCollection(
  state: Record<string, unknown>,
  resourceName: string,
): unknown[] {
  const key = collectionKey(resourceName);
  if (!Array.isArray(state[key])) {
    state[key] = [];
  }
  const value = state[key];
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function getNextId(
  state: Record<string, unknown>,
  resourceName: string,
): number {
  const counterKey = `openapi:counter:${resourceName}`;
  const current = state[counterKey];
  const base = typeof current === "number" ? current : 0;
  const next = base + 1;
  state[counterKey] = next;
  return next;
}

export function createListGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
): Schmock.GeneratorFunction {
  // Pre-compute wrapper info at setup time
  const wrapperInfo = meta?.responseSchema
    ? findArrayProperty(meta.responseSchema)
    : undefined;
  const headerDefs = meta?.responseHeaders;

  return (ctx: Schmock.RequestContext) => {
    const collection = getCollection(ctx.state, resource.name);
    const items = [...collection];

    // If no wrapper detected or flat array, return items directly
    if (!wrapperInfo?.property || !meta?.responseSchema) {
      return addHeaders(items, headerDefs);
    }

    // Generate the full wrapper skeleton from schema, then inject live data
    const skeleton = generateWrapperSkeleton(meta.responseSchema);
    if (isRecord(skeleton)) {
      skeleton[wrapperInfo.property] = items;
      return addHeaders(skeleton, headerDefs);
    }

    return addHeaders(items, headerDefs);
  };
}

export function createCreateGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
): Schmock.GeneratorFunction {
  const headerDefs = meta?.responseHeaders;

  return (ctx: Schmock.RequestContext) => {
    const collection = getCollection(ctx.state, resource.name);
    const id = getNextId(ctx.state, resource.name);

    let item: Record<string, unknown>;
    if (isRecord(ctx.body)) {
      item = {
        ...ctx.body,
        [resource.idParam]: id,
      };
    } else {
      item = { [resource.idParam]: id };
    }

    collection.push(item);
    return addHeaders(toTuple(201, item), headerDefs);
  };
}

export function createReadGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
): Schmock.GeneratorFunction {
  const headerDefs = meta?.responseHeaders;

  return (ctx: Schmock.RequestContext) => {
    const collection = getCollection(ctx.state, resource.name);
    const idValue = ctx.params[resource.idParam];
    const item = findById(collection, resource.idParam, idValue);

    if (!item) {
      return generateErrorResponse(404, meta);
    }

    return addHeaders(item, headerDefs);
  };
}

export function createUpdateGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
): Schmock.GeneratorFunction {
  const headerDefs = meta?.responseHeaders;

  return (ctx: Schmock.RequestContext) => {
    const collection = getCollection(ctx.state, resource.name);
    const idValue = ctx.params[resource.idParam];
    const index = findIndexById(collection, resource.idParam, idValue);

    if (index === -1) {
      return generateErrorResponse(404, meta);
    }

    const existingRaw = collection[index];
    const existing = isRecord(existingRaw) ? existingRaw : {};
    const updated = {
      ...existing,
      ...(isRecord(ctx.body) ? ctx.body : {}),
      [resource.idParam]: existing[resource.idParam], // Preserve ID
    };
    collection[index] = updated;
    return addHeaders(updated, headerDefs);
  };
}

export function createDeleteGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
): Schmock.GeneratorFunction {
  return (ctx: Schmock.RequestContext) => {
    const collection = getCollection(ctx.state, resource.name);
    const idValue = ctx.params[resource.idParam];
    const index = findIndexById(collection, resource.idParam, idValue);

    if (index === -1) {
      return generateErrorResponse(404, meta);
    }

    collection.splice(index, 1);
    return toTuple(204, undefined);
  };
}

export function createStaticGenerator(
  parsedPath: ParsedPath,
  seed?: number,
): Schmock.GeneratorFunction {
  // Get the success response schema
  let responseSchema: JSONSchema7 | undefined;
  for (const code of [200, 201]) {
    const resp = parsedPath.responses.get(code);
    if (resp?.schema) {
      responseSchema = resp.schema;
      break;
    }
  }
  if (!responseSchema) {
    for (const [code, resp] of parsedPath.responses) {
      if (code >= 200 && code < 300 && resp.schema) {
        responseSchema = resp.schema;
        break;
      }
    }
  }

  return () => {
    if (responseSchema) {
      try {
        return generateFromSchema({ schema: responseSchema, seed });
      } catch (error) {
        console.warn(
          `[@schmock/openapi] Schema generation failed for ${parsedPath.method} ${parsedPath.path}:`,
          error instanceof Error ? error.message : error,
        );
        return {};
      }
    }
    return toTuple(200, {});
  };
}

/**
 * Generate seed items for a resource using its schema.
 */
export function generateSeedItems(
  schema: JSONSchema7,
  count: number,
  idParam: string,
  seed?: number,
): unknown[] {
  const items: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const generated = generateFromSchema({ schema, seed });
    const item: Record<string, unknown> = isRecord(generated)
      ? generated
      : { value: generated };
    item[idParam] = i + 1;
    items.push(item);
  }
  return items;
}

/**
 * Generate an error response using the spec's error schema if available,
 * or fall back to the default { error, code } format.
 */
function generateErrorResponse(
  status: number,
  meta?: Schmock.CrudOperationMeta,
): [number, unknown] | [number, unknown, Record<string, string>] {
  const errorSchema = meta?.errorSchemas?.get(status);
  if (errorSchema) {
    try {
      const body = generateFromSchema({ schema: errorSchema });
      return toTuple(status, body);
    } catch {
      // Fall through to default
    }
  }

  // Default error format
  const defaults: Record<number, { error: string; code: string }> = {
    404: { error: "Not found", code: "NOT_FOUND" },
    400: { error: "Bad request", code: "BAD_REQUEST" },
    409: { error: "Conflict", code: "CONFLICT" },
  };
  return toTuple(status, defaults[status] ?? { error: "Error", code: "ERROR" });
}

/**
 * Generate a skeleton object from a response schema.
 * Used to create wrapper objects (e.g. { data: [], has_more: false, object: "list" })
 */
function generateWrapperSkeleton(schema: JSONSchema7): unknown {
  try {
    return generateFromSchema({ schema });
  } catch {
    return {};
  }
}

/**
 * If response headers are defined, convert a response value into a triple [status, body, headers].
 * Otherwise return the value as-is.
 */
function addHeaders(
  value: Schmock.ResponseResult,
  headerDefs: Record<string, Schmock.ResponseHeaderDef> | undefined,
): Schmock.ResponseResult {
  const headers = generateHeaderValues(headerDefs);
  if (Object.keys(headers).length === 0) {
    return value;
  }

  // If already a tuple [status, body] or [status, body, headers]
  if (Array.isArray(value) && value.length >= 2) {
    const status = typeof value[0] === "number" ? value[0] : 200;
    return [status, value[1], headers];
  }

  // Plain value → [200, body, headers]
  return [200, value, headers];
}

function findById(
  collection: unknown[],
  idParam: string,
  idValue: string,
): unknown | undefined {
  return collection.find((item) => {
    if (!isRecord(item)) return false;
    return String(item[idParam]) === String(idValue);
  });
}

function findIndexById(
  collection: unknown[],
  idParam: string,
  idValue: string,
): number {
  return collection.findIndex((item) => {
    if (!isRecord(item)) return false;
    return String(item[idParam]) === String(idValue);
  });
}
