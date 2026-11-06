/**
 * Hard budgets for seeding and schema-driven generation.
 *
 * These are deliberately plain constants rather than `OpenApiOptions` knobs:
 * they exist to stop a mock definition from exhausting memory or wedging a test
 * run, and a per-instance override would let the very configuration that needs
 * bounding remove them. Exported as runtime values so `@schmock/cli` can share
 * the manifest budget.
 */

/** Maximum seed items for one resource (mirrors faker's MAX_ARRAY_SIZE). */
export const MAX_SEED_ITEMS_PER_RESOURCE = 10_000;

/** Maximum seed items across all resources in one `loadSeed()` call. */
export const MAX_SEED_ITEMS_TOTAL = 50_000;

/** Maximum size of one seed data file, in bytes. */
export const MAX_SEED_FILE_BYTES = 5 * 1024 * 1024;

/** Maximum size of a CLI seed manifest, in bytes. */
export const MAX_SEED_MANIFEST_BYTES = 1024 * 1024;

/** Maximum generated JSON nodes across one auto-generated seed set. */
export const MAX_SEED_GENERATED_NODES = 1_000_000;

/**
 * Maximum http `$ref` documents one spec load reads, the spec URL included.
 *
 * `timeoutMs` and `maxBytes` bound one document each, so a host serving an
 * endless chain of new URLs kept a load from ever settling. This bounds the
 * whole load to this many times either limit.
 */
export const MAX_HTTP_REF_DOCUMENTS = 500;
