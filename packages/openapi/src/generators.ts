import type * as Schmock from "@schmock/core";
import {
  getHeader,
  ResourceLimitError,
  SchemaGenerationError,
  SchmockError,
} from "@schmock/core";
import { toError } from "@schmock/core/adapter";
import { generateFromSchema } from "@schmock/faker";
import type { JSONSchema7 } from "json-schema";
import { selectResponseMediaType } from "./content-negotiation.js";
import type { CrudResource, IdKind } from "./crud-detector.js";
import {
  findById,
  findIndexById,
  getCollection,
  mintId,
  readCollection,
  shapeId,
} from "./crud-ids.js";
import { MAX_SEED_GENERATED_NODES } from "./limits.js";
import {
  type ArrayPropertyHints,
  type ArrayPropertyInfo,
  arrayPropertyPath,
  collectSchemaProperties,
  findArrayProperty,
  isObjectShaped,
  listArrayHints,
  nonNullable,
  propertyDeclarations,
  unwrapNullable,
} from "./list-envelope.js";
import { type AccessModes, collectAccessModes } from "./normalizer.js";
import type { ParsedPath, ParsedResponseEntry } from "./parser.js";
import {
  type FormEncodingMap,
  isBinaryPayload,
  normalizeRequestBody,
  readRequestBody,
} from "./request-body.js";
import {
  declaresTopLevel,
  IdExampleFilter,
  listServesItem,
  resourceWrapperProperty,
} from "./resource-placement.js";
import { generateHeaderValues, type HeaderSeed } from "./response-headers.js";
import {
  findRepresentativeResponse,
  isStatusInRange,
} from "./response-status.js";
import { collectionStateKey, counterStateKey } from "./state-keys.js";
import { isRecord, toJsonSchema } from "./utils.js";

/**
 * Wrap a generation failure in a structured, coded error.
 *
 * A `SchmockError` already carries a meaningful code (`RESOURCE_LIMIT_ERROR`,
 * `SCHEMA_VALIDATION_ERROR`, …) and is rethrown untouched, so the root cause is
 * not laundered into a generic one. Everything else becomes a
 * `SchemaGenerationError`, whose message names the route. A non-Error throw
 * goes through core's `toError`, so its message is readable (`String()` gave
 * `[object Object]`) and the thrown value stays reachable as `cause`.
 */
export function asSchemaGenerationError(
  error: unknown,
  route: string,
  schema?: unknown,
): Error {
  if (error instanceof SchmockError) return error;
  return new SchemaGenerationError(route, toError(error), schema);
}

/**
 * Inputs for assembling a spec-driven response.
 */
export interface ResponseBuild {
  /** Declared status; undefined means "plain body, let core default to 200". */
  status?: number;
  body: unknown;
  /** Response headers reserved before asynchronous body generation. */
  headers?: Record<string, string>;
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
  const headers = build.headers ?? {};
  const hasHeaders = Object.keys(headers).length > 0;

  if (build.status === undefined) {
    return hasHeaders ? [200, build.body, headers] : build.body;
  }

  const body = build.status === 204 ? undefined : build.body;
  return hasHeaders ? [build.status, body, headers] : [build.status, body];
}

/** Plugin-installation generation settings shared by every registered route. */
export interface GenerationHooks {
  fakerSeed?: number;
  onSchema?: Schmock.OnSchemaCallback;
  /** Shared response-header ordinal source for this plugin installation. */
  headerSeed?: HeaderSeed;
}

/** Per-route generation context handed to the CRUD generators. */
export interface CrudGenerationHooks extends GenerationHooks {
  /** Concrete declared method, e.g. "POST". */
  method: string;
  /** Spec path this generator was registered on, e.g. "/pets/:petId". */
  path: string;
  /**
   * The request schema the operation declares for a body of `contentType`,
   * selected the way request validation selects it. Create and update read a
   * form body through it, and an update judges request fields by it when no
   * item contract exists.
   */
  requestSchema?: (contentType: string | undefined) => JSONSchema7 | undefined;
  /**
   * The `encoding` map declared for a body of `contentType`, selected like
   * `requestSchema`: how create and update read an urlencoded form.
   */
  requestEncoding?: (
    contentType: string | undefined,
  ) => FormEncodingMap | undefined;
}

