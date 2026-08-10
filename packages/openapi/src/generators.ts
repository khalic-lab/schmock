import { randomUUID } from "node:crypto";
import type * as Schmock from "@schmock/core";
import {
  ResourceLimitError,
  SchemaGenerationError,
  SchmockError,
} from "@schmock/core";
import { generateFromSchema } from "@schmock/faker";
import type { JSONSchema7 } from "json-schema";
import { negotiateContentType } from "./content-negotiation.js";
import type { CrudResource, IdKind } from "./crud-detector.js";
import { MAX_SEED_GENERATED_NODES } from "./limits.js";
import type { ParsedPath, ParsedResponseEntry } from "./parser.js";
import type { OnSchemaCallback } from "./plugin.js";
import { findRepresentativeResponse } from "./response-status.js";
import { collectionStateKey, counterStateKey } from "./state-keys.js";
import { hasType, isRecord, toJsonSchema } from "./utils.js";

/**
 * Wrap a generation failure in a structured, coded error.
 *
 * A `SchmockError` already carries a meaningful code (`RESOURCE_LIMIT_ERROR`,
 * `SCHEMA_VALIDATION_ERROR`, …) and is rethrown untouched, so the root cause is
 * not laundered into a generic one. Everything else becomes a
 * `SchemaGenerationError`, whose message names the route.
 */
export function asSchemaGenerationError(
  error: unknown,
  route: string,
  schema?: unknown,
): Error {
  if (error instanceof SchmockError) return error;
  return new SchemaGenerationError(
    route,
    error instanceof Error ? error : new Error(String(error)),
    schema,
  );
}

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
  if (hasType(schema, "array")) {
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    const itemSchema = isRecord(items) ? toJsonSchema(items) : undefined;
    return { itemSchema };
  }

  // Case 2: object with properties — scan for the array property
  if (hasType(schema, "object") && isRecord(schema.properties)) {
    return findArrayInProperties(schema.properties);
  }

  // Case 3: allOf — merge branches into one virtual object, then scan
  if (Array.isArray(schema.allOf)) {
    const merged: Record<string, JSONSchema7> = {};
    for (const branch of schema.allOf) {
      if (isRecord(branch) && isRecord(branch.properties)) {
        for (const [key, value] of Object.entries(branch.properties)) {
          if (isRecord(value)) {
            merged[key] = toJsonSchema(value);
          }
        }
      }
    }
    if (Object.keys(merged).length > 0) {
      return findArrayInProperties(merged);
    }
  }

  // Case 4: anyOf/oneOf — try the first meaningful branch. The normalizer wraps
  // a composition-only `nullable: true` as `anyOf: [{type:"null"}, rest]`, so a
  // bare null branch must be skipped rather than read as the shape.
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0) {
      for (const branch of branches) {
        if (!isRecord(branch)) continue;
        if (branch.type === "null" && Object.keys(branch).length === 1)
          continue;
        return findArrayProperty(toJsonSchema(branch));
      }
    }
  }

  return {};
}

/**
 * Flatten a schema's declared properties, following `allOf` branches.
 *
 * Used to answer two questions that both need "what does this contract declare":
 * which property carries the primary key, and which request fields survive an
 * `additionalProperties: false` create contract. Earlier branches win, matching
 * the way a merged `allOf` resolves.
 */
export function collectSchemaProperties(
  schema?: JSONSchema7,
): Record<string, JSONSchema7> {
  const out: Record<string, JSONSchema7> = {};

  const visit = (node?: JSONSchema7): void => {
    if (!node || typeof node === "boolean") return;
    if (isRecord(node.properties)) {
      for (const [key, value] of Object.entries(node.properties)) {
        if (isRecord(value) && !(key in out)) out[key] = toJsonSchema(value);
      }
    }
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        if (isRecord(branch)) visit(toJsonSchema(branch));
      }
    }
  };

  visit(schema);
  return out;
}

