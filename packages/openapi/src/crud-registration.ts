import type * as Schmock from "@schmock/core";
import { toRouteKey } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import type {
  CrudOperation,
  CrudResource,
  CrudRouteDescriptor,
} from "./crud-detector.js";
import type { CrudGenerationHooks, GenerationHooks } from "./generators.js";
import {
  createCreateGenerator,
  createDeleteGenerator,
  createListGenerator,
  createReadGenerator,
  createStaticGenerator,
  createUpdateGenerator,
  findArrayProperty,
  idCounter,
} from "./generators.js";
import { OWNER_KEY } from "./owner.js";
import type { ParsedPath } from "./parser.js";
import {
  findRepresentativeResponse,
  findSuccessResponse,
} from "./response-status.js";
import {
  collectionStateKey,
  counterStateKey,
  seededStateKey,
} from "./state-keys.js";
import { isRecord } from "./utils.js";

/**
 * Build the common `openapi:*` route metadata carried by every registered route.
 *
 * `openapi:preflightResponseStatus` is deliberately NOT set here: CRUD sets it
 * only for `create` while non-CRUD sets it whenever a success response exists,
 * and that asymmetry gates `processContentNegotiation` in plugin.ts.
 */
function buildRouteConfig(
  parsedPath: ParsedPath,
  ownerToken: string,
): Schmock.RouteConfig {
  return {
    [OWNER_KEY]: ownerToken,
    "openapi:responses": parsedPath.responses,
    "openapi:path": parsedPath.path,
    "openapi:requestBody": parsedPath.requestBody,
    "openapi:requestBodyRequired": parsedPath.requestBodyRequired,
    "openapi:requestContent": parsedPath.requestContent,
    "openapi:security": parsedPath.security,
    "openapi:callbacks": parsedPath.callbacks,
    "openapi:operationId": parsedPath.operationId,
    "openapi:tags": parsedPath.tags,
  };
}

/**
 * Re-derive the success status at registration time so schema overrides
 * applied before detection are reflected in the status selection.
 *
 * Deliberately `findSuccessResponse`, not the static routes'
 * `findRepresentativeResponse`: a CRUD operation replays or mutates stored
 * state, so a POST declaring only `400` must fall back to the 201 default
 * rather than answer 400 with a created item.
 */
function registrationMeta(
  route: CrudRouteDescriptor,
): Schmock.CrudOperationMeta {
  const successResponse = findSuccessResponse(route.parsed.responses);
  return successResponse
    ? { ...route.meta, responseStatus: successResponse[0] }
    : route.meta;
}

export function registerCrudRoutes(
  instance: Schmock.CallableMockInstance,
  resource: CrudResource,
  seedItems: unknown[] | undefined,
  ownerToken: string,
  hooks: GenerationHooks = {},
): void {
  const ensureSeeded = createSeeder(resource, seedItems);

  for (const route of resource.routes) {
    const routeMeta = registrationMeta(route);
    const genHooks: CrudGenerationHooks = {
      method: route.method,
      path: route.parsed.path,
      ...hooks,
    };
    const gen = createCrudGenerator(route.op, resource, routeMeta, genHooks);

    const config = buildRouteConfig(route.parsed, ownerToken);
    if (route.op === "create" && routeMeta.responseStatus !== undefined) {
      config["openapi:preflightResponseStatus"] = routeMeta.responseStatus;
    }

    instance(
      toRouteKey(route.method, route.path),
      wrapWithSeeder(ensureSeeded, gen),
      config,
    );
  }
}

export function registerNonCrudRoutes(
  instance: Schmock.CallableMockInstance,
  nonCrudPaths: ParsedPath[],
  ownerToken: string,
  hooks: GenerationHooks = {},
): void {
  for (const parsedPath of nonCrudPaths) {
    const routeKey = toRouteKey(parsedPath.method, parsedPath.path);
    const config = buildRouteConfig(parsedPath, ownerToken);
    // Must stay in lockstep with `createStaticGenerator`'s lookup: naming a
    // status the generator never returns would make content negotiation check
    // the wrong entry's media types.
    const declaredResponse = findRepresentativeResponse(parsedPath.responses);
    if (declaredResponse) {
      config["openapi:preflightResponseStatus"] = declaredResponse[0];
    }
    instance(routeKey, createStaticGenerator(parsedPath, hooks), config);
  }
}

function createCrudGenerator(
  op: CrudOperation,
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
  hooks?: CrudGenerationHooks,
): Schmock.GeneratorFunction {
  switch (op) {
    case "list":
      return createListGenerator(resource, meta, hooks);
    case "create":
      return createCreateGenerator(resource, meta, hooks);
    case "read":
      return createReadGenerator(resource, meta, hooks);
    case "update":
      return createUpdateGenerator(resource, meta, hooks);
    case "delete":
      return createDeleteGenerator(resource, meta, hooks);
  }
}