/**
 * Give `options.onSchema` a chance to rewrite a schema before generation.
 *
 * Fires only where a body is actually generated: the create response contract,
 * the list wrapper skeleton (or a list's declared object body when it carries
 * no array), and CRUD error bodies. Read/update/delete replay stored state, so
 * they only reach it for an envelope around the row, a delete confirmation
 * object, and their 404 path — or, for a lookup-only read with no stored
 * scope, through the static generator it falls back to.
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
 * Pick the response schema matching the generated response label or `Accept`.
 *
 * One rule for both the static and the CRUD path: when the operation declares
 * media types with schemas, negotiate among them (falling back to the first
 * declared type when the request states no preference); otherwise use the
 * JSON-ish default the parser already resolved. The media type comes from
 * `selectResponseMediaType`, the same rule response validation applies.
 */
function selectGeneratedSchema(
  source: {
    contentTypes?: string[];
    byMediaType?: Map<string, JSONSchema7>;
    fallback?: JSONSchema7;
  },
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string> = {},
): JSONSchema7 | undefined {
  if (
    source.contentTypes?.length &&
    source.byMediaType &&
    source.byMediaType.size > 0
  ) {
    const selected = selectResponseMediaType(
      source,
      requestHeaders,
      responseHeaders,
    );
    return selected?.declared
      ? source.byMediaType.get(selected.declared)
      : undefined;
  }
  return source.fallback;
}

/** `selectGeneratedSchema` over a CRUD operation's success contract. */
function metaSchema(
  meta: Schmock.CrudOperationMeta | undefined,
  requestHeaders: Record<string, string>,
  responseHeaders?: Record<string, string>,
): JSONSchema7 | undefined {
  return selectGeneratedSchema(
    {
      contentTypes: meta?.responseContentTypes,
      byMediaType: meta?.responseSchemasByMediaType,
      fallback: meta?.responseSchema,
    },
    requestHeaders,
    responseHeaders,
  );
}

/**
 * The resource's `readOnly`/`writeOnly` property names, plus any the
 * operation's own contract declares (a create or update response built from a
 * different component than the item GET).
 */
function accessModesFor(
  resource: CrudResource,
  schema: JSONSchema7 | undefined,
): AccessModes {
  const own = collectAccessModes(schema);
  const shared = resource.accessModes;
  if (!shared || (shared.readOnly.size === 0 && shared.writeOnly.size === 0)) {
    return own;
  }
  if (own.readOnly.size === 0 && own.writeOnly.size === 0) return shared;
  return {
    readOnly: new Set([...shared.readOnly, ...own.readOnly]),
    writeOnly: new Set([...shared.writeOnly, ...own.writeOnly]),
  };
}

/** Key under which `RequestContext.pluginState` holds this request's staged mutations. */
export const PENDING_MUTATIONS_KEY = "openapi:pendingMutations";

/**
 * Key under which the plugin records the request body its `beforeRequest`
 * normalized, so a generator can tell whether that normalized value still
 * describes the body it receives.
 */
export const NORMALIZED_BODY_SOURCE_KEY = "openapi:normalizedBodySource";

/**
 * The request body a create or update stores, read the way the operation's
 * request schema reads it (`contract` stands in when it declares none).
 *
 * The plugin normalizes the body once, in its `beforeRequest`. A plugin piped
 * after it can still replace `context.body` in its own `beforeRequest`, and
 * the route receives that replacement: the stored normalization describes a
 * body the route never saw, so the replacement is normalized here instead.
 */
function readSubmittedBody(
  ctx: Schmock.RequestContext,
  hooks: CrudGenerationHooks | undefined,
  contract: JSONSchema7 | undefined,
): unknown {
  const contentType = getHeader(ctx.headers, "content-type");
  const schema = hooks?.requestSchema?.(contentType) ?? contract;
  const encoding = hooks?.requestEncoding?.(contentType);
  const store = ctx.pluginState;
  if (
    store?.has(NORMALIZED_BODY_SOURCE_KEY) &&
    store.get(NORMALIZED_BODY_SOURCE_KEY) !== ctx.body
  ) {
    return normalizeRequestBody(ctx.body, contentType, schema, {
      fields: ctx.form,
      encoding,
    });
  }
  return readRequestBody(ctx, schema, encoding);
}

type PendingMutation = () => void;

