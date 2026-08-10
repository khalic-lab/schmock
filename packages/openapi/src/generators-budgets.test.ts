/// <reference path="../../core/schmock.d.ts" />

import { ResourceLimitError } from "@schmock/core";
import { generateFromSchema } from "@schmock/faker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSeedItems } from "./generators.js";
import { MAX_SEED_GENERATED_NODES } from "./limits.js";

// Lives in its own file rather than generators.test.ts: the node budget can only
// be reached quickly with a faked generator, and mocking @schmock/faker module
// wide would neuter every real-generation test in that suite.
vi.mock("@schmock/faker", () => ({
  generateFromSchema: vi.fn(),
}));

const generateFromSchemaMock = vi.mocked(generateFromSchema);

/** ~10_100 JSON nodes: 100 properties, each a 100-element array. */
function fatItem(): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (let index = 0; index < 100; index++) {
    item[`field${index}`] = Array.from({ length: 100 }, (_, n) => n);
  }
  return item;
}

const NODES_PER_FAT_ITEM = 100 * 101 + 1;

describe("generateSeedItems — generation budgets", () => {
  beforeEach(() => {
    generateFromSchemaMock.mockReset();
  });

  it("throws ResourceLimitError once the node budget is exhausted", async () => {
    generateFromSchemaMock.mockImplementation(async () => fatItem());
    // Item count alone would pass every other budget; only the node count bites.
    const count = Math.ceil(MAX_SEED_GENERATED_NODES / NODES_PER_FAT_ITEM) + 1;

    await expect(
      generateSeedItems({ type: "object" }, count, "petId", "integer"),
    ).rejects.toThrow(ResourceLimitError);
    await expect(
      generateSeedItems({ type: "object" }, count, "petId", "integer"),
    ).rejects.toThrow(/seed generated nodes/);
  });

  it("leaves a modest seed set untouched", async () => {
    generateFromSchemaMock.mockImplementation(async () => ({ name: "x" }));

    const items = await generateSeedItems(
      { type: "object" },
      5,
      "petId",
      "integer",
    );

    expect(items).toHaveLength(5);
    expect(
      items.map((item) => (item as Record<string, unknown>).petId),
    ).toEqual([1, 2, 3, 4, 5]);
  });
});
