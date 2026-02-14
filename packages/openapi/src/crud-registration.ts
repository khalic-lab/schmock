/// <reference path="../../core/schmock.d.ts" />

import type { JSONSchema7 } from "json-schema";
import type { CrudOperation, CrudResource } from "./crud-detector.js";
import {
  createCreateGenerator,
  createDeleteGenerator,
  createListGenerator,
  createReadGenerator,
  createStaticGenerator,
  createUpdateGenerator,
  findArrayProperty,
} from "./generators.js";
import type { ParsedPath } from "./parser.js";
import { isRecord } from "./utils.js";

export function registerCrudRoutes(
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

export function registerNonCrudRoutes(
  instance: Schmock.CallableMockInstance,
  nonCrudPaths: ParsedPath[],
  fakerSeed?: number,
): void {
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
    instance(routeKey, createStaticGenerator(parsedPath, fakerSeed), config);
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
export function applyOverrides(
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
export function logResourceDetection(
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
