import { describe, expect, it } from "vitest";
import type { CrudResource } from "./crud-detector";
import {
  createCreateGenerator,
  createDeleteGenerator,
  createListGenerator,
  createReadGenerator,
  createUpdateGenerator,
  generateSeedItems,
} from "./generators";

function makeResource(overrides?: Partial<CrudResource>): CrudResource {
  return {
    name: "pets",
    basePath: "/pets",
    itemPath: "/pets/:petId",
    idParam: "petId",
    operations: ["list", "create", "read", "update", "delete"],
    schema: {
      type: "object",
      properties: {
        petId: { type: "integer" },
        name: { type: "string" },
      },
      required: ["petId", "name"],
    },
    ...overrides,
  };
}

function makeContext(
  overrides?: Partial<Schmock.RequestContext>,
): Schmock.RequestContext {
  return {
    method: "GET",
    path: "/pets",
    params: {},
    query: {},
    headers: {},
    state: {},
    ...overrides,
  };
}

describe("generators", () => {
  describe("CRUD lifecycle", () => {
    it("creates, reads, updates, lists, and deletes", () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {};

      // Seed the collection
      state["openapi:collections:pets"] = [];
      state["openapi:counter:pets"] = 0;

      const create = createCreateGenerator(resource);
      const read = createReadGenerator(resource);
      const update = createUpdateGenerator(resource);
      const list = createListGenerator(resource);
      const del = createDeleteGenerator(resource);

      // Create
      const createResult = create(
        makeContext({
          method: "POST",
          path: "/pets",
          body: { name: "Buddy" },
          state,
        }),
      );
      expect(createResult).toEqual([201, { name: "Buddy", petId: 1 }]);

      // Read
      const readResult = read(
        makeContext({
          path: "/pets/1",
          params: { petId: "1" },
          state,
        }),
      );
      expect(readResult).toEqual({ name: "Buddy", petId: 1 });

      // Update
      const updateResult = update(
        makeContext({
          method: "PUT",
          path: "/pets/1",
          params: { petId: "1" },
          body: { name: "Max" },
          state,
        }),
      );
      expect(updateResult).toEqual({ name: "Max", petId: 1 });

      // List
      const listResult = list(makeContext({ state }));
      expect(listResult).toEqual([{ name: "Max", petId: 1 }]);

      // Delete
      const deleteResult = del(
        makeContext({
          method: "DELETE",
          path: "/pets/1",
          params: { petId: "1" },
          state,
        }),
      );
      expect(deleteResult).toEqual([204, undefined]);

      // Verify deletion
      const afterDelete = list(makeContext({ state }));
      expect(afterDelete).toEqual([]);
    });
  });

  describe("read generator", () => {
    it("returns 404 for missing resources", () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [],
      };

      const read = createReadGenerator(resource);
      const result = read(
        makeContext({
          path: "/pets/999",
          params: { petId: "999" },
          state,
        }),
      );
      expect(result).toEqual([404, { error: "Not found", code: "NOT_FOUND" }]);
    });
  });

  describe("update generator", () => {
    it("returns 404 for missing resources", () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [],
      };

      const update = createUpdateGenerator(resource);
      const result = update(
        makeContext({
          method: "PUT",
          path: "/pets/999",
          params: { petId: "999" },
          body: { name: "Ghost" },
          state,
        }),
      );
      expect(result).toEqual([404, { error: "Not found", code: "NOT_FOUND" }]);
    });
  });

  describe("delete generator", () => {
    it("returns 404 for missing resources", () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [],
      };

      const del = createDeleteGenerator(resource);
      const result = del(
        makeContext({
          method: "DELETE",
          path: "/pets/999",
          params: { petId: "999" },
          state,
        }),
      );
      expect(result).toEqual([404, { error: "Not found", code: "NOT_FOUND" }]);
    });
  });

  describe("create generator", () => {
    it("auto-increments IDs", () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [],
        "openapi:counter:pets": 0,
      };

      const create = createCreateGenerator(resource);
      create(makeContext({ method: "POST", body: { name: "A" }, state }));
      create(makeContext({ method: "POST", body: { name: "B" }, state }));

      const collection = state["openapi:collections:pets"] as Record<
        string,
        unknown
      >[];
      expect(collection[0].petId).toBe(1);
      expect(collection[1].petId).toBe(2);
    });
  });

  describe("generateSeedItems", () => {
    it("generates items with auto-assigned IDs", () => {
      const schema = {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
        },
        required: ["name" as const],
      };

      const items = generateSeedItems(schema, 3, "petId");
      expect(items).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        const item = items[i] as Record<string, unknown>;
        expect(item.petId).toBe(i + 1);
      }
    });
  });
});