function findArrayInProperties(
  properties: Record<string, unknown>,
): ArrayPropertyInfo {
  for (const [key, value] of Object.entries(properties)) {
    if (!isRecord(value)) continue;
    const prop = toJsonSchema(value);
    if (hasType(prop, "array") && prop.items) {
      const items = Array.isArray(prop.items) ? prop.items[0] : prop.items;
      const itemSchema = isRecord(items) ? toJsonSchema(items) : undefined;
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

/**
 * Inputs for assembling a spec-driven response.
 */
export interface ResponseBuild {
  /** Declared status; undefined means "plain body, let core default to 200". */
  status?: number;
  body: unknown;
  /** Declared response headers for THIS status, if any. */
  headerDefs?: Record<string, Schmock.ResponseHeaderDef>;
}

/**
 * Single assembly point for every spec-driven response shape.
 *
 * Deliberately a pure function of the struct fields: it never inspects an
 * already-assembled `ResponseResult`, because sniffing a value that happens to
 * be an array of length >= 2 misreads a flat list body as a `[status, body]`
 * tuple. 204-body suppression lives here and nowhere else.
 */
export function buildResponse(build: ResponseBuild): Schmock.ResponseResult {
  const headers = generateHeaderValues(build.headerDefs);
  const hasHeaders = Object.keys(headers).length > 0;

  if (build.status === undefined) {
    return hasHeaders ? [200, build.body, headers] : build.body;
  }

  const body = build.status === 204 ? undefined : build.body;
  return hasHeaders ? [build.status, body, headers] : [build.status, body];
}

/** Read (creating if absent) the collection stored under an already-resolved key. */
function getCollection(state: Record<string, unknown>, key: string): unknown[] {
  if (!Array.isArray(state[key])) {
    state[key] = [];
  }
  const value = state[key];
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

/** Advance and return the id counter stored under an already-resolved key. */
function getNextId(state: Record<string, unknown>, key: string): number {
  const current = state[key];
  const base = typeof current === "number" ? current : 0;
  const next = base + 1;
  state[key] = next;
  return next;
}

/**
 * Mint the next identifier for a resource, shaped after the declared type of
 * its id property.
 *
 * The UUID form is synthetic rather than `randomUUID()` on purpose: `ajv-formats`
 * is registered, so `format: uuid` is enforced under `validateResponses` and the
 * value must be well-formed — and a `fakerSeed` run has to stay reproducible.
 */
const SYNTHETIC_UUID_PREFIX = "00000000-0000-4000-8000-";

/**
 * Shape a monotonic counter into an identifier of the resource's declared kind.
 *
 * Shared by `mintId` (create) and `generateSeedItems` (seeding) so a resource's
 * seeded and server-assigned identifiers are the same type — a `type: string`
 * or `format: uuid` resource must not carry integer seeds and string/uuid
 * creates in one collection.
 */
function shapeId(counter: number, idKind: IdKind): number | string {
  if (idKind === "integer") return counter;
  if (idKind === "string") return String(counter);
  return `${SYNTHETIC_UUID_PREFIX}${String(counter).padStart(12, "0")}`;
}

/**
 * Recover the counter an identifier encodes, so the mint counter can resume
 * past the seed high-water mark regardless of id kind. Integer and string ids
 * carry the counter as their numeric value; a synthetic uuid carries it in the
 * node field. Returns `undefined` for an id this scheme did not mint (a real
 * uuid, a non-numeric string), which the caller simply skips.
 */
export function idCounter(value: unknown, idKind: IdKind): number | undefined {
  if (idKind === "uuid") {
    if (typeof value !== "string" || !value.startsWith(SYNTHETIC_UUID_PREFIX)) {
      return undefined;
    }
    const n = Number(value.slice(SYNTHETIC_UUID_PREFIX.length));
    return Number.isInteger(n) ? n : undefined;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function mintId(
  state: Record<string, unknown>,
  counterKey: string,
  idKind: IdKind,
): number | string {
  return shapeId(getNextId(state, counterKey), idKind);
}

/**
 * Per-route generation context handed to the CRUD generators.
 *
 * Optional everywhere so unit tests can keep calling the factories with two
 * arguments.
 */
export interface CrudGenerationHooks {
  /** Concrete declared method, e.g. "POST". */
  method: string;
  /** Spec path this generator was registered on, e.g. "/pets/:petId". */
  path: string;
  fakerSeed?: number;
  onSchema?: OnSchemaCallback;
}

/**
 * Give `options.onSchema` a chance to rewrite a schema before generation.
 *
 * Fires only where a body is actually generated: the create response contract,
 * the list wrapper skeleton, and CRUD error bodies. Read/update/delete replay
 * stored state, so they only reach it on their 404 path.
 */
function applyOnSchema(
  schema: JSONSchema7 | undefined,
  hooks: CrudGenerationHooks | undefined,
  ctx: Schmock.RequestContext,
): JSONSchema7 | undefined {
  if (!schema || !hooks?.onSchema) return schema;
  const patched = hooks.onSchema(schema, {
    method: hooks.method,
    path: hooks.path,
    params: ctx.params,
    query: ctx.query,
    headers: ctx.headers,
  });
  return patched ?? schema;
}

/**
 * Pick the response schema matching the request's `Accept` header.
 *
 * One rule for both the static and the CRUD path: when the operation declares
 * media types with schemas, negotiate among them (falling back to the first
 * declared type when the request states no preference); otherwise use the
 * JSON-ish default the parser already resolved.
 */
function selectSchemaForAccept(
  source: {
    contentTypes?: string[];
    byMediaType?: Map<string, JSONSchema7>;
    fallback?: JSONSchema7;
  },
  headers: Record<string, string>,
): JSONSchema7 | undefined {
  const types = source.contentTypes;
  if (types?.length && source.byMediaType && source.byMediaType.size > 0) {
    const accept = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "accept",
    )?.[1];
    const mediaType = accept ? negotiateContentType(accept, types) : types[0];
    return mediaType ? source.byMediaType.get(mediaType) : undefined;
  }
  return source.fallback;
}

/** `selectSchemaForAccept` over a CRUD operation's success contract. */
function metaSchema(
  meta: Schmock.CrudOperationMeta | undefined,
  headers: Record<string, string>,
): JSONSchema7 | undefined {
  return selectSchemaForAccept(
    {
      contentTypes: meta?.responseContentTypes,
      byMediaType: meta?.responseSchemasByMediaType,
      fallback: meta?.responseSchema,
    },
    headers,
  );
}

/** Key under which `RequestContext.pluginState` holds this request's staged mutations. */
export const PENDING_MUTATIONS_KEY = "openapi:pendingMutations";

type PendingMutation = () => void;

/**
 * Defer a collection mutation until the plugin knows the final response status.
 *
 * A `Prefer: code=400`, a 406 from response content negotiation, or a response
 * validation failure must not leave a half-applied write behind. The plugin's
 * `process()` commits the queue on success and discards it otherwise.
 *
 * When a generator is invoked outside the request pipeline (unit tests calling
 * it directly) there is no `pluginState`, so the mutation is applied
 * immediately — the pre-staging behavior.
 */
function stageMutation(
  ctx: Schmock.RequestContext,
  mutate: PendingMutation,
): void {
  const store = ctx.pluginState;
  if (!store) {
    mutate();
    return;
  }
  const existing = store.get(PENDING_MUTATIONS_KEY);
  if (Array.isArray(existing)) {
    existing.push(mutate);
  } else {
    store.set(PENDING_MUTATIONS_KEY, [mutate]);
  }
}

export function createListGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
  hooks?: CrudGenerationHooks,
): Schmock.GeneratorFunction {
  const headerDefs = meta?.responseHeaders;
  const responseStatus = meta?.responseStatus;
  // The wrapper shape depends on the negotiated media type, so it can only be
  // resolved per request. Memoized per schema object: without `onSchema` the
  // keys are the route's declared media-type schemas, a bounded set. A hook
  // that returns a fresh object per request simply misses the memo — a WeakMap
  // keeps that from accumulating.
  const wrapperMemo = new WeakMap<object, ArrayPropertyInfo>();

  return async (ctx: Schmock.RequestContext) => {
    const key = collectionStateKey(resource.basePath, ctx.params);
    const collection = getCollection(ctx.state, key);
    const items = [...collection];

    const schema = metaSchema(meta, ctx.headers);
    const flat = buildResponse({
      status: responseStatus,
      body: items,
      headerDefs,
    });
    if (!schema) return flat;

    // If no wrapper detected or flat array, return items directly — and do not
    // call `onSchema`, since nothing is generated on that path.
    if (!resolveWrapperInfo(schema, wrapperMemo).property) return flat;

    // The hook can reshape the wrapper, so the injection point is re-derived
    // from whatever it returned.
    const effective = applyOnSchema(schema, hooks, ctx) ?? schema;
    const wrapperInfo = resolveWrapperInfo(effective, wrapperMemo);
    if (!wrapperInfo.property) return flat;

    // Generate the full wrapper skeleton from schema, then inject live data
    const skeleton = await generateWrapperSkeleton(effective, hooks?.fakerSeed);
    if (isRecord(skeleton)) {
      skeleton[wrapperInfo.property] = items;
      return buildResponse({
        status: responseStatus,
        body: skeleton,
        headerDefs,
      });
    }

    return flat;
  };
}

function resolveWrapperInfo(
  schema: JSONSchema7,
  memo: WeakMap<object, ArrayPropertyInfo>,
): ArrayPropertyInfo {
  if (typeof schema !== "object" || schema === null) {
    return findArrayProperty(schema);
  }
  const cached = memo.get(schema);
  if (cached) return cached;
  const info = findArrayProperty(schema);
  memo.set(schema, info);
  return info;
}

/**
 * When the create response is an envelope (`{ data: <Resource> }`) rather than
 * the resource itself, find the property that carries the resource, so the
 * stored item stays resource-shaped and only the *response* is wrapped.
 *
 * The response is "item-shaped" — no wrapper — when it declares the resource's
 * own id property at its top level. Otherwise the wrapper is the property whose
 * schema declares that id property. Returns `{}` (item-shaped) when no such
 * property exists, so a spec whose envelope this can't identify is left at the
 * historical behaviour rather than mis-wrapped.
 */
function findResourceWrapper(
  schema: JSONSchema7 | undefined,
  idProperty: string,
): { property?: string } {
  if (!schema || typeof schema === "boolean") return {};
  const top = collectSchemaProperties(schema);
  if (idProperty in top) return {};
  for (const [key, value] of Object.entries(top)) {
    if (idProperty in collectSchemaProperties(value)) return { property: key };
  }
  return {};
}

/**
 * Shallow copy of `schema` with one property removed from `properties` and
 * `required`. Used to generate an envelope's outer shell without re-fabricating
 * the resource that is about to be injected into the wrapper slot.
 */
function withoutProperty(schema: JSONSchema7, property: string): JSONSchema7 {
  if (!isRecord(schema.properties) || !(property in schema.properties)) {
    return schema;
  }
  const properties = { ...schema.properties };
  delete properties[property];
  const clone: JSONSchema7 = { ...schema, properties };
  if (Array.isArray(schema.required)) {
    clone.required = schema.required.filter((name) => name !== property);
  }
  return clone;
}

/**
 * Create an item that satisfies the declared response contract, then overlay
 * the request body onto it.
 *
 * With no declared (or a non-object) create-response schema this degrades to
 * the historical behaviour: echo every defined request field and stamp the id.
 * With a declared object contract the generated body is the base, request
 * fields overwrite it, and undeclared fields survive unless the contract sets
 * `additionalProperties: false`. The identifier is always server-assigned and
 * always beats both the generated and the client-supplied value.
 *
 * When the create response wraps the resource in an envelope, the resource-
 * shaped item is what gets stored (so read/list/update stay consistent), and
 * only the returned body is wrapped — otherwise a `{ data: <Resource> }` create
 * would store a fabricated resource under `data` plus a stray id at the root.
 */
export function createCreateGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
  hooks?: CrudGenerationHooks,
): Schmock.GeneratorFunction {
  const headerDefs = meta?.responseHeaders;
  const responseStatus = meta?.responseStatus ?? 201;

  return async (ctx: Schmock.RequestContext) => {
    const key = collectionStateKey(resource.basePath, ctx.params);
    const counterKey = counterStateKey(resource.basePath, ctx.params);

    const responseSchema = metaSchema(meta, ctx.headers);
    // Only trust an envelope when a resolved item schema exists to store;
    // without one (incomplete specs) keep treating the response schema as the
    // item so nothing regresses.
    const wrapper = resource.schema
      ? findResourceWrapper(responseSchema, resource.idProperty)
      : {};
    const itemSchema = wrapper.property ? resource.schema : responseSchema;
    const effective = applyOnSchema(itemSchema, hooks, ctx);
    const item: Record<string, unknown> = await generateContractBase(
      effective,
      hooks?.fakerSeed,
    );

    if (isRecord(ctx.body)) {
      const declared = collectSchemaProperties(effective);
      const noContract = Object.keys(declared).length === 0;
      const open = effective?.additionalProperties !== false;
      for (const [property, value] of Object.entries(ctx.body)) {
        if (value === undefined || property === resource.idProperty) continue;
        if (property in declared || noContract || open) {
          item[property] = value;
        }
      }
    }

    // The id is allocated eagerly: staging the counter too would let two
    // in-flight creates peek the same id and commit duplicates. A rejected
    // create therefore burns an id — gaps are possible, duplicates are not.
    item[resource.idProperty] = mintId(ctx.state, counterKey, resource.idKind);

    stageMutation(ctx, () => {
      getCollection(ctx.state, key).push(item);
    });

    // The stored object is always the bare resource. Wrap it for the response
    // only when the contract declares an envelope, injecting the real item into
    // the wrapper slot the way the list generator injects the collection.
    let body: unknown = item;
    if (wrapper.property && responseSchema) {
      const shell = await generateContractBase(
        withoutProperty(responseSchema, wrapper.property),
        hooks?.fakerSeed,
      );
      shell[wrapper.property] = item;
      body = shell;
    }
    return buildResponse({ status: responseStatus, body, headerDefs });
  };
}

/**
 * Generate the declared create-response body, or `{}` when there is nothing
 * usable to generate from.
 *
 * Faker throws on empty and malformed schemas and on resource limits, so every
 * failure degrades to an empty base and the request-echo path below still runs.
 */
async function generateContractBase(
  schema: JSONSchema7 | undefined,
  seed?: number,
): Promise<Record<string, unknown>> {
  if (!schema || typeof schema === "boolean") return {};
  if (Object.keys(schema).length === 0) return {};

  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;
  const objectish =
    type === "object" ||
    (type === undefined && (schema.properties !== undefined || schema.allOf));
  if (!objectish) return {};

  try {
    const generated = await generateFromSchema({ schema, seed });
    return isRecord(generated) ? { ...generated } : {};
  } catch (error) {
    console.warn(
      "[@schmock/openapi] Create response schema generation failed:",
      error instanceof Error ? error.message : error,
    );
    return {};
  }
}

export function createReadGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
  hooks?: CrudGenerationHooks,
): Schmock.GeneratorFunction {
  const headerDefs = meta?.responseHeaders;
  const responseStatus = meta?.responseStatus;

  return async (ctx: Schmock.RequestContext) => {
    const key = collectionStateKey(resource.basePath, ctx.params);
    const collection = getCollection(ctx.state, key);
    const idValue = ctx.params[resource.idParam];
    const item = findById(collection, resource.idProperty, idValue);

    if (!item) {
      return await generateErrorResponse(404, meta, hooks, ctx);
    }

    return buildResponse({ status: responseStatus, body: item, headerDefs });
  };
}

export function createUpdateGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
  hooks?: CrudGenerationHooks,
): Schmock.GeneratorFunction {
  const headerDefs = meta?.responseHeaders;
  const responseStatus = meta?.responseStatus;

  return async (ctx: Schmock.RequestContext) => {
    const key = collectionStateKey(resource.basePath, ctx.params);
    const collection = getCollection(ctx.state, key);
    const idValue = ctx.params[resource.idParam];
    const index = findIndexById(collection, resource.idProperty, idValue);

    if (index === -1) {
      return await generateErrorResponse(404, meta, hooks, ctx);
    }

    const existingRaw = collection[index];
    const existing = isRecord(existingRaw) ? existingRaw : {};
    const updates = isRecord(ctx.body)
      ? Object.fromEntries(
          Object.entries(ctx.body).filter(([, value]) => value !== undefined),
        )
      : {};
    const updated = {
      ...existing,
      ...updates,
      [resource.idProperty]: existing[resource.idProperty], // Preserve ID
    };
    // Re-read the collection and re-find the item at commit time: the seeder can
    // replace the array object, and another request can shift indices between
    // generation and commit.
    stageMutation(ctx, () => {
      const live = getCollection(ctx.state, key);
      const liveIndex = findIndexById(live, resource.idProperty, idValue);
      if (liveIndex !== -1) live[liveIndex] = updated;
    });
    return buildResponse({ status: responseStatus, body: updated, headerDefs });
  };
}

export function createDeleteGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
  hooks?: CrudGenerationHooks,
): Schmock.GeneratorFunction {
  const headerDefs = meta?.responseHeaders;
  const responseStatus = meta?.responseStatus ?? 204;

  return async (ctx: Schmock.RequestContext) => {
    const key = collectionStateKey(resource.basePath, ctx.params);
    const collection = getCollection(ctx.state, key);
    const idValue = ctx.params[resource.idParam];
    const index = findIndexById(collection, resource.idProperty, idValue);

    if (index === -1) {
      return await generateErrorResponse(404, meta, hooks, ctx);
    }

    const deleted = collection[index];
    // Re-read and re-find at commit time — see createUpdateGenerator.
    stageMutation(ctx, () => {
      const live = getCollection(ctx.state, key);
      const liveIndex = findIndexById(live, resource.idProperty, idValue);
      if (liveIndex !== -1) live.splice(liveIndex, 1);
    });
    return buildResponse({ status: responseStatus, body: deleted, headerDefs });
  };
}

