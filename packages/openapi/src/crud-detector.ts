import type * as Schmock from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import {
  collectSchemaProperties,
  findArrayProperty,
  propertyDeclarations,
  unwrapNullable,
} from "./list-envelope.js";
import { type AccessModes, collectAccessModes } from "./normalizer.js";
import type { ParsedPath } from "./parser.js";
import { segmentParamName } from "./path-template.js";
import {
  CREATE_SUCCESS_STATUS_ORDER,
  findResponseEntry,
  findSuccessResponse,
} from "./response-status.js";

export type CrudOperation = "list" | "create" | "read" | "update" | "delete";

/**
 * The error statuses CRUD handlers produce themselves; the same three an
 * `errorSchema` resource override covers.
 */
const CRUD_ERROR_STATUSES = [400, 404, 409] as const;

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
  /**
   * Property names the item schemas marked `readOnly` / `writeOnly` before
   * normalization erased the flags. Create and update ignore request values
   * for both, and never store or return a `writeOnly` one.
   */
  accessModes?: AccessModes;
  /**
   * A lone item GET: nothing is declared on the collection path and the item
   * path offers nothing but a read, so no request can ever add a row. Served
   * from stored rows when the scope has any, from the schema otherwise.
   */
  lookupOnly?: boolean;
}

interface DetectionResult {
  resources: CrudResource[];
  /** Paths that didn't match any CRUD pattern */
  nonCrudPaths: ParsedPath[];
  /**
   * Groupings that are probably not what the spec meant, one line each, in
   * the style of `ParsedSpec.warnings`. Never fatal.
   */
  warnings: string[];
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

  return {
    resources,
    nonCrudPaths,
    warnings: splitCollectionWarnings([...groups.keys()], resources),
  };
}

/**
 * Collection paths that differ only in their parent parameter names, such as
 * `/fees/{id}/refunds` beside `/fees/{fee}/refunds/{id}`.
 *
 * They group, and keep their state, apart: the collection key and the scope of
 * its rows are both built from the parameter names. Merging them would need
 * every route to map its own names onto the collection's, so the split is
 * reported instead of left silent.
 */
