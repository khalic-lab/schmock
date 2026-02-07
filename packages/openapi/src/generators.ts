/// <reference path="../../../types/schmock.d.ts" />

import { generateFromSchema } from "@schmock/schema";
import type { JSONSchema7 } from "json-schema";
import type { CrudResource } from "./crud-detector.js";
import type { ParsedPath } from "./parser.js";
import { isRecord } from "./utils.js";

const COLLECTION_STATE_PREFIX = "openapi:collections:";

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
): Schmock.GeneratorFunction {
  return (ctx: Schmock.RequestContext) => {
    const collection = getCollection(ctx.state, resource.name);
    return [...collection];
  };
}

export function createCreateGenerator(
  resource: CrudResource,
): Schmock.GeneratorFunction {
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
    return toTuple(201, item);
  };
}

export function createReadGenerator(
  resource: CrudResource,
): Schmock.GeneratorFunction {
  return (ctx: Schmock.RequestContext) => {
    const collection = getCollection(ctx.state, resource.name);
    const idValue = ctx.params[resource.idParam];
    const item = findById(collection, resource.idParam, idValue);

    if (!item) {
      return toTuple(404, { error: "Not found", code: "NOT_FOUND" });
    }

    return item;
  };
}

export function createUpdateGenerator(
  resource: CrudResource,
): Schmock.GeneratorFunction {
  return (ctx: Schmock.RequestContext) => {
    const collection = getCollection(ctx.state, resource.name);
    const idValue = ctx.params[resource.idParam];
    const index = findIndexById(collection, resource.idParam, idValue);

    if (index === -1) {
      return toTuple(404, { error: "Not found", code: "NOT_FOUND" });
    }

    const existingRaw = collection[index];
    const existing = isRecord(existingRaw) ? existingRaw : {};
    const updated = {
      ...existing,
      ...(isRecord(ctx.body) ? ctx.body : {}),
      [resource.idParam]: existing[resource.idParam], // Preserve ID
    };
    collection[index] = updated;
    return updated;
  };
}

export function createDeleteGenerator(
  resource: CrudResource,
): Schmock.GeneratorFunction {
  return (ctx: Schmock.RequestContext) => {
    const collection = getCollection(ctx.state, resource.name);
    const idValue = ctx.params[resource.idParam];
    const index = findIndexById(collection, resource.idParam, idValue);

    if (index === -1) {
      return toTuple(404, { error: "Not found", code: "NOT_FOUND" });
    }

    collection.splice(index, 1);
    return toTuple(204, undefined);
  };
}

export function createStaticGenerator(
  parsedPath: ParsedPath,
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
        return generateFromSchema({ schema: responseSchema });
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
): unknown[] {
  const items: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const generated = generateFromSchema({ schema });
    const item: Record<string, unknown> = isRecord(generated)
      ? generated
      : { value: generated };
    item[idParam] = i + 1;
    items.push(item);
  }
  return items;
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
