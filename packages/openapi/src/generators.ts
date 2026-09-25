import type * as Schmock from "@schmock/core";
import {
  ResourceLimitError,
  SchemaGenerationError,
  SchmockError,
} from "@schmock/core";
import { generateFromSchema } from "@schmock/faker";
import type { JSONSchema7 } from "json-schema";
import { selectResponseMediaType } from "./content-negotiation.js";
import type { CrudResource, IdKind } from "./crud-detector.js";
import { MAX_SEED_GENERATED_NODES } from "./limits.js";
import { type AccessModes, collectAccessModes } from "./normalizer.js";
import type { ParsedPath, ParsedResponseEntry } from "./parser.js";
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
 * If `property` is undefined, the schema is a flat array (or unknown).
 */
interface ArrayPropertyInfo {
  /**
   * Top-level property holding (or, for a nested envelope, containing) the
   * array — `"data"` for `{data:[…]}`, `"page"` for `{page:{items:[…]}}`.
   * Undefined for flat arrays.
   */
  property?: string;
  /** For a nested envelope, the property inside `property` holding the array. */
  innerProperty?: string;
  /**
   * Schema for the array items — the declared object itself, not a copy, so
   * identity-keyed lookups (`collectAccessModes`) still find it.
   */
  itemSchema?: JSONSchema7;
}

/** Path to the array a wrapper carries (`["data"]`, `["page", "items"]`), if any. */
export function arrayPropertyPath(
  info: ArrayPropertyInfo,
): string[] | undefined {
  if (info.property === undefined) return undefined;
  return info.innerProperty === undefined
    ? [info.property]
    : [info.property, info.innerProperty];
}

/**
 * What is already known about the resource a list envelope carries, used to
 * pick the right array when the envelope declares more than one.
 */
export interface ArrayPropertyHints {
  /** Property names that identify the resource's primary key, most specific first. */
  idProperties?: readonly string[];
  /** The resource's item schema, when already known. */
  itemSchema?: JSONSchema7;
}

/** Envelope keys conventionally holding a page of items. */
const CONVENTIONAL_LIST_KEYS = new Set([
  "data",
  "items",
  "results",
  "result",
  "content",
  "value",
  "values",
  "records",
  "entries",
  "list",
]);

const PRIMITIVE_TYPES = ["string", "number", "integer", "boolean", "null"];

/**
 * Object-shaped by declaration: `type: object` (alone or in a union), or no
 * `type` at all with `properties`/`allOf`. The same rule `generateContractBase`
 * uses — a wrapper that omits `type` is still an object envelope.
 */
function isObjectShaped(schema: JSONSchema7): boolean {
  if (hasType(schema, "object")) return true;
  return (
    schema.type === undefined &&
    (isRecord(schema.properties) || Array.isArray(schema.allOf))
  );
}

/** First items schema of an array, as declared (no copy). */
function arrayItemSchema(schema: JSONSchema7): JSONSchema7 | undefined {
  const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  return typeof items === "object" && items !== null ? items : undefined;
}

/** Resource-derived hints for {@link findArrayProperty} on a list route. */
export function listArrayHints(
  resource: Pick<CrudResource, "idProperty" | "idParam" | "schema">,
): ArrayPropertyHints {
  const idProperties = [
    ...new Set([resource.idProperty, resource.idParam, "id"]),
  ].filter((name) => name.length > 0);
  return { idProperties, itemSchema: resource.schema };
}

/**
 * Find which property in a response schema holds the array of items.
 * Handles flat arrays, object wrappers (Stripe), typeless wrappers, allOf
 * compositions (Scalar Galaxy) and one level of nesting (`{page:{items}}`,
 * HAL `_embedded`).
 *
 * When the envelope declares several arrays (`errors`, `links`, `warnings`
 * next to the items), they are ranked rather than taken in declaration order:
 * see {@link rankArrayCandidates}.
 */