export function createStaticGenerator(
  parsedPath: ParsedPath,
  seed?: number,
  onSchema?: OnSchemaCallback,
): Schmock.GeneratorFunction {
  // Not `findSuccessResponse`: an operation declaring only error statuses must
  // answer one of them rather than an undeclared 200. The headers captured
  // below therefore come from that same entry — a 404-only operation emits the
  // 404 entry's declared headers at status 404.
  const declaredResponse = findRepresentativeResponse(parsedPath.responses);

  return async (ctx: Schmock.RequestContext) => {
    // Only reachable for a spec that declares no responses at all.
    if (!declaredResponse) return buildResponse({ status: 200, body: {} });

    const [responseStatus, responseEntry] = declaredResponse;
    const headerDefs = responseEntry.headers;
    const responseSchema = selectResponseSchema(responseEntry, ctx.headers);
    if (responseSchema) {
      let schema = responseSchema;
      if (onSchema) {
        const patched = onSchema(schema, {
          method: parsedPath.method,
          path: parsedPath.path,
          params: ctx.params,
          query: ctx.query,
          headers: ctx.headers,
        });
        if (patched) schema = patched;
      }
      try {
        const body = await generateFromSchema({ schema, seed });
        return buildResponse({ status: responseStatus, body, headerDefs });
      } catch (error) {
        // Deliberately a throw, not a laundered `[status, {}]`: core renders it
        // as a structured 500 with the failing route in the message. Returning
        // the declared success status with an empty body hid real spec bugs,
        // and would ride the 2xx entry's declared headers on an error.
        throw asSchemaGenerationError(
          error,
          `${parsedPath.method} ${parsedPath.path}`,
          schema,
        );
      }
    }
    return buildResponse({ status: responseStatus, body: {}, headerDefs });
  };
}

