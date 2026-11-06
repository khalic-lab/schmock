import type * as Schmock from "@schmock/core";
import { ResourceLimitError } from "@schmock/core";
import { MAX_STRING_LENGTH } from "@schmock/faker";
import type { JSONSchema7 } from "json-schema";
import { poolEntries } from "./example-values.js";
import { hasType, isRecord } from "./utils.js";

/*
 * Response header values, generated from each declared header's schema.
 */

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

/**
 * The route metadata key holding the installation's {@link HeaderSeed}, for
 * the headers `Prefer` generates outside the route's generator.
 */
export const HEADER_SEED_KEY = "openapi:headerSeed";

/** The {@link HeaderSeed} a route was registered with, if it has one. */
export function routeHeaderSeed(
  route: Schmock.RouteConfig,
): HeaderSeed | undefined {
  const value: unknown = route[HEADER_SEED_KEY];
  return isRecord(value) &&
    typeof value.seed === "number" &&
    typeof value.next === "function"
    ? (value as unknown as HeaderSeed)
    : undefined;
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
 * `validateResponses` never checks a header value (only the status, media type
 * and body), so nothing in the mock rejects a malformed one: the value is a
 * real uuid because a client that parses a `format: uuid` header expects one.
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
    const value = generateSingleHeaderValue(name, def.schema, reservation);
    if (value !== undefined) {
      headers[name] = value;
    }
  }

  return headers;
}

interface HeaderReservation {
  seed: number;
  ordinal: number;
}

function generateSingleHeaderValue(
  name: string,
  schema: JSONSchema7 | undefined,
  reservation?: HeaderReservation,
): string | undefined {
  if (!schema || typeof schema === "boolean") return undefined;

  // A scalar const is the only value the header may hold. A nullable const
  // reaches here as `enum: [x, null]` instead.
  if (isHeaderScalar(schema.const)) return String(schema.const);

  // Has enum → first non-null scalar value (a nullable enum carries `null`)
  if (Array.isArray(schema.enum)) {
    const value = schema.enum.find(isHeaderScalar);
    if (value !== undefined) return String(value);
  }

  // Several examples the schema accepts became a pool (example-values.ts),
  // which a body value draws from through json-schema-faker: the header draws
  // from it too. The pool stands where a single example's `default` would,
  // so a fixed value (`const`, `enum`) still wins, and a declared
  // Content-Type is kept or ignored as operation-extract.ts decides.
  const pool = isRecord(schema)
    ? poolEntries(schema)?.filter(isHeaderScalar)
    : undefined;
  if (pool && pool.length > 0) {
    return String(pool[poolIndex(pool.length, name, reservation)]);
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
    return "x".repeat(stringHeaderLength(name, schema.minLength));
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

/**
 * How long a string header's placeholder is: its `minLength`, read as no
 * minimum when negative or not a number. A minimum past faker's
 * string length limit is refused as it is in a generated body, rather than
 * allocated and sent on every response.
 */
function stringHeaderLength(name: string, minLength: unknown): number {
  if (typeof minLength !== "number" || Number.isNaN(minLength)) return 0;
  const length = Math.max(0, Math.ceil(minLength));
  if (length > MAX_STRING_LENGTH) {
    throw new ResourceLimitError(
      "string_length",
      MAX_STRING_LENGTH,
      length,
      `header ${name}`,
    );
  }
  return length;
}

/**
 * Which of `size` pool entries a header takes. Seeded, a hash of the seed,
 * the request's ordinal and the header's name, so the same seed replays the
 * same draws while each request and each header draws on its own; unseeded,
 * `Math.random`.
 */
function poolIndex(
  size: number,
  name: string,
  reservation: HeaderReservation | undefined,
): number {
  if (!reservation) return Math.floor(Math.random() * size);
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (const char of `${reservation.seed}:${reservation.ordinal}:${name}`) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193);
  }
  return (hash >>> 0) % size;
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