/**
 * Create a seeder function that initializes collection state once per scope.
 *
 * The keys depend on the request's path params, so a nested collection is seeded
 * independently for each distinct parent id from the same `seedItems` array. A
 * shallow copy is enough: update replaces objects with `{...existing, ...updates}`
 * rather than mutating them in place.
 *
 * This is also the ONLY place a legacy `idParam`-keyed seed row is rewritten to
 * the resource's `idProperty`. Everything downstream reads a single key.
 */
function createSeeder(
  resource: CrudResource,
  seedItems?: unknown[],
): (state: Record<string, unknown>, params: Record<string, string>) => void {
  return (state: Record<string, unknown>, params: Record<string, string>) => {
    // Nothing to seed → write NOTHING, not an empty collection and a zero
    // counter. Those writes are semantically no-ops (`getCollection` reads a
    // missing key as `[]`, `getNextId` reads it as `0`) but they allocated
    // three state keys per distinct parent id on plain reads, so an unseeded
    // nested resource grew memory under read-only traffic across a wide id
    // range. They also clobbered collection state a caller pre-loaded through
    // `schmock({ state })`.
    if (!seedItems || seedItems.length === 0) return;

    const seededKey = seededStateKey(resource.basePath, params);
    if (state[seededKey]) return;
    state[seededKey] = true;

    const stateKey = collectionStateKey(resource.basePath, params);
    const counterKey = counterStateKey(resource.basePath, params);

    const rows = seedItems.map((item) => normalizeSeedRow(resource, item));
    state[stateKey] = rows;

    // Scan the NORMALIZED rows: reading the legacy key here would find nothing
    // on a resource whose idProperty differs, restart the counter at 1 and
    // collide with a seeded id. `idCounter` recovers the counter from each id
    // kind — numeric strings and synthetic uuids included — so string- and
    // uuid-keyed resources keep advancing past their seed high-water mark.
    let maxId = 0;
    for (const item of rows) {
      if (!isRecord(item)) continue;
      const counter = idCounter(item[resource.idProperty], resource.idKind);
      if (counter !== undefined && counter > maxId) maxId = counter;
    }
    state[counterKey] = maxId;
  };
}

function normalizeSeedRow(resource: CrudResource, item: unknown): unknown {
  if (!isRecord(item)) return item;
  if (resource.idProperty in item) return item;
  if (!(resource.idParam in item)) return item;
  const { [resource.idParam]: legacyId, ...rest } = item;
  return { ...rest, [resource.idProperty]: legacyId };
}

function wrapWithSeeder(
  seeder: (
    state: Record<string, unknown>,
    params: Record<string, string>,
  ) => void,
  generator: Schmock.GeneratorFunction,
): Schmock.GeneratorFunction {
  return (ctx: Schmock.RequestContext) => {
    seeder(ctx.state, ctx.params);
    return generator(ctx);
  };
}

/**
 * Apply manual overrides to a resource's per-route operation metadata.
 *
 * Every matching descriptor is patched in place, so a spec declaring both PUT
 * and PATCH gets the override on both routes rather than only the first one.
 */
export function applyOverrides(
  resource: CrudResource,
  override: Schmock.ResourceOverride,
): void {
  if (
    override.listWrapProperty !== undefined ||
    override.listFlat !== undefined
  ) {
    for (const route of resource.routes) {
      if (route.op !== "list") continue;
      const listMeta = route.meta;
      // The per-media-type map wins over `responseSchema` at request time, so a
      // list override that only rewrote `responseSchema` would be invisible on
      // every OAS3 spec (they all declare `content`). Drop the map first.
      dropMediaTypeContracts(listMeta);

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
    }
  }

  if (override.errorSchema) {
    const errorSchemaMap = new Map<number, JSONSchema7>();
    errorSchemaMap.set(404, override.errorSchema);
    errorSchemaMap.set(400, override.errorSchema);
    errorSchemaMap.set(409, override.errorSchema);

    for (const route of resource.routes) {
      if (
        route.op === "read" ||
        route.op === "update" ||
        route.op === "delete"
      ) {
        route.meta.errorSchemas = errorSchemaMap;
      }
    }
  }
}

/**
 * Forget an operation's per-media-type success contracts so `responseSchema`
 * becomes the effective one again.
 */
function dropMediaTypeContracts(meta: Schmock.CrudOperationMeta): void {
  meta.responseSchemasByMediaType = undefined;
  meta.responseContentTypes = undefined;
}

/**
 * Log resource detection info for debug mode.
 */
export function logResourceDetection(
  resource: CrudResource,
  override?: Schmock.ResourceOverride,
): void {
  const listMeta = resource.routes.find((r) => r.op === "list")?.meta;
  let listFormat = "flat";
  if (listMeta?.responseSchema) {
    const arrayInfo = findArrayProperty(listMeta.responseSchema);
    if (arrayInfo.property) {
      const hasAllOf = "allOf" in (listMeta.responseSchema ?? {});
      listFormat = `wrapped("${arrayInfo.property}"${hasAllOf ? " via allOf" : ""})`;
    }
  }

  const readMeta = resource.routes.find((r) => r.op === "read")?.meta;
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