function selectResponseSchema(
  entry: ParsedResponseEntry,
  headers: Record<string, string>,
): JSONSchema7 | undefined {
  let byMediaType: Map<string, JSONSchema7> | undefined;
  if (entry.content && entry.content.size > 0) {
    byMediaType = new Map<string, JSONSchema7>();
    for (const [mediaType, content] of entry.content) {
      if (content.schema) byMediaType.set(mediaType, content.schema);
    }
  }
  return selectSchemaForAccept(
    {
      contentTypes: entry.contentTypes,
      byMediaType,
      fallback: entry.schema,
    },
    headers,
  );
}

/**
 * Generate seed items for a resource using its schema.
 */
export async function generateSeedItems(
  schema: JSONSchema7,
  count: number,
  idProperty: string,
  idKind: IdKind,
  seed?: number,
): Promise<unknown[]> {
  const items: unknown[] = [];
  // The item count alone does not bound memory: a modest count over a wide,
  // deeply nested schema still explodes. This is the only multiplicative
  // generation site, so the node budget lives here.
  let nodes = 0;
  for (let i = 0; i < count; i++) {
    const iterationSeed = seed !== undefined ? seed + i : undefined;
    const generated = await generateFromSchema({ schema, seed: iterationSeed });
    const item: Record<string, unknown> = isRecord(generated)
      ? generated
      : { value: generated };
    // Shape the seed id like a minted one so a uuid/string resource does not
    // mix integer seeds with string/uuid creates. `createSeeder` recovers the
    // counter from these via `idCounter`, so creation resumes past the seed max.
    item[idProperty] = shapeId(i + 1, idKind);
    nodes += countNodes(item, MAX_SEED_GENERATED_NODES - nodes);
    if (nodes > MAX_SEED_GENERATED_NODES) {
      throw new ResourceLimitError(
        "seed generated nodes",
        MAX_SEED_GENERATED_NODES,
        nodes,
      );
    }
    items.push(item);
  }
  return items;
}

