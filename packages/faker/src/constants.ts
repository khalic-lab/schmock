// Resource limits for safety
export const MAX_ARRAY_SIZE = 10000;
export const DEFAULT_ARRAY_COUNT = 3; // Default items to generate when not specified
export const DEEP_NESTING_THRESHOLD = 3; // Depth at which to check for memory risks
export const LARGE_ARRAY_THRESHOLD = 100; // Array size considered "large"

/**
 * How deep a schema may nest before generation is refused.
 *
 * Calibrated against the OpenAPI fixtures in `packages/openapi/src/__fixtures__`,
 * measured as the height `validateSchema` computes over each dereferenced and
 * normalized response schema:
 *
 *   petstore-openapi3 2 · openapi31 2 · train-travel 3 · scalar-galaxy 6 ·
 *   stripe-spec3 up to 47
 *
 * Stripe's heights are not a continuum: 1176 response schemas land on 0-13 or
 * on 28-47, with NOTHING in between. The 28+ cluster is Stripe's mutually
 * referencing object graph (`account` → `external_accounts` → … → `account`),
 * dereferenced into a very tall DAG. Generating from it with the ceiling
 * bypassed measures 97 MB (`GET /v1/setup_attempts`), 127 MB
 * (`/v1/invoices/:id/lines`) and 188 MB (`/v1/checkout/sessions/:id/line_items`)
 * for ONE response, so it stays out. Every ceiling from 14 to 27 admits exactly
 * the same set, and 15 sits in that band with 2.5x headroom over the deepest
 * non-Stripe fixture.
 *
 * A breach is reported as `schema_nesting_depth` with the longest value path
 * measured by the iterative graph walk.
 */
export const MAX_NESTING_DEPTH = 15;

/**
 * Depth ceiling handed to json-schema-faker.
 *
 * Its default is 5, and past it JSF silently emits `{}` or `null` instead of
 * the declared value — so a schema nested deeper than 5 generated a body that
 * violated its own `required` contract while this package advertised
 * `MAX_NESTING_DEPTH` levels.
 *
 * Derived from `MAX_NESTING_DEPTH` so the two cannot drift: JSF must never
 * truncate a schema validation admitted, and must never generate far past the
 * depth validation reasoned about — the depth of a generated body is bounded
 * here and nowhere else.
 *
 * JSF's counter is NOT this package's nesting depth: it also counts levels
 * `validateSchema` treats as free, and a level reached through a `$ref` costs
 * two units (one for the reference hop, one for the property). Measured
 * minimum `maxDepth` for the shapes this package promises to generate: a
 * 10-object chain needs 9, a 5-object/4-array alternation needs 8, a chain as
 * deep as the ceiling needs 14, and that same chain expressed as `$defs`
 * linked by `$ref` needs 18. The margin covers all of them; it is headroom,
 * not an exact bound.
 */
export const JSF_MAX_DEPTH = MAX_NESTING_DEPTH + 5;

/**
 * Cumulative generation budgets.
 *
 * `MAX_SCHEMA_NODES` bounds the number of distinct schema nodes validation,
 * enhancement and generation can inspect. Shared DAG nodes count once here;
 * their multiplicity is charged to `MAX_GENERATED_NODES` instead.
 *
 * `MAX_GENERATED_NODES` bounds the RESULT. json-schema-faker runs with
 * `alwaysFakeOptionals`, so every optional property is materialized and the
 * size of a response is the product of array sizes and object widths down each
 * branch — width, not merely the number of schema nodes.
 *
 * Both are plain constants rather than plugin options, mirroring
 * `packages/openapi/src/limits.ts`: a mock has no legitimate reason to emit a
 * million-node body, and a configurable ceiling is a footgun. The documented
 * per-request opt-out remains `onSchema` returning a trimmed schema.
 */
export const MAX_SCHEMA_NODES = 50_000;
export const MAX_GENERATED_NODES = 1_000_000;

/** Maximum number of own properties Schmock will materialize on one object. */
export const MAX_OBJECT_PROPERTIES = 10_000;

/**
 * Maximum number of UTF-16 code units Schmock will generate for one string.
 * 64 KiB admits the repository's largest real API constraints while refusing
 * lengths large enough for one field to become an accidental bulk payload.
 */
export const MAX_STRING_LENGTH = 65_536;

/**
 * Reference date used when generation must be reproducible.
 * Faker's `date.*` methods default their reference date to `Date.now()`, so a
 * seed alone does not reproduce dates — pinning the reference date does.
 * This instant is part of the reproducible-output contract: changing it changes
 * every date a seeded generation produces.
 */
export const DETERMINISTIC_REF_DATE = "2024-01-01T00:00:00.000Z";

// Data quality tuning
export const NULLABLE_NULL_PROBABILITY = 0.05; // 5% chance nullable fields are null