/**
 * Defer a collection mutation until the plugin knows the final response status.
 *
 * A `Prefer: code=400`, a 406 from response content negotiation, a response
 * validation failure, or a 500 from a plugin piped later must not leave a
 * half-applied write behind. The plugin's `afterResponse` hook commits the
 * queue once the final status is a success and discards it otherwise.
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
  const headerSeed = hooks?.headerSeed;
  // The wrapper shape depends on the negotiated media type, so it can only be
  // resolved per request. Memoized per schema object: without `onSchema` the
  // keys are the route's declared media-type schemas, a bounded set. A hook
  // that returns a fresh object per request simply misses the memo — a WeakMap
  // keeps that from accumulating. The hints are fixed per resource, so they
  // cannot invalidate an entry.
  const wrapperMemo = new WeakMap<object, ArrayPropertyInfo>();
  const hints = listArrayHints(resource);
  const singleton = listServesItem(resource, meta);
  const declaresId = (schema: JSONSchema7): boolean =>
    declaresTopLevel(schema, resource.idProperty);
  const idExamples = new IdExampleFilter(resource, "list", singleton);

  return async (ctx: Schmock.RequestContext) => {
    const headers = generateHeaderValues(headerDefs, headerSeed);
    const key = collectionStateKey(resource.basePath, ctx.params);
    const collection = readCollection(ctx.state, key);
    const items = [...collection];

    const schema = metaSchema(meta, ctx.headers, headers);
    const flat = buildResponse({
      status: responseStatus,
      body: items,
      headers,
    });
    if (!schema) return flat;

    // A flat-array (or unknown) contract returns the items directly — and does
    // not call `onSchema`, since nothing is generated on that path.
    if (
      !resolveWrapperInfo(schema, wrapperMemo, hints).property &&
      !isObjectShaped(schema)
    ) {
      return flat;
    }

    // The hook can reshape the wrapper, so the injection point is re-derived
    // from whatever it returned.
    const effective = applyOnSchema(schema, hooks, ctx) ?? schema;
    const wrapperPath = arrayPropertyPath(
      resolveWrapperInfo(effective, wrapperMemo, hints),
    );
    if (!wrapperPath || (singleton && declaresId(effective))) {
      if (!isObjectShaped(effective)) return flat;
      // An object contract with no array-like property at all (a singleton
      // such as `/settings` grouped as a list): a bare array is a shape the
      // contract forbids, so answer with the declared body, as a static route
      // would. When that body cannot be generated, the live items still beat
      // a 500 on every request — the degradation `generateWrapperSkeleton`
      // makes for an envelope's decoration.
      //
      // A singleton whose contract declares the resource's own id at its top
      // level is the item itself even when it holds an array of objects
      // (Stripe's Dispute and its `balance_transactions`): that array is a
      // field of the item, not a slot for the collection.
      const declared = await generateDeclaredBody(
        idExamples.apply(effective),
        hooks?.fakerSeed,
      );
      return declared === undefined
        ? flat
        : buildResponse({ status: responseStatus, body: declared, headers });
    }

    // Generate the wrapper's decoration without the array property — the live
    // items replace it anyway, and fabricating them first pushed tall item
    // schemas over the nesting limit and cost DEFAULT_ARRAY_COUNT throwaway
    // items per request. A nullable envelope is generated from its non-null
    // alternative: a rolled null left no envelope to put the items in.
    const skeleton = await generateWrapperSkeleton(
      withoutPath(nonNullable(effective), wrapperPath),
      hooks?.fakerSeed,
    );
    if (isRecord(skeleton)) {
      return buildResponse({
        status: responseStatus,
        body: injectAtPath(skeleton, effective, wrapperPath, items),
        headers,
      });
    }

    return flat;
  };
}

function resolveWrapperInfo(
  schema: JSONSchema7,
  memo: WeakMap<object, ArrayPropertyInfo>,
  hints: ArrayPropertyHints,
): ArrayPropertyInfo {
  if (typeof schema !== "object" || schema === null) {
    return findArrayProperty(schema, hints);
  }
  const cached = memo.get(schema);
  if (cached) return cached;
  const info = findArrayProperty(schema, hints);
  memo.set(schema, info);
  return info;
}

/**
 * Generate a list route's declared object body when it carries no array, or
 * `undefined` (with a warning) when faker cannot, so the caller can fall back
 * to the live collection.
 */