/** Count JSON nodes in a generated value, bailing out once `budget` is spent. */
function countNodes(value: unknown, budget: number): number {
  if (budget <= 0) return 1;
  let count = 1;
  const children = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.values(value)
      : undefined;
  if (children) {
    for (const child of children) {
      count += countNodes(child, budget - count);
      if (count > budget) return count;
    }
  }
  return count;
}

/**
 * Generate an error response using the spec's error schema if available,
 * or fall back to the default { error, code } format.
 *
 * This is the one place read/update/delete reach `onSchema`: their success
 * bodies are replayed from state rather than generated.
 */
async function generateErrorResponse(
  status: number,
  meta: Schmock.CrudOperationMeta | undefined,
  hooks: CrudGenerationHooks | undefined,
  ctx: Schmock.RequestContext,
): Promise<Schmock.ResponseResult> {
  const errorSchema = meta?.errorSchemas?.get(status);
  if (errorSchema) {
    const effective = applyOnSchema(errorSchema, hooks, ctx) ?? errorSchema;
    try {
      const body = await generateFromSchema({
        schema: effective,
        seed: hooks?.fakerSeed,
      });
      return buildResponse({ status, body });
    } catch (error) {
      console.warn(
        `[@schmock/openapi] Error schema generation failed for status ${status}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Default error format
  const defaults: Record<number, { error: string; code: string }> = {
    404: { error: "Not found", code: "NOT_FOUND" },
    400: { error: "Bad request", code: "BAD_REQUEST" },
    409: { error: "Conflict", code: "CONFLICT" },
  };
  return buildResponse({
    status,
    body: defaults[status] ?? { error: "Error", code: "ERROR" },
  });
}

/**
 * Generate a skeleton object from a response schema.
 * Used to create wrapper objects (e.g. { data: [], has_more: false, object: "list" })
 *
 * Deliberately NOT symmetric with `createStaticGenerator`, which throws: only
 * the wrapper's *decoration* is generated here, and the caller immediately
 * overwrites the array property with the live collection. Degrading to `{}`
 * still returns the real items under the declared wrapper key, so a failure
 * here costs sibling metadata (`has_more`, `object`) rather than the response.
 * Large real-world specs rely on this — Stripe's list wrappers exceed faker's
 * nesting-depth limit, and throwing would turn a correct `200 {data:[…]}` into
 * a 500.
 */
async function generateWrapperSkeleton(
  schema: JSONSchema7,
  seed?: number,
): Promise<unknown> {
  try {
    return await generateFromSchema({ schema, seed });
  } catch (error) {
    console.warn(
      "[@schmock/openapi] Wrapper skeleton generation failed:",
      error instanceof Error ? error.message : error,
    );
    return {};
  }
}

/**
 * Look an item up by its stored id property.
 *
 * Deliberately single-key: legacy seed rows keyed by the path parameter are
 * normalized to `idProperty` once, in `createSeeder`, so nothing downstream has
 * to carry a dual-key fallback.
 */
function findById(
  collection: unknown[],
  idProperty: string,
  idValue: string,
): unknown | undefined {
  return collection.find((item) => {
    if (!isRecord(item)) return false;
    return String(item[idProperty]) === String(idValue);
  });
}

function findIndexById(
  collection: unknown[],
  idProperty: string,
  idValue: string,
): number {
  return collection.findIndex((item) => {
    if (!isRecord(item)) return false;
    return String(item[idProperty]) === String(idValue);
  });
}