function splitCollectionWarnings(
  basePaths: string[],
  resources: CrudResource[],
): string[] {
  const byShape = new Map<string, string[]>();
  for (const basePath of basePaths) {
    const shape = basePath
      .split("/")
      .map((segment) => (segment.startsWith(":") ? ":" : segment))
      .join("/");
    byShape.set(shape, [...(byShape.get(shape) ?? []), basePath]);
  }

  const crudBasePaths = new Set(resources.map((r) => r.basePath));
  const warnings: string[] = [];
  for (const split of byShape.values()) {
    if (split.length < 2 || !split.some((path) => crudBasePaths.has(path))) {
      continue;
    }
    const named = `${split.slice(0, -1).join(", ")} and ${split.at(-1)}`;
    warnings.push(
      `CRUD paths ${named} name their parent parameters differently, so they ` +
        "are served as separate resources that never share rows; give the " +
        "parameters the same names to make them one",
    );
  }
  return warnings;
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
 * Drop a single trailing slash, the rule core's `normalizePath` matches routes
 * by. Django REST Framework declares `/api/pets/`, which groups under
 * `/api/pets`, so comparing the raw path left list and create out.
 */
function withoutTrailingSlash(path: string): string {
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}

/**
 * Split a path in a group into its trailing `:param` segment, if it has exactly
 * one and the path really sits under `basePath`.
 */
function itemIdParam(basePath: string, path: string): string | undefined {
  if (!path.startsWith(basePath)) return undefined;
  const segments = path.slice(basePath.length).split("/").filter(Boolean);
  if (segments.length !== 1) return undefined;
  // Exactly one parameter: `:job\:cancel` (a custom method) is not an item
  // path, and a quoted `:"user.id"` is keyed by the name inside the quotes.
  return segmentParamName(segments[0]);
}

function buildResource(
  basePath: string,
  paths: ParsedPath[],
): BuildResourceResult {
  // Pass 1 — the first item-shaped path in the group fixes idParam/itemPath.
  let itemPath = "";
  let idParam = "";
  for (const p of paths) {
    if (withoutTrailingSlash(p.path) === basePath) continue;
    const param = itemIdParam(basePath, p.path);
    if (param) {
      idParam = param;
      itemPath = p.path;
      break;
    }
  }

  // Pass 2 — classify each declared method. The list GET's item schema and the
  // item GET's schema are both collected; whichever path is declared first
  // supplies the resource schema, exactly as the historical
  // `schema = schema ?? …` chain resolved it.
  const routes: CrudRouteDescriptor[] = [];
  const leftovers: ParsedPath[] = [];
  let listSchema: JSONSchema7 | undefined;
  let readSchema: JSONSchema7 | undefined;
  let listFirst = false;

  const classify = (p: ParsedPath, op: CrudOperation) => {
    routes.push({
      op,
      method: p.method,
      path: p.path,
      parsed: p,
      meta: buildOperationMeta(p, op),
    });
  };

  for (const p of paths) {
    const path = withoutTrailingSlash(p.path);
    if (path === basePath) {
      if (p.method === "GET") {
        listSchema = getSuccessResponseSchema(p);
        listFirst = !routes.some((r) => r.op === "read");
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
    if (path !== withoutTrailingSlash(itemPath)) {
      leftovers.push(p);
      continue;
    }

    if (p.method === "GET") {
      readSchema = getSuccessResponseSchema(p);
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
  const hasRead = operations.includes("read");
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

  // The list envelope's arrays are ranked with what the item GET already says
  // about the resource, so an `errors`/`links` array declared first cannot
  // become the resource schema.
  const listItemSchema = listSchema
    ? findArrayProperty(listSchema, {
        idProperties: [idParam, "id"].filter((key) => key.length > 0),
        itemSchema: readSchema,
      }).itemSchema
    : undefined;
  // The item GET may wrap the resource (`{ data: Pet }`); what it wraps is
  // the item create stores and read, update and delete replay.
  const itemSchema =
    readSchema && unwrapItemEnvelope(readSchema, idParam, listItemSchema);
  const schema = listFirst
    ? (listItemSchema ?? itemSchema)
    : (itemSchema ?? listItemSchema);

  const name = deriveResourceName(basePath);
  const { idProperty, idKind } = resolveIdentifier(schema, idParam);

  const resource: CrudResource = {
    name,
    basePath,
    itemPath,
    idParam,
    idProperty,
    idKind,
    operations,
    routes,
    schema,
  };

  const accessModes = collectAccessModes({
    allOf: [schema, itemSchema, listItemSchema].filter(
      (s): s is JSONSchema7 => s !== undefined,
    ),
  });
  if (accessModes.readOnly.size > 0 || accessModes.writeOnly.size > 0) {
    resource.accessModes = accessModes;
  }
  if (!hasList && !hasCreate && operations.length === 1 && hasRead) {
    // Only a read survives: a lone `GET /users/{username}` lookup.
    resource.lookupOnly = true;
  }

  return { resource, leftovers };
}

/** Names an item envelope conventionally keeps its one resource under. */
const ITEM_ENVELOPE_KEYS = new Set([
  "data",
  "item",
  "result",
  "resource",
  "record",
  "entity",
  "payload",
]);

/**
 * The resource an item GET answers, unwrapped from its envelope when the
 * response is one, such as `{ data: Pet }` on `/pets/{petId}`.
 *
 * The slot is found by the rule create finds it by (`findResourceWrapper`):
 * the response declares neither the path parameter nor `id` at its top
 * level, and exactly one of its properties declares one of them. That rule
 * alone also fits an item with a nested object, `User { userId, team: { id }
 * }` on `/users/{id}`, so the slot must be corroborated: it is the list GET's
 * item schema (by identity or by its top-level property names), or its name
 * is a conventional envelope key. An item GET that answers the list's item
 * itself is never an envelope. Anything else is returned as declared.
 */
function unwrapItemEnvelope(
  readSchema: JSONSchema7,
  idParam: string,
  listItemSchema: JSONSchema7 | undefined,
): JSONSchema7 {
  const idNames = [idParam, "id"].filter((id) => id.length > 0);
  const declaresId = (schema: JSONSchema7) => {
    const properties = collectSchemaProperties(schema);
    return idNames.some((id) => Object.hasOwn(properties, id));
  };
  if (declaresId(readSchema)) return readSchema;
  if (listItemSchema && sameItem(readSchema, listItemSchema)) return readSchema;

  const slots = new Map<string, JSONSchema7>();
  for (const [key, declared] of propertyDeclarations(
    unwrapNullable(readSchema),
  )) {
    if (!slots.has(key) && declaresId(declared)) slots.set(key, declared);
  }
  if (slots.size !== 1) return readSchema;
  const [[key, slot]] = slots;
  const corroborated =
    (listItemSchema !== undefined && sameItem(slot, listItemSchema)) ||
    ITEM_ENVELOPE_KEYS.has(key);
  return corroborated ? slot : readSchema;
}

/**
 * Whether two schemas describe the same item: the same declared object, or
 * the same non-empty set of top-level property names.
 */
function sameItem(a: JSONSchema7, b: JSONSchema7): boolean {
  if (unwrapNullable(a) === unwrapNullable(b)) return true;
  const left = Object.keys(collectSchemaProperties(a));
  const right = new Set(Object.keys(collectSchemaProperties(b)));
  return (
    left.length > 0 &&
    left.length === right.size &&
    left.every((name) => right.has(name))
  );
}

/**
 * Name a resource after the last literal segment of its collection path.
 *
 * A collection path only ends in a parameter when the group holds nothing but
 * `/a/:x/:y` item paths (`/repos/{owner}/{repo}` groups under `/repos/:owner`);
 * the raw last segment named that resource `":owner"`, so seeds and overrides
 * had to be keyed by a parameter token. Every other resource keeps its name.
 */
function deriveResourceName(basePath: string): string {
  const segments = basePath.split("/").filter(Boolean);
  const literal = segments.filter((segment) => !segment.startsWith(":"));
  return literal.pop() ?? segments.pop() ?? basePath;
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
  const declares = (name: string) => declarationsOf(schema, name).length > 0;
  const idProperty = declares(idParam)
    ? idParam
    : declares("id")
      ? "id"
      : idParam;

  // A union item schema (Stripe's `anyOf: [bank_account, card]`) mints
  // strings only when every branch declaring the id says string.
  const declared = declarationsOf(schema, idProperty);
  const types = declared.map((d) =>
    Array.isArray(d.type) ? d.type.find((t) => t !== "null") : d.type,
  );
  if (declared.length === 0 || types.some((type) => type !== "string")) {
    return { idProperty, idKind: "integer" };
  }
  return {
    idProperty,
    idKind: declared.every((d) => d.format === "uuid") ? "uuid" : "string",
  };
}

/**
 * Every declaration of property `name` an item can carry: the schema's own
 * (through `allOf`, as {@link collectSchemaProperties} flattens it), or else
 * one per `oneOf`/`anyOf` branch that declares it. The nullable wrapper is an
 * `anyOf` too, so it is looked through the same way.
 */
function declarationsOf(
  schema: JSONSchema7 | undefined,
  name: string,
  seen: Set<object> = new Set(),
): JSONSchema7[] {
  if (!schema || seen.has(schema)) return [];
  seen.add(schema);
  const own = collectSchemaProperties(schema)[name];
  if (own) return [own];

  const found: JSONSchema7[] = [];
  for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
    for (const branch of schema[keyword] ?? []) {
      if (typeof branch === "object") {
        found.push(...declarationsOf(branch, name, seen));
      }
    }
  }
  return found;
}

function buildOperationMeta(
  p: ParsedPath,
  op: CrudOperation,
): Schmock.CrudOperationMeta {
  const meta: Schmock.CrudOperationMeta = {};

  const successResponse = findSuccessResponse(
    p.responses,
    successStatusOrder(op),
  );
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
  // The statuses a CRUD handler answers on its own resolve the way response
  // validation resolves them (exact, range, then `default`), so a spec that
  // declares its errors only under `default` or `4XX` gets its own body back.
  // A `default` entry that is the success contract is not an error schema.
  for (const status of CRUD_ERROR_STATUSES) {
    if (errorSchemas.has(status)) continue;
    const entry = findResponseEntry(p.responses, status);
    if (entry?.schema && entry !== successResponse?.[1]) {
      errorSchemas.set(status, entry.schema);
    }
  }
  if (errorSchemas.size > 0) {
    meta.errorSchemas = errorSchemas;
  }

  return meta;
}

/**
 * The exact success statuses an operation tries first. Only a create differs:
 * it prefers 201 over 200, so an upsert contract declaring both answers a fresh
 * create with 201.
 */
export function successStatusOrder(
  op: CrudOperation,
): readonly number[] | undefined {
  return op === "create" ? CREATE_SUCCESS_STATUS_ORDER : undefined;
}

function getSuccessResponseSchema(p: ParsedPath): JSONSchema7 | undefined {
  return findSuccessResponse(p.responses)?.[1].schema;
}