export function findArrayProperty(
  schema: JSONSchema7,
  hints: ArrayPropertyHints = {},
): ArrayPropertyInfo {
  if (!schema || typeof schema === "boolean") return {};

  // Case 1: flat array
  if (hasType(schema, "array")) {
    return { itemSchema: arrayItemSchema(schema) };
  }

  // Case 2: object envelope — typed or not, with or without allOf
  if (isObjectShaped(schema)) {
    const best = rankArrayCandidates(collectArrayCandidates(schema), hints);
    if (best) {
      const [property, innerProperty] = best.path;
      return innerProperty === undefined
        ? { property, itemSchema: best.itemSchema }
        : { property, innerProperty, itemSchema: best.itemSchema };
    }
  }

  // Case 3: anyOf/oneOf — try the first meaningful branch. The normalizer wraps
  // a composition-only `nullable: true` as `anyOf: [{type:"null"}, rest]`, so a
  // bare null branch must be skipped rather than read as the shape.
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0) {
      for (const branch of branches) {
        if (!isRecord(branch)) continue;
        if (branch.type === "null" && Object.keys(branch).length === 1)
          continue;
        return findArrayProperty(toJsonSchema(branch), hints);
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

interface ArrayCandidate {
  path: string[];
  itemSchema?: JSONSchema7;
}

/**
 * Every declaration of every property of an object schema: its own
 * `properties`, then its `allOf` branches, recursively. A key declared in
 * several branches yields one entry per declaration — a generic
 * `Wrapper-Collection` declaring `data: object[]` next to the operation's own
 * `data: Booking[]` — so the ranking, not a merge order, decides between them.
 */
function propertyDeclarations(
  schema: JSONSchema7,
): Array<[string, JSONSchema7]> {
  const out: Array<[string, JSONSchema7]> = [];
  const seen = new Set<object>();
  const visit = (node: JSONSchema7): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.properties && typeof node.properties === "object") {
      for (const [key, value] of Object.entries(node.properties)) {
        if (typeof value === "object") out.push([key, value]);
      }
    }
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        if (typeof branch === "object") visit(branch);
      }
    }
  };
  visit(schema);
  return out;
}

/**
 * Every array property of an object envelope: its own (and its `allOf`
 * branches') properties first, then one level down inside object-shaped
 * properties. Declaration order is preserved within each level.
 */
function collectArrayCandidates(schema: JSONSchema7): ArrayCandidate[] {
  const top: ArrayCandidate[] = [];
  const nested: ArrayCandidate[] = [];
  for (const [key, prop] of propertyDeclarations(schema)) {
    if (hasType(prop, "array")) {
      if (prop.items) {
        top.push({ path: [key], itemSchema: arrayItemSchema(prop) });
      }
      continue;
    }
    if (!isObjectShaped(prop)) continue;
    for (const [inner, innerProp] of propertyDeclarations(prop)) {
      if (hasType(innerProp, "array") && innerProp.items) {
        nested.push({
          path: [key, inner],
          itemSchema: arrayItemSchema(innerProp),
        });
      }
    }
  }
  return [...top, ...nested];
}

/**
 * Parent keys that mark a nested level as a list envelope (`_embedded` for
 * HAL, `page`/`data`/`result` for paged APIs).
 */
const NESTED_ENVELOPE_KEYS = new Set([
  "_embedded",
  "embedded",
  "page",
  "data",
  "result",
  "results",
  "response",
  "payload",
]);

/**
 * Pick the array most likely to carry the resource, by, in order:
 *
 * 1. being the very items object the resource schema came from;
 * 2. declaring the resource's id property (most specific hint first) — the
 *    rule `findResourceWrapper` already uses for create envelopes;
 * 3. sharing the most property names with the known item schema;
 * 4. holding objects rather than primitives (`warnings: string[]`);
 * 5. a conventional name (`data`, `items`, `results`, …);
 * 6. sitting at the top level rather than one level down;
 * 7. declaration order.
 *
 * Taking the first array in declaration order injected the collection into an
 * `errors`/`links` array declared before the real one and derived the resource
 * schema from it.
 *
 * A nested array only competes with evidence that it is the list — one of
 * signals 1-3, or an envelope parent key — so an ordinary object that happens
 * to hold an array (`card_issuing.status_details`) is not read as a wrapper.
 */
