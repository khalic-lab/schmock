/// <reference path="../../../types/schmock.d.ts" />

import { readFileSync } from "node:fs";
import type { CrudResource } from "./crud-detector.js";
import { generateSeedItems } from "./generators.js";

export type SeedSource = unknown[] | string | { count: number };

export type SeedConfig = Record<string, SeedSource>;

/**
 * Load seed data for CRUD resources.
 *
 * Sources:
 * - unknown[]: inline array of objects
 * - string: file path to a JSON array
 * - { count: number }: auto-generate N items from resource schema
 */
export function loadSeed(
  config: SeedConfig,
  resources: CrudResource[],
): Map<string, unknown[]> {
  const result = new Map<string, unknown[]>();

  for (const [resourceName, source] of Object.entries(config)) {
    const resource = resources.find((r) => r.name === resourceName);

    if (Array.isArray(source)) {
      // Inline array
      result.set(resourceName, [...source]);
    } else if (typeof source === "string") {
      // File path
      const content = readFileSync(source, "utf-8");
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error(
          `Seed file "${source}" for resource "${resourceName}" must contain a JSON array`,
        );
      }
      result.set(resourceName, parsed);
    } else if (
      typeof source === "object" &&
      source !== null &&
      "count" in source
    ) {
      // Auto-generate from schema
      if (!resource?.schema) {
        throw new Error(
          `Cannot auto-generate seed for "${resourceName}": no schema found in spec`,
        );
      }
      const items = generateSeedItems(
        resource.schema,
        source.count,
        resource.idParam,
      );
      result.set(resourceName, items);
    }
  }

  return result;
}
