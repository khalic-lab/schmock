import { describe, expect, it } from "vitest";
import type { CrudResource } from "./crud-detector";
import {
  createCreateGenerator,
  createDeleteGenerator,
  createListGenerator,
  createReadGenerator,
  createUpdateGenerator,
  findArrayProperty,
  generateHeaderValues,
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

  describe("findArrayProperty", () => {
    it("returns empty for flat type:array schema", () => {
      const result = findArrayProperty({
        type: "array",
        items: { type: "object", properties: { id: { type: "integer" } } },
      });
      expect(result.property).toBeUndefined();
      expect(result.itemSchema).toBeDefined();
    });

    it("finds array in Stripe-style inline object", () => {
      const result = findArrayProperty({
        type: "object",
        properties: {
          data: {
            type: "array",
            items: {
              type: "object",
              properties: { email: { type: "string" } },
            },
          },
          has_more: { type: "boolean" },
          object: { type: "string", enum: ["list"] },
          url: { type: "string" },
        },
        required: ["data", "has_more", "object", "url"],
      });
      expect(result.property).toBe("data");
      expect(result.itemSchema).toBeDefined();
    });

    it("finds array in allOf composition (Scalar Galaxy style)", () => {
      const result = findArrayProperty({
        allOf: [
          {
            type: "object",
            properties: {
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
          {
            type: "object",
            properties: {
              meta: {
                type: "object",
                properties: { total: { type: "integer" } },
              },
            },
          },
        ],
      });
      expect(result.property).toBe("data");
      expect(result.itemSchema).toBeDefined();
    });

    it("tries first branch of anyOf", () => {
      const result = findArrayProperty({
        anyOf: [
          {
            type: "array",
            items: { type: "object" },
          },
          { type: "null" },
        ],
      });
      expect(result.property).toBeUndefined();
      expect(result.itemSchema).toBeDefined();
    });

    it("returns empty for schema with no array property", () => {
      const result = findArrayProperty({
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "integer" },
        },
      });
      expect(result.property).toBeUndefined();
      expect(result.itemSchema).toBeUndefined();
    });

    it("returns empty for empty schema", () => {
      const result = findArrayProperty({});
      expect(result.property).toBeUndefined();
      expect(result.itemSchema).toBeUndefined();
    });
  });

  describe("generateHeaderValues", () => {
    it("returns empty object for undefined defs", () => {
      expect(generateHeaderValues(undefined)).toEqual({});
    });

    it("returns empty object for empty defs", () => {
      expect(generateHeaderValues({})).toEqual({});
    });

    it("generates UUID for format:uuid", () => {
      const headers = generateHeaderValues({
        "X-Request-ID": {
          schema: { type: "string", format: "uuid" },
          description: "Request ID",
        },
      });
      expect(headers["X-Request-ID"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("generates ISO date for format:date-time", () => {
      const headers = generateHeaderValues({
        "X-Timestamp": {
          schema: { type: "string", format: "date-time" },
          description: "Timestamp",
        },
      });
      expect(new Date(headers["X-Timestamp"]).toISOString()).toBe(
        headers["X-Timestamp"],
      );
    });

    it("uses first enum value", () => {
      const headers = generateHeaderValues({
        "X-Cache": {
          schema: { type: "string", enum: ["HIT", "MISS"] },
          description: "Cache status",
        },
      });
      expect(headers["X-Cache"]).toBe("HIT");
    });

    it("uses default value from example normalization", () => {
      const headers = generateHeaderValues({
        "X-Total": {
          schema: { type: "integer", default: 1000 },
          description: "Total items",
        },
      });
      expect(headers["X-Total"]).toBe("1000");
    });

    it("generates 0 for integer type", () => {
      const headers = generateHeaderValues({
        "X-Count": {
          schema: { type: "integer" },
          description: "Count",
        },
      });
      expect(headers["X-Count"]).toBe("0");
    });

    it("generates empty string for string type", () => {
      const headers = generateHeaderValues({
        "X-Token": {
          schema: { type: "string" },
          description: "Token",
        },
      });
      expect(headers["X-Token"]).toBe("");
    });

    it("skips headers with no schema", () => {
      const headers = generateHeaderValues({
        "X-NoSchema": {
          description: "No schema defined",
        },
      });
      expect(headers["X-NoSchema"]).toBeUndefined();
    });
  });

  describe("list generator with meta (wrapped response)", () => {
    it("wraps list in schema-defined object when wrapper detected", () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [
          { petId: 1, name: "Buddy" },
          { petId: 2, name: "Max" },
        ],
      };

      const meta: Schmock.CrudOperationMeta = {
        responseSchema: {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: {
                type: "object",
                properties: { petId: { type: "integer" } },
              },
            },
            total: { type: "integer", default: 0 },
          },
        },
      };

      const list = createListGenerator(resource, meta);
      const result = list(makeContext({ state }));
      const body = result as Record<string, unknown>;
      expect(body.data).toHaveLength(2);
      expect(body.total).toBeDefined();
    });

    it("returns flat array when no meta provided", () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [{ petId: 1, name: "Buddy" }],
      };

      const list = createListGenerator(resource);
      const result = list(makeContext({ state }));
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("error generator with meta (spec-defined errors)", () => {
    it("uses error schema from meta when available", () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [],
      };

      const errorSchemas = new Map<number, Schmock.JSONSchema7>();
      errorSchemas.set(404, {
        type: "object",
        properties: {
          title: { type: "string", default: "Not Found" },
          status: { type: "integer", default: 404 },
        },
        required: ["title", "status"],
      });

      const meta: Schmock.CrudOperationMeta = { errorSchemas };
      const read = createReadGenerator(resource, meta);
      const result = read(
        makeContext({ path: "/pets/999", params: { petId: "999" }, state }),
      );

      expect(Array.isArray(result)).toBe(true);
      const tuple = result as [number, unknown];
      expect(tuple[0]).toBe(404);
      const body = tuple[1] as Record<string, unknown>;
      expect(body.title).toBeDefined();
      expect(body.status).toBeDefined();
    });

    it("falls back to default error when no meta", () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [],
      };

      const read = createReadGenerator(resource);
      const result = read(
        makeContext({ path: "/pets/999", params: { petId: "999" }, state }),
      );

      expect(result).toEqual([404, { error: "Not found", code: "NOT_FOUND" }]);
    });
  });
});