function rankArrayCandidates(
  candidates: ArrayCandidate[],
  hints: ArrayPropertyHints,
): ArrayCandidate | undefined {
  const idNames = hints.idProperties?.length ? hints.idProperties : ["id"];
  const reference = new Set(
    Object.keys(collectSchemaProperties(hints.itemSchema)),
  );

  const score = (candidate: ArrayCandidate): number[] => {
    const items = candidate.itemSchema;
    const props = collectSchemaProperties(items);
    const idRank = idNames.findIndex((name) => name in props);
    let overlap = 0;
    for (const name of Object.keys(props)) {
      if (reference.has(name)) overlap++;
    }
    const primitive =
      items !== undefined &&
      !isObjectShaped(items) &&
      PRIMITIVE_TYPES.some((type) => hasType(items, type));
    const leaf = candidate.path[candidate.path.length - 1];
    return [
      items !== undefined && items === hints.itemSchema ? 0 : 1,
      idRank === -1 ? idNames.length : idRank,
      -overlap,
      primitive ? 1 : 0,
      CONVENTIONAL_LIST_KEYS.has(leaf) ? 0 : 1,
      candidate.path.length,
    ];
  };

  const admitted = candidates.filter((candidate) => {
    if (candidate.path.length === 1) return true;
    if (NESTED_ENVELOPE_KEYS.has(candidate.path[0])) return true;
    const [identity, idRank, negOverlap] = score(candidate);
    return identity === 0 || idRank < idNames.length || negOverlap < 0;
  });
  if (admitted.length <= 1) return admitted[0];

  let best = admitted[0];
  let bestScore = score(best);
  for (const candidate of admitted.slice(1)) {
    const candidateScore = score(candidate);
    const diff = candidateScore.findIndex((v, i) => v !== bestScore[i]);
    // Strictly better only: ties keep the earlier declaration.
    if (diff !== -1 && candidateScore[diff] < bestScore[diff]) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
}

/**
 * Per-installation ordinal source for seeded header values.
 *
 * Created once when an OpenAPI plugin is installed and shared by all route
 * generators from that installation. The determinism contract is "same seed +
 * same request sequence within a mock instance → same value": two mocks built
 * from the same spec and seed replay the sequence, while different routes in
 * one mock still receive distinct values.
 * A process-global counter would break the first half; a constant would make
 * `X-Request-Id` useless as an id.
 */
export interface HeaderSeed {
  readonly seed: number;
  /** Ordinal reserved by the next header-producing request, starting at 0. */
  next(): number;
}

export function createHeaderSeed(seed?: number): HeaderSeed | undefined {
  if (seed === undefined) return undefined;
  let ordinal = 0;
  return {
    seed,
    next: () => ordinal++,
  };
}

/**
 * Header-namespace synthetic uuid: a well-formed v4 whose node field encodes
 * `(seed, ordinal)`.
 *
 * Deliberately a different variant nibble from {@link SYNTHETIC_UUID_PREFIX}, so
 * a header value can never be mistaken for a minted resource id by `idCounter`.
 * `ajv-formats` enforces `format: uuid` under `validateResponses`, so a seeded
 * header still has to be a real uuid.
 */
const SEEDED_HEADER_UUID_PREFIX = "00000000-0000-4000-9000-";

/** Fixed clock for seeded `date-time` headers: 2024-01-01T00:00:00.000Z. */
const SEEDED_CLOCK_BASE_MS = Date.UTC(2024, 0, 1);

function seedComponent(seed: number): number {
  return Math.floor(Math.abs(seed)) % 1_000_000;
}

function seededHeaderUuid(seed: number, ordinal: number): string {
  const high = String(seedComponent(seed)).padStart(6, "0");
  const low = String(ordinal % 1_000_000).padStart(6, "0");
  return `${SEEDED_HEADER_UUID_PREFIX}${high}${low}`;
}

function seededHeaderTimestamp(seed: number, ordinal: number): string {
  const offsetSeconds = (seedComponent(seed) % 86_400) + ordinal;
  return new Date(SEEDED_CLOCK_BASE_MS + offsetSeconds * 1000).toISOString();
}

/**
 * RFC-4122 v4 identifier from Web Crypto.
 *
 * NOT `node:crypto`'s `randomUUID`: `bun build --target browser` inlines a full
 * Node crypto polyfill for that single import, which was ~92% of the published
 * browser bundle. `crypto.randomUUID` is secure-context-only in browsers, so a
 * mock served over plain http falls through to `getRandomValues` (which is not
 * gated) and finally to `Math.random` — a development mock needs a well-formed
 * uuid, not cryptographic strength.
 */
function randomUuid(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * Generate header values from spec-defined response header definitions.
 *
 * With a `headerSeed` every random/time value is derived from it, so a seeded
 * run reproduces its response headers as well as its bodies.
 */
export function generateHeaderValues(
  headerDefs: Record<string, Schmock.ResponseHeaderDef> | undefined,
  headerSeed?: HeaderSeed,
): Record<string, string> {
  if (!headerDefs) return {};

  const headers: Record<string, string> = {};
  const reservation = headerSeed
    ? { seed: headerSeed.seed, ordinal: headerSeed.next() }
    : undefined;

  for (const [name, def] of Object.entries(headerDefs)) {
    const value = generateSingleHeaderValue(def.schema, reservation);
    if (value !== undefined) {
      headers[name] = value;
    }
  }

  return headers;
}

function generateSingleHeaderValue(
  schema: JSONSchema7 | undefined,
  reservation?: { seed: number; ordinal: number },
): string | undefined {
  if (!schema || typeof schema === "boolean") return undefined;

  // Has enum → first non-null scalar value (a nullable enum carries `null`)
  if (Array.isArray(schema.enum)) {
    const value = schema.enum.find(isHeaderScalar);
    if (value !== undefined) return String(value);
  }

  // Has default (from example → default normalization). Only a scalar has one
  // obvious wire form; an object or array default falls through, exactly like
  // an array-typed or untyped schema below, instead of emitting
  // "[object Object]".
  if (isHeaderScalar(schema.default)) {
    return String(schema.default);
  }

  // Format-based generation. Seeded runs trade the wall clock for a fixed one:
  // "seeded" and "timestamp" cannot both hold, and the seeded body path already
  // makes the same trade.
  if (schema.format === "uuid") {
    return reservation
      ? seededHeaderUuid(reservation.seed, reservation.ordinal)
      : randomUuid();
  }
  if (schema.format === "date-time") {
    return reservation
      ? seededHeaderTimestamp(reservation.seed, reservation.ordinal)
      : new Date().toISOString();
  }

  // Type-based fallback. `hasType`, not `===`: the normalizer turns a 3.0
  // `nullable: true` header into `type: [T, "null"]`, which must still emit.
  if (hasType(schema, "integer")) {
    return numericHeaderValue(schema, true);
  }
  if (hasType(schema, "number")) {
    return numericHeaderValue(schema, false);
  }
  if (hasType(schema, "string")) {
    return "x".repeat(
      typeof schema.minLength === "number" ? schema.minLength : 0,
    );
  }
  if (hasType(schema, "boolean")) {
    return "false";
  }

  // Deliberate drop: `array`, `object` and untyped header schemas have no
  // single obvious wire form (comma-joined? repeated header? JSON?), and
  // guessing one would be worse than omitting the header. Not an oversight —
  // do not "fix" it without deciding the serialization first.
  return undefined;
}

function isHeaderScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * The placeholder for a numeric header: 0 when the bounds allow it, otherwise
 * the nearest whole number inside them, otherwise (a fractional `number` range)
 * its midpoint. A flat "0" broke `minimum: 1` on the header's own schema.
 */
function numericHeaderValue(schema: JSONSchema7, integer: boolean): string {
  const min = typeof schema.minimum === "number" ? schema.minimum : undefined;
  const exMin =
    typeof schema.exclusiveMinimum === "number"
      ? schema.exclusiveMinimum
      : undefined;
  const max = typeof schema.maximum === "number" ? schema.maximum : undefined;
  const exMax =
    typeof schema.exclusiveMaximum === "number"
      ? schema.exclusiveMaximum
      : undefined;

  const fits = (value: number): boolean =>
    (min === undefined || value >= min) &&
    (exMin === undefined || value > exMin) &&
    (max === undefined || value <= max) &&
    (exMax === undefined || value < exMax);

  const candidates = [
    0,
    min === undefined ? undefined : Math.ceil(min),
    exMin === undefined ? undefined : Math.floor(exMin) + 1,
    max === undefined ? undefined : Math.floor(max),
    exMax === undefined ? undefined : Math.ceil(exMax) - 1,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && fits(candidate)) return String(candidate);
  }

  const low = exMin ?? min;
  const high = exMax ?? max;
  if (!integer && low !== undefined && high !== undefined) {
    const midpoint = (low + high) / 2;
    if (fits(midpoint)) return String(midpoint);
  }
  // Unsatisfiable bounds: nothing fits, keep the historical placeholder.
  return "0";
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

/**
 * Read (creating if absent) the collection stored under an already-resolved key.
 *
 * MATERIALIZING — only for write paths (the create push, the update/delete
 * commit callbacks). Reads must use {@link readCollection}: allocating on a GET
 * meant an unauthenticated scan of `/owners/<random>/pets` grew process memory
 * one collection per id with no write ever occurring.
 */
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

/**
 * Read the collection under an already-resolved key WITHOUT persisting a scope
 * that does not exist yet.
 *
 * Indistinguishable to the caller from `getCollection` on an empty scope — an
 * empty list is an empty list — but it leaves no state key behind. Seeded
 * resources are unaffected: `createSeeder` still materializes their scope on
 * first touch, before any generator runs.
 */
function readCollection(
  state: Record<string, unknown>,
  key: string,
): unknown[] {
  const value = state[key];
  return Array.isArray(value) ? value : [];
}

/**
 * Advance and return the id counter stored under an already-resolved key.
 *
 * A MISSING counter is recovered from the live collection rather than restarted
 * at 0. An unseeded resource writes no state at all, so a collection pre-loaded
 * through `schmock({ state })` arrives here with rows and no counter — minting
 * from 0 handed the new item an id that already existed, and every subsequent
 * read/update/delete on that id addressed the pre-loaded row instead. The scan
 * mirrors `createSeeder`'s: `idCounter` per row, max wins, unrecoverable ids
 * skipped.
 *
 * A counter that IS stored stays authoritative even at 0 — `createSeeder`
 * legitimately writes 0 when no seed row carries a recoverable id, and
 * re-deriving there would overrule it.
 */
function getNextId(
  state: Record<string, unknown>,
  key: string,
  recover?: () => number,
): number {
  const current = state[key];
  const base = typeof current === "number" ? current : (recover?.() ?? 0);
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

/**
 * Highest counter encoded by the ids already in a collection, or 0.
 *
 * Reads with {@link readCollection} on purpose: recovery must not materialize
 * the collection key, which would re-break the non-materializing read.
 */
function recoverCounter(
  state: Record<string, unknown>,
  collectionKey: string,
  idProperty: string,
  idKind: IdKind,
): number {
  let maxId = 0;
  for (const item of readCollection(state, collectionKey)) {
    if (!isRecord(item)) continue;
    const counter = idCounter(item[idProperty], idKind);
    if (counter !== undefined && counter > maxId) maxId = counter;
  }
  return maxId;
}

function mintId(
  state: Record<string, unknown>,
  counterKey: string,
  collectionKey: string,
  resource: Pick<CrudResource, "idProperty" | "idKind">,
): number | string {
  const next = getNextId(state, counterKey, () =>
    recoverCounter(state, collectionKey, resource.idProperty, resource.idKind),
  );
  return shapeId(next, resource.idKind);
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
}

/**
 * Give `options.onSchema` a chance to rewrite a schema before generation.
 *
 * Fires only where a body is actually generated: the create response contract,
 * the list wrapper skeleton (or a list's declared object body when it carries
 * no array), and CRUD error bodies. Read/update/delete replay stored state, so
 * they only reach it on their 404 path — or, for a lookup-only read with no
 * stored scope, through the static generator it falls back to.
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
  const headerSeed = hooks?.headerSeed;
  // The wrapper shape depends on the negotiated media type, so it can only be
  // resolved per request. Memoized per schema object: without `onSchema` the
  // keys are the route's declared media-type schemas, a bounded set. A hook
  // that returns a fresh object per request simply misses the memo — a WeakMap
  // keeps that from accumulating. The hints are fixed per resource, so they
  // cannot invalidate an entry.
  const wrapperMemo = new WeakMap<object, ArrayPropertyInfo>();
  const hints = listArrayHints(resource);

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
    if (!wrapperPath) {
      if (!isObjectShaped(effective)) return flat;
      // An object contract with no array to carry the collection (a singleton
      // such as `/settings` grouped as a list): a bare array is a shape the
      // contract forbids, so answer with the declared body, as a static route
      // would.
      return buildResponse({
        status: responseStatus,
        body: await generateDeclaredBody(effective, hooks, resource),
        headers,
      });
    }

    // Generate the wrapper's decoration without the array property — the live
    // items replace it anyway, and fabricating them first pushed tall item
    // schemas over the nesting limit and cost DEFAULT_ARRAY_COUNT throwaway
    // items per request.
    const skeleton = await generateWrapperSkeleton(
      withoutPath(effective, wrapperPath),
      hooks?.fakerSeed,
    );
    if (isRecord(skeleton)) {
      setAtPath(skeleton, wrapperPath, items);
      return buildResponse({
        status: responseStatus,
        body: skeleton,
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
 * Generate a list route's declared object body when it carries no array.
 * Throws like `createStaticGenerator` does: core renders a structured 500.
 */
async function generateDeclaredBody(
  schema: JSONSchema7,
  hooks: CrudGenerationHooks | undefined,
  resource: CrudResource,
): Promise<unknown> {
  try {
    return await generateFromSchema({ schema, seed: hooks?.fakerSeed });
  } catch (error) {
    throw asSchemaGenerationError(
      error,
      `${hooks?.method ?? "GET"} ${hooks?.path ?? resource.basePath}`,
      schema,
    );
  }
}

/** Write `value` at `path`, creating intermediate objects the skeleton lacks. */
function setAtPath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (isRecord(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    }
  }
  node[path[path.length - 1]] = value;
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

  if (isRecord(schema.properties) && head in schema.properties) {
    const properties = { ...schema.properties };
    const child = properties[head];
    if (rest.length === 0) {
      delete properties[head];
    } else if (typeof child === "object") {
      properties[head] = withoutPath(child, rest);
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

    const responseSchema = metaSchema(meta, ctx.headers, headers);
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
    const modes = accessModesFor(resource, effective);

    if (isRecord(ctx.body)) {
      const declared = collectSchemaProperties(effective);
      const noContract = Object.keys(declared).length === 0;
      const open = effective?.additionalProperties !== false;
      for (const [property, value] of Object.entries(ctx.body)) {
        if (value === undefined || property === resource.idProperty) continue;
        // A readOnly value is the server's to assign and a writeOnly one is
        // never returned — the response normalizer strips it from `declared`,
        // so on an open contract it used to be copied through as "undeclared".
        if (modes.readOnly.has(property) || modes.writeOnly.has(property)) {
          continue;
        }
        if (property in declared || noContract || open) {
          item[property] = value;
        }
      }
    }
    for (const property of modes.writeOnly) delete item[property];

    // The id is allocated eagerly: staging the counter too would let two
    // in-flight creates peek the same id and commit duplicates. A rejected
    // create therefore burns an id — gaps are possible, duplicates are not.
    item[resource.idProperty] = mintId(ctx.state, counterKey, key, resource);

    stageMutation(ctx, () => {
      getCollection(ctx.state, key).push(item);
    });

    // The stored object is always the bare resource. Wrap it for the response
    // only when the contract declares an envelope, injecting the real item into
    // the wrapper slot the way the list generator injects the collection.
    let body: unknown = item;
    if (wrapper.property && responseSchema) {
      const shell = await generateContractBase(
        withoutPath(responseSchema, [wrapper.property]),
        hooks?.fakerSeed,
      );
      shell[wrapper.property] = item;
      body = shell;
    }
    return buildResponse({
      status: responseStatus,
      body,
      headers,
    });
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
  const headerSeed = hooks?.headerSeed;

  return async (ctx: Schmock.RequestContext) => {
    const headers = generateHeaderValues(headerDefs, headerSeed);
    const key = collectionStateKey(resource.basePath, ctx.params);
    const collection = readCollection(ctx.state, key);
    const idValue = ctx.params[resource.idParam];
    const item = findById(collection, resource.idProperty, idValue);

    if (!item) {
      return await generateErrorResponse(404, meta, hooks, ctx);
    }

    return buildResponse({
      status: responseStatus,
      body: item,
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
      return await generateErrorResponse(404, meta, hooks, ctx);
    }

    const modes = accessModesFor(
      resource,
      metaSchema(meta, ctx.headers, headers),
    );
    const updates = isRecord(ctx.body)
      ? Object.fromEntries(
          Object.entries(ctx.body).filter(
            ([property, value]) =>
              value !== undefined &&
              !modes.readOnly.has(property) &&
              !modes.writeOnly.has(property),
          ),
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
    // response object is rebuilt in place, so the body the client receives is
    // the row that was actually stored.
    stageMutation(ctx, () => {
      const live = getCollection(ctx.state, key);
      const liveIndex = findIndexById(live, resource.idProperty, idValue);
      if (liveIndex === -1) return;
      const committed = merge(live[liveIndex]);
      for (const property of Object.keys(updated)) delete updated[property];
      Object.assign(updated, committed);
      live[liveIndex] = updated;
    });
    return buildResponse({
      status: responseStatus,
      body: updated,
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
      return await generateErrorResponse(404, meta, hooks, ctx);
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
      body: deleted,
      headers,
    });
  };
}

export function createStaticGenerator(
  parsedPath: ParsedPath,
  hooks: GenerationHooks = {},
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
