import { ResourceLimitError } from "@schmock/core";
import type { CrudResource } from "./crud-detector.js";
import { generateSeedItems } from "./generators.js";
import {
  MAX_SEED_FILE_BYTES,
  MAX_SEED_ITEMS_PER_RESOURCE,
  MAX_SEED_ITEMS_TOTAL,
} from "./limits.js";

export type SeedSource = unknown[] | string | { count: number };

export type SeedConfig = Record<string, SeedSource>;

/**
 * Load seed data for CRUD resources.
 *
 * Sources:
 * - unknown[]: inline array of objects
 * - string: file path to a JSON array
 * - { count: number }: auto-generate N items from resource schema
 *
 * KNOWN GAP (tracked separately): seed entries are keyed by resource *name*
 * while collections are keyed by the resource's full collection path. A spec
 * declaring both `/users` and `/admins/users` therefore yields two independent
 * collections that draw from the same `users` seed entry, and `{ count: n }`
 * generates from whichever resource `find` matches first. Per-path seed
 * targeting needs a key syntax change and is out of scope here.
 */
export async function loadSeed(
  config: SeedConfig,
  resources: CrudResource[],
  fakerSeed?: number,
): Promise<Map<string, unknown[]>> {
  const result = new Map<string, unknown[]>();

  // Budgets are enforced at plugin construction so an over-sized seed fails
  // once, loudly, instead of once per request.
  let totalItems = 0;
  const admit = (resourceName: string, count: number): void => {
    if (count > MAX_SEED_ITEMS_PER_RESOURCE) {
      throw new ResourceLimitError(
        `seed items for "${resourceName}"`,
        MAX_SEED_ITEMS_PER_RESOURCE,
        count,
      );
    }
    totalItems += count;
    if (totalItems > MAX_SEED_ITEMS_TOTAL) {
      throw new ResourceLimitError(
        "seed items (all resources)",
        MAX_SEED_ITEMS_TOTAL,
        totalItems,
      );
    }
  };

  for (const [resourceName, source] of Object.entries(config)) {
    const resource = resources.find((r) => r.name === resourceName);

    if (Array.isArray(source)) {
      // Inline array
      admit(resourceName, source.length);
      result.set(resourceName, [...source]);
    } else if (typeof source === "string") {
      // File path. `node:fs` is imported dynamically ON PURPOSE — a top-level
      // import would make this module unusable in a browser bundle.
      const { readFileSync, statSync } = await import("node:fs");
      // Measured with statSync *before* the read: a read-then-measure check
      // does not prevent the allocation it exists to bound.
      const { size } = statSync(source);
      if (size > MAX_SEED_FILE_BYTES) {
        throw new ResourceLimitError(
          `seed file "${source}"`,
          MAX_SEED_FILE_BYTES,
          size,
        );
      }
      const content = readFileSync(source, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error(
          `Seed file "${source}" for resource "${resourceName}" contains invalid JSON`,
        );
      }
      if (!Array.isArray(parsed)) {
        throw new Error(
          `Seed file "${source}" for resource "${resourceName}" must contain a JSON array`,
        );
      }
      admit(resourceName, parsed.length);
      result.set(resourceName, parsed);
    } else if (
      typeof source === "object" &&
      source !== null &&
      "count" in source
    ) {
      // Auto-generate from schema
      const rawCount = source.count;
      if (
        typeof rawCount !== "number" ||
        !Number.isInteger(rawCount) ||
        rawCount < 0
      ) {
        throw new Error(
          `Seed count for "${resourceName}" must be a non-negative integer, got: ${String(rawCount)}`,
        );
      }
      if (!resource?.schema) {
        throw new Error(
          `Cannot auto-generate seed for "${resourceName}": no schema found in spec`,
        );
      }
      admit(resourceName, rawCount);
      const items = await generateSeedItems(
        resource.schema,
        rawCount,
        resource.idProperty,
        resource.idKind,
        fakerSeed,
      );
      result.set(resourceName, items);
    }
  }

  return result;
}
