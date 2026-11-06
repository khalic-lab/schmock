import { SchmockError } from "@schmock/core";
import type { CrudResource, IdKind } from "./crud-detector.js";
import { isRecord } from "./utils.js";

/*
 * Where a CRUD resource's rows live in mock state, how a row is found by its
 * id, and how new ids are minted.
 */

/**
 * Read (creating if absent) the collection stored under an already-resolved key.
 *
 * MATERIALIZING — only for write paths (the create push, the update/delete
 * commit callbacks). Reads must use {@link readCollection}: allocating on a GET
 * meant an unauthenticated scan of `/owners/<random>/pets` grew process memory
 * one collection per id with no write ever occurring.
 */
export function getCollection(
  state: Record<string, unknown>,
  key: string,
): unknown[] {
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
export function readCollection(
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
export function shapeId(counter: number, idKind: IdKind): number | string {
  if (idKind === "integer") return counter;
  if (idKind === "string") return String(counter);
  return `${SYNTHETIC_UUID_PREFIX}${String(counter).padStart(12, "0")}`;
}

/**
 * The highest counter an id of this kind can carry: a synthetic uuid's node
 * field holds 12 digits, and a number past `Number.MAX_SAFE_INTEGER` no
 * longer has a distinct successor, so `counter + 1` would mint it again.
 */
function maxCounter(idKind: IdKind): number {
  return idKind === "uuid" ? 999_999_999_999 : Number.MAX_SAFE_INTEGER;
}

/**
 * Recover the counter an identifier encodes, so the mint counter can resume
 * past the seed high-water mark regardless of id kind. Integer and string ids
 * carry the counter as their numeric value; a synthetic uuid carries it in the
 * node field. Returns `undefined` for an id this scheme did not mint (a real
 * uuid, a non-numeric string), which the caller simply skips. So is an id the
 * counter cannot continue past (a snowflake string or int64 beyond
 * `Number.MAX_SAFE_INTEGER`, a synthetic uuid at the top node): resuming there
 * minted the same rounded id on every create, or a 13-digit uuid node.
 */
export function idCounter(value: unknown, idKind: IdKind): number | undefined {
  let n: number;
  if (idKind === "uuid") {
    if (typeof value !== "string" || !value.startsWith(SYNTHETIC_UUID_PREFIX)) {
      return undefined;
    }
    n = Number(value.slice(SYNTHETIC_UUID_PREFIX.length));
  } else {
    n = typeof value === "number" ? value : Number(value);
  }
  return Number.isSafeInteger(n) && n < maxCounter(idKind) ? n : undefined;
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

export function mintId(
  state: Record<string, unknown>,
  counterKey: string,
  collectionKey: string,
  resource: Pick<CrudResource, "idProperty" | "idKind">,
): number | string {
  const next = getNextId(state, counterKey, () =>
    recoverCounter(state, collectionKey, resource.idProperty, resource.idKind),
  );
  if (next > maxCounter(resource.idKind)) {
    // Past this point every create would repeat the previous id (or mint a
    // malformed uuid), so the create fails instead of storing a duplicate.
    throw new SchmockError(
      `Cannot mint a new ${resource.idKind} id for "${resource.idProperty}": the id counter is past ${maxCounter(resource.idKind)}`,
      "OPENAPI_ID_COUNTER_EXHAUSTED",
      { counter: next, idKind: resource.idKind },
    );
  }
  return shapeId(next, resource.idKind);
}

/**
 * Look an item up by its stored id property.
 *
 * Deliberately single-key: legacy seed rows keyed by the path parameter are
 * normalized to `idProperty` once, in `createSeeder`, so nothing downstream has
 * to carry a dual-key fallback.
 */
export function findById(
  collection: unknown[],
  idProperty: string,
  idValue: string,
): unknown | undefined {
  return collection.find((item) => {
    if (!isRecord(item)) return false;
    return String(item[idProperty]) === String(idValue);
  });
}

export function findIndexById(
  collection: unknown[],
  idProperty: string,
  idValue: string,
): number {
  return collection.findIndex((item) => {
    if (!isRecord(item)) return false;
    return String(item[idProperty]) === String(idValue);
  });
}