async function generateDeclaredBody(
  schema: JSONSchema7,
  seed?: number,
): Promise<unknown> {
  try {
    return await generateFromSchema({ schema, seed });
  } catch (error) {
    console.warn(
      "[@schmock/openapi] List body generation failed, serving the collection:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/**
 * Create an own, enumerable data property. Plain assignment runs the
 * `__proto__` accessor instead when `key` is `"__proto__"` — and a spec, which
 * is untrusted input, chooses the key.
 */
function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Put `value` at `path` inside the generated `skeleton`, returning a rebuilt
 * copy whose objects along the path list their keys in declared order.
 *
 * The skeleton was generated without the array property, so writing it back
 * afterwards would move it to the end of the object: `{items, total}` would go
 * out as `{"total":…,"items":[…]}`. Each level is therefore rebuilt from the
 * schema's declaration order (own `properties`, then `allOf` branches, looking
 * through the normalizer's nullable wrapper), with
 * undeclared skeleton keys after it and an undeclared path key last.
 *
 * Only own properties are read and every key is defined, never assigned, so a
 * `__proto__` path segment names an ordinary key rather than the prototype.
 */
function injectAtPath(
  skeleton: Record<string, unknown>,
  schema: JSONSchema7 | undefined,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path;
  const declarations = schema
    ? propertyDeclarations(unwrapNullable(schema))
    : [];
  let slot = value;
  if (rest.length > 0) {
    const child = Object.hasOwn(skeleton, head) ? skeleton[head] : undefined;
    const childSchema = declarations.find(([key]) => key === head)?.[1];
    slot = injectAtPath(isRecord(child) ? child : {}, childSchema, rest, value);
  }

  const order = new Set([
    ...declarations.map(([key]) => key),
    ...Object.keys(skeleton),
    head,
  ]);
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (key === head) {
      defineOwn(out, key, slot);
    } else if (Object.hasOwn(skeleton, key)) {
      defineOwn(out, key, skeleton[key]);
    }
  }
  return out;
}

/**
 * Put a resource into the wrapper slot of an envelope generated from the rest
 * of the contract. The envelope keeps its declared key order, as a list
 * envelope does.
 */
async function wrapInEnvelope(
  item: unknown,
  envelope: JSONSchema7,
  property: string,
  seed?: number,
): Promise<Record<string, unknown>> {
  const shell = await generateContractBase(
    withoutPath(envelope, [property]),
    seed,
  );
  return injectAtPath(shell, envelope, [property], item);
}

/**
 * The body a read, update or delete answers with for a stored row.
 *
 * The row is replayed as stored. When the operation's own response contract
 * wraps the resource in an envelope (`{ data: <Resource> }`), the row goes into
 * the wrapper slot, the way create wraps a new row: the stored row stays bare
 * and only the response carries the envelope. `onSchema` sees that envelope
 * contract, since its shell is generated.
 */
async function replayRow(
  row: unknown,
  declared: JSONSchema7 | undefined,
  resource: CrudResource,
  hooks: CrudGenerationHooks | undefined,
  ctx: Schmock.RequestContext,
): Promise<unknown> {
  if (!declared || !resourceWrapperProperty(resource, declared)) return row;
  const contract = applyOnSchema(declared, hooks, ctx) ?? declared;
  const property = resourceWrapperProperty(resource, contract);
  if (!property) return row;
  return wrapInEnvelope(row, contract, property, hooks?.fakerSeed);
}

/**
 * Every name a schema lists in `required`, following `allOf` branches the way
 * {@link collectSchemaProperties} follows their properties.
 */
function requiredProperties(schema: JSONSchema7): Set<string> {
  const out = new Set<string>();
  const visit = (node: JSONSchema7): void => {
    if (Array.isArray(node.required)) {
      for (const name of node.required) out.add(name);
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

/**
 * Whether a stored row already has the top-level shape an object contract
 * declares: every required property, and no undeclared one when the contract
 * is closed. A contract that is not object-shaped generates nothing, so it is
 * treated as describing the row.
 */
function describesRow(
  schema: JSONSchema7,
  row: Record<string, unknown>,
): boolean {
  const contract = unwrapNullable(schema);
  if (!isObjectShaped(contract)) return true;
  for (const name of requiredProperties(contract)) {
    if (!Object.hasOwn(row, name)) return false;
  }
  if (isClosedContract(contract)) {
    const declared = collectSchemaProperties(contract);
    for (const key of Object.keys(row)) {
      if (!Object.hasOwn(declared, key)) return false;
    }
  }
  return true;
}

/**
 * The body a delete answers with.
 *
 * Usually the deleted row, replayed (or wrapped, see {@link replayRow}). A
 * DELETE can instead declare a confirmation object such as Stripe's
 * `{ id, object, deleted: true }`, which the row does not satisfy. That body
 * is generated from the contract, with every property it shares with the row
 * taken from the row, as create overlays the request onto a generated base.
 * When nothing can be generated, the row is replayed as before.
 */
async function deleteBody(
  row: unknown,
  declared: JSONSchema7 | undefined,
  resource: CrudResource,
  hooks: CrudGenerationHooks | undefined,
  ctx: Schmock.RequestContext,
): Promise<unknown> {
  if (!declared || resourceWrapperProperty(resource, declared)) {
    return replayRow(row, declared, resource, hooks, ctx);
  }
  if (!isRecord(row) || describesRow(declared, row)) return row;

  const contract = applyOnSchema(declared, hooks, ctx) ?? declared;
  const body = await generateContractBase(contract, hooks?.fakerSeed);
  if (Object.keys(body).length === 0) return row;
  for (const property of Object.keys(collectSchemaProperties(contract))) {
    if (Object.hasOwn(row, property)) defineOwn(body, property, row[property]);
  }
  return body;
}

/**
 * Copy of `schema` with the property at `path` removed from `properties` and
 * `required` — through `allOf`/`anyOf`/`oneOf` branches and into a nested
 * envelope level. Used to generate an envelope's outer shell without
 * re-fabricating the resource (or the list of them) about to be injected into
 * the wrapper slot. Only the nodes along the path are copied.
 */
function withoutPath(
  schema: JSONSchema7,
  path: readonly string[],
): JSONSchema7 {
  const [head, ...rest] = path;
  if (head === undefined) return schema;
  const clone: JSONSchema7 = { ...schema };

  if (isRecord(schema.properties) && Object.hasOwn(schema.properties, head)) {
    const properties = { ...schema.properties };
    const child = properties[head];
    if (rest.length === 0) {
      delete properties[head];
    } else if (typeof child === "object") {
      defineOwn(properties, head, withoutPath(child, rest));
    }
    clone.properties = properties;
  }
  if (rest.length === 0 && Array.isArray(schema.required)) {
    clone.required = schema.required.filter((name) => name !== head);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      clone[keyword] = branches.map((branch) =>
        typeof branch === "object" ? withoutPath(branch, path) : branch,
      );
    }
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
  const headerSeed = hooks?.headerSeed;

  return async (ctx: Schmock.RequestContext) => {
    const headers = generateHeaderValues(headerDefs, headerSeed);
    const key = collectionStateKey(resource.basePath, ctx.params);
    const counterKey = counterStateKey(resource.basePath, ctx.params);

    // `onSchema` sees the whole response contract, envelope included, and the
    // stored item and the envelope shell are both derived from what it returns,
    // as the list generator re-derives its wrapper.
    const declared = metaSchema(meta, ctx.headers, headers);
    const responseSchema = applyOnSchema(declared, hooks, ctx);
    const wrapperProperty = resourceWrapperProperty(resource, responseSchema);
    const effective =
      wrapperProperty && responseSchema
        ? wrappedItemSchema(resource, responseSchema, wrapperProperty, declared)
        : responseSchema;
    const item: Record<string, unknown> = await generateContractBase(
      effective,
      hooks?.fakerSeed,
    );
    const modes = accessModesFor(resource, effective);

    const submitted = readSubmittedBody(ctx, hooks, effective);
    if (isRecord(submitted)) {
      for (const [property, value] of acceptedFields(
        submitted,
        effective,
        modes,
        resource.idProperty,
      )) {
        defineOwn(item, property, value);
      }
    }
    for (const property of modes.writeOnly) delete item[property];

    // The id is allocated eagerly: staging the counter too would let two
    // in-flight creates peek the same id and commit duplicates. A rejected
    // create therefore burns an id — gaps are possible, duplicates are not.
    defineOwn(
      item,
      resource.idProperty,
      mintId(ctx.state, counterKey, key, resource),
    );

    stageMutation(ctx, () => {
      getCollection(ctx.state, key).push(item);
    });

    // The stored object is always the bare resource. Wrap it for the response
    // only when the contract declares an envelope, injecting the real item into
    // the wrapper slot the way the list generator injects the collection.
    const body =
      wrapperProperty && responseSchema
        ? await wrapInEnvelope(
            item,
            responseSchema,
            wrapperProperty,
            hooks?.fakerSeed,
          )
        : item;
    return buildResponse({
      status: responseStatus,
      body,
      headers,
    });
  };
}

/**
 * The contract a created item is generated from when the create response
 * wraps it in an envelope.
 *
 * The resource schema, as stored rows are, while the envelope is the one the
 * spec declares. When `onSchema` rewrote the envelope, the wrapper property's
 * schema in the rewritten one instead: a field the hook adds to the item lands
 * in the created row (and so in later reads), not only in the response.
 */
function wrappedItemSchema(
  resource: CrudResource,
  envelope: JSONSchema7,
  property: string,
  declared: JSONSchema7 | undefined,
): JSONSchema7 | undefined {
  if (envelope === declared) return resource.schema;
  const slot = propertyDeclarations(unwrapNullable(envelope)).find(
    ([key]) => key === property,
  )?.[1];
  return slot ?? resource.schema;
}

/**
 * The request fields a create or update stores, judged against the item
 * contract the operation declares: a declared property, any field when the
 * contract is open, and every field when it declares nothing. A readOnly value
 * is the server's to assign and a writeOnly one is never stored, so neither
 * is kept — the response normalizer strips both from `declared`, so on an open
 * contract they used to be copied through as "undeclared". The id property is
 * always the server's.
 *
 * Fields are returned as entries, for the caller to define as own properties:
 * a JSON `__proto__` key assigned with `=` re-prototyped the stored row.
 *
 * A file part of a multipart body (one `Blob`/`File`, or a list of them) is
 * never stored: it would serialize as `{}` on every later read.
 */
function acceptedFields(
  body: Record<string, unknown>,
  contract: JSONSchema7 | undefined,
  modes: AccessModes,
  idProperty: string,
): Array<[string, unknown]> {
  const declared = collectSchemaProperties(contract);
  const noContract = Object.keys(declared).length === 0;
  const open = contract === undefined || !isClosedContract(contract);
  return Object.entries(body).filter(
    ([property, value]) =>
      value !== undefined &&
      !isFilePart(value) &&
      property !== idProperty &&
      !modes.readOnly.has(property) &&
      !modes.writeOnly.has(property) &&
      (Object.hasOwn(declared, property) || noContract || open),
  );
}

/**
 * Whether an object contract accepts only the properties it declares: closed
 * by `additionalProperties: false`, or, on a 3.1 composition, by
 * `unevaluatedProperties: false`, which reaches through its `allOf` branches.
 */
function isClosedContract(schema: JSONSchema7): boolean {
  // `unevaluatedProperties` is 2019-09+, so JSONSchema7 does not type it.
  const contract = unwrapNullable(schema);
  return (
    contract.additionalProperties === false ||
    Reflect.get(contract, "unevaluatedProperties") === false
  );
}

/** A file, or a list of files, sent as one form field. */
function isFilePart(value: unknown): boolean {
  return (
    isBinaryPayload(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(isBinaryPayload))
  );
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
  // Generated from the non-null alternative of a nullable contract (the node
  // inside the wrapper, or a typed node without its `null`): null is a valid
  // value for faker to pick, and no base at all.
  const contract = unwrapNullable(schema);
  if (Object.keys(contract).length === 0) return {};
  if (!isObjectShaped(contract)) return {};

  try {
    const generated = await generateFromSchema({
      schema: nonNullable(contract),
      seed,
    });
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
  const headerSeed = hooks?.headerSeed;

  return async (ctx: Schmock.RequestContext) => {
    const headers = generateHeaderValues(headerDefs, headerSeed);
    const key = collectionStateKey(resource.basePath, ctx.params);
    const collection = readCollection(ctx.state, key);
    const idValue = ctx.params[resource.idParam];
    const item = findById(collection, resource.idProperty, idValue);

    if (!item) {
      return await generateNotFoundResponse(meta, hooks, ctx);
    }

    return buildResponse({
      status: responseStatus,
      body: await replayRow(
        item,
        metaSchema(meta, ctx.headers, headers),
        resource,
        hooks,
        ctx,
      ),
      headers,
    });
  };
}

/**
 * Serve a lookup-only resource — a lone item GET, with no list or create to
 * ever add a row.
 *
 * When the request's scope holds a collection (seeded, or pre-loaded through
 * `schmock({ state })`), it behaves as a CRUD read: stored rows by id, 404 for
 * the rest. Otherwise nothing could ever be found, so it answers from the
 * declared schema like any static route instead of 404ing forever.
 */
export function createLookupGenerator(
  resource: CrudResource,
  read: Schmock.GeneratorFunction,
  generate: Schmock.GeneratorFunction,
): Schmock.GeneratorFunction {
  return (ctx: Schmock.RequestContext) => {
    const key = collectionStateKey(resource.basePath, ctx.params);
    return Array.isArray(ctx.state[key]) ? read(ctx) : generate(ctx);
  };
}

export function createUpdateGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
  hooks?: CrudGenerationHooks,
): Schmock.GeneratorFunction {
  const headerDefs = meta?.responseHeaders;
  const responseStatus = meta?.responseStatus;
  const headerSeed = hooks?.headerSeed;

  return async (ctx: Schmock.RequestContext) => {
    const headers = generateHeaderValues(headerDefs, headerSeed);
    const key = collectionStateKey(resource.basePath, ctx.params);
    const collection = readCollection(ctx.state, key);
    const idValue = ctx.params[resource.idParam];
    const index = findIndexById(collection, resource.idProperty, idValue);

    if (index === -1) {
      return await generateNotFoundResponse(meta, hooks, ctx);
    }

    const responseSchema = metaSchema(meta, ctx.headers, headers);
    // Request fields are judged by create's rule against the item contract, so
    // an undeclared field on a closed contract is dropped here as it is on
    // create, instead of being stored and failing every later read. The
    // response is that contract only when it is item-shaped (it declares the
    // id property at its top level). An envelope, a 204, or a confirmation
    // such as a closed `{ updated: boolean }` is not: judged by one, every
    // field would be dropped and the update would silently do nothing. The
    // resource schema stands in, then the request schema, then nothing.
    const itemSchema =
      responseSchema && declaresTopLevel(responseSchema, resource.idProperty)
        ? responseSchema
        : (resource.schema ??
          hooks?.requestSchema?.(getHeader(ctx.headers, "content-type")));
    const modes = accessModesFor(resource, itemSchema);
    const submitted = readSubmittedBody(ctx, hooks, itemSchema);
    const updates = isRecord(submitted)
      ? Object.fromEntries(
          acceptedFields(submitted, itemSchema, modes, resource.idProperty),
        )
      : {};
    const merge = (row: unknown): Record<string, unknown> => {
      const base = isRecord(row) ? row : {};
      const merged: Record<string, unknown> = {
        ...base,
        ...updates,
        [resource.idProperty]: base[resource.idProperty], // Preserve ID
      };
      for (const property of modes.writeOnly) delete merged[property];
      return merged;
    };
    const updated = merge(collection[index]);
    // Re-read the collection, re-find the item AND re-merge at commit time: the
    // seeder can replace the array object, another request can shift indices,
    // and a concurrent update can commit between this generator and its
    // commit — writing the merge taken above would erase that update. The
    // object is rebuilt in place, so it is the row that was stored. Through
    // the plugin the commit runs once the response is final, after its body
    // was serialized, so the client sees the merge taken above.
    stageMutation(ctx, () => {
      const live = getCollection(ctx.state, key);
      const liveIndex = findIndexById(live, resource.idProperty, idValue);
      if (liveIndex === -1) return;
      const committed = merge(live[liveIndex]);
      for (const property of Object.keys(updated)) delete updated[property];
      for (const [property, value] of Object.entries(committed)) {
        defineOwn(updated, property, value);
      }
      live[liveIndex] = updated;
    });
    return buildResponse({
      status: responseStatus,
      body: await replayRow(updated, responseSchema, resource, hooks, ctx),
      headers,
    });
  };
}

export function createDeleteGenerator(
  resource: CrudResource,
  meta?: Schmock.CrudOperationMeta,
  hooks?: CrudGenerationHooks,
): Schmock.GeneratorFunction {
  const headerDefs = meta?.responseHeaders;
  const responseStatus = meta?.responseStatus ?? 204;
  const headerSeed = hooks?.headerSeed;

  return async (ctx: Schmock.RequestContext) => {
    const headers = generateHeaderValues(headerDefs, headerSeed);
    const key = collectionStateKey(resource.basePath, ctx.params);
    const collection = readCollection(ctx.state, key);
    const idValue = ctx.params[resource.idParam];
    const index = findIndexById(collection, resource.idProperty, idValue);

    if (index === -1) {
      return await generateNotFoundResponse(meta, hooks, ctx);
    }

    const deleted = collection[index];
    // Re-read and re-find at commit time — see createUpdateGenerator.
    stageMutation(ctx, () => {
      const live = getCollection(ctx.state, key);
      const liveIndex = findIndexById(live, resource.idProperty, idValue);
      if (liveIndex !== -1) live.splice(liveIndex, 1);
    });
    return buildResponse({
      status: responseStatus,
      body: await deleteBody(
        deleted,
        metaSchema(meta, ctx.headers, headers),
        resource,
        hooks,
        ctx,
      ),
      headers,
    });
  };
}

/**
 * A route answering from its declared schema. `idExamples` is given for a
 * lookup-only CRUD read, whose generated item takes no id from the id's
 * examples.
 */
export function createStaticGenerator(
  parsedPath: ParsedPath,
  hooks: GenerationHooks = {},
  idExamples?: IdExampleFilter,
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
    const headers = generateHeaderValues(headerDefs, hooks.headerSeed);
    const responseSchema = selectResponseSchema(
      responseEntry,
      ctx.headers,
      headers,
    );
    if (responseSchema) {
      let schema = responseSchema;
      if (hooks.onSchema) {
        const patched = hooks.onSchema(schema, {
          method: parsedPath.method,
          path: parsedPath.path,
          params: ctx.params,
          query: ctx.query,
          headers: ctx.headers,
        });
        if (patched) schema = patched;
      }
      if (idExamples && isStatusInRange(responseStatus, 200, 300)) {
        schema = idExamples.apply(schema);
      }
      try {
        const body = await generateFromSchema({
          schema,
          seed: hooks.fakerSeed,
        });
        return buildResponse({
          status: responseStatus,
          body,
          headers,
        });
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
    return buildResponse({
      status: responseStatus,
      body: {},
      headers,
    });
  };
}

function selectResponseSchema(
  entry: ParsedResponseEntry,
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string>,
): JSONSchema7 | undefined {
  let byMediaType: Map<string, JSONSchema7> | undefined;
  if (entry.content && entry.content.size > 0) {
    byMediaType = new Map<string, JSONSchema7>();
    for (const [mediaType, content] of entry.content) {
      if (content.schema) byMediaType.set(mediaType, content.schema);
    }
  }
  return selectGeneratedSchema(
    {
      contentTypes: entry.contentTypes,
      byMediaType,
      fallback: entry.schema,
    },
    requestHeaders,
    responseHeaders,
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
 * The 404 a read, update or delete answers for a missing item, from the
 * spec's (or the `errorSchema` override's) 404 schema when there is one, else
 * the default { error, code } body. It is the only error body CRUD generates:
 * request-validation 400s and `Prefer: code=` statuses are built elsewhere.
 *
 * Read/update/delete also reach `onSchema` here: their success bodies are
 * replayed from state, and only an envelope or a delete confirmation around
 * the row is generated.
 */
async function generateNotFoundResponse(
  meta: Schmock.CrudOperationMeta | undefined,
  hooks: CrudGenerationHooks | undefined,
  ctx: Schmock.RequestContext,
): Promise<Schmock.ResponseResult> {
  const status = 404;
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

  return buildResponse({
    status,
    body: { error: "Not found", code: "NOT_FOUND" },
  });
}

/**
 * Generate a skeleton object from a response schema.
 * Used to create wrapper objects (e.g. { data: [], has_more: false, object: "list" })
 *
 * Deliberately NOT symmetric with `createStaticGenerator`, which throws: only
 * the wrapper's *decoration* is generated here — the caller strips the array
 * property first and injects the live collection afterwards. Degrading to `{}`
 * still returns the real items under the declared wrapper key, so a failure
 * here costs sibling metadata (`has_more`, `object`) rather than the response.
 * Large real-world specs rely on this — a Stripe wrapper whose decoration alone
 * exceeds faker's nesting-depth limit must not turn a correct `200 {data:[…]}`
 * into a 500.
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
