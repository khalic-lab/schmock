import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import type { CrudResource } from "./crud-detector";
import {
  buildResponse,
  createCreateGenerator,
  createDeleteGenerator,
  createHeaderSeed,
  createListGenerator,
  createReadGenerator,
  createStaticGenerator,
  createUpdateGenerator,
  findArrayProperty,
  generateHeaderValues,
  generateSeedItems,
} from "./generators";
import type { ParsedPath } from "./parser";
import { openapi } from "./plugin";

function makeResource(overrides?: Partial<CrudResource>): CrudResource {
  return {
    name: "pets",
    basePath: "/pets",
    itemPath: "/pets/:petId",
    idParam: "petId",
    idProperty: "petId",
    idKind: "integer",
    operations: ["list", "create", "read", "update", "delete"],
    routes: [],
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
    it("creates, reads, updates, lists, and deletes", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {};

      // Seed the collection
      state["openapi:collections:/pets"] = [];
      state["openapi:counter:/pets"] = 0;

      const create = createCreateGenerator(resource);
      const read = createReadGenerator(resource);
      const update = createUpdateGenerator(resource);
      const list = createListGenerator(resource);
      const del = createDeleteGenerator(resource);

      // Create
      const createResult = await create(
        makeContext({
          method: "POST",
          path: "/pets",
          body: { name: "Buddy" },
          state,
        }),
      );
      expect(createResult).toEqual([201, { name: "Buddy", petId: 1 }]);

      // Read
      const readResult = await read(
        makeContext({
          path: "/pets/1",
          params: { petId: "1" },
          state,
        }),
      );
      expect(readResult).toEqual({ name: "Buddy", petId: 1 });

      // Update
      const updateResult = await update(
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
      const listResult = await list(makeContext({ state }));
      expect(listResult).toEqual([{ name: "Max", petId: 1 }]);

      // Delete
      const deleteResult = await del(
        makeContext({
          method: "DELETE",
          path: "/pets/1",
          params: { petId: "1" },
          state,
        }),
      );
      expect(deleteResult).toEqual([204, undefined]);

      // Verify deletion
      const afterDelete = await list(makeContext({ state }));
      expect(afterDelete).toEqual([]);
    });

    it("uses contract-declared success statuses for every CRUD operation", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [],
        "openapi:counter:/pets": 0,
      };

      const created = await createCreateGenerator(resource, {
        responseStatus: 202,
      })(makeContext({ method: "POST", body: { name: "Buddy" }, state }));
      expect(created).toEqual([202, { name: "Buddy", petId: 1 }]);

      const read = await createReadGenerator(resource, { responseStatus: 203 })(
        makeContext({ params: { petId: "1" }, state }),
      );
      expect(read).toEqual([203, { name: "Buddy", petId: 1 }]);

      const updated = await createUpdateGenerator(resource, {
        responseStatus: 202,
      })(
        makeContext({
          method: "PUT",
          params: { petId: "1" },
          body: { name: "Max" },
          state,
        }),
      );
      expect(updated).toEqual([202, { name: "Max", petId: 1 }]);

      const listed = await createListGenerator(resource, {
        responseStatus: 206,
      })(makeContext({ state }));
      expect(listed).toEqual([206, [{ name: "Max", petId: 1 }]]);

      const deleted = await createDeleteGenerator(resource, {
        responseStatus: 200,
      })(makeContext({ method: "DELETE", params: { petId: "1" }, state }));
      expect(deleted).toEqual([200, { name: "Max", petId: 1 }]);
    });

    it("omits bodies for CRUD operations that declare 204", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [{ name: "Buddy", petId: 1 }],
        "openapi:counter:/pets": 1,
      };
      const noContent = { responseStatus: 204 };

      const created = await createCreateGenerator(
        resource,
        noContent,
      )(makeContext({ method: "POST", body: { name: "New" }, state }));
      const read = await createReadGenerator(
        resource,
        noContent,
      )(makeContext({ params: { petId: "1" }, state }));
      const updated = await createUpdateGenerator(
        resource,
        noContent,
      )(
        makeContext({
          method: "PUT",
          params: { petId: "1" },
          body: { name: "Updated" },
          state,
        }),
      );
      const listed = await createListGenerator(
        resource,
        noContent,
      )(makeContext({ state }));

      expect(created).toEqual([204, undefined]);
      expect(read).toEqual([204, undefined]);
      expect(updated).toEqual([204, undefined]);
      expect(listed).toEqual([204, undefined]);
    });
  });

  describe("read generator", () => {
    it("returns 404 for missing resources", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [],
      };

      const read = createReadGenerator(resource);
      const result = await read(
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
    it("returns 404 for missing resources", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [],
      };

      const update = createUpdateGenerator(resource);
      const result = await update(
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
    it("returns 404 for missing resources", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [],
      };

      const del = createDeleteGenerator(resource);
      const result = await del(
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
    it("auto-increments IDs", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [],
        "openapi:counter:/pets": 0,
      };

      const create = createCreateGenerator(resource);
      await create(makeContext({ method: "POST", body: { name: "A" }, state }));
      await create(makeContext({ method: "POST", body: { name: "B" }, state }));

      const collection = state["openapi:collections:/pets"] as Record<
        string,
        unknown
      >[];
      expect(collection[0].petId).toBe(1);
      expect(collection[1].petId).toBe(2);
    });
  });

  describe("staged mutations", () => {
    const PENDING = "openapi:pendingMutations";

    function takePending(pluginState: Map<string, unknown>): Array<() => void> {
      const pending = pluginState.get(PENDING);
      expect(Array.isArray(pending)).toBe(true);
      return pending as Array<() => void>;
    }

    it("defers the create push until the pending mutation runs", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [],
        "openapi:counter:/pets": 0,
      };
      const pluginState = new Map<string, unknown>();

      const create = createCreateGenerator(resource);
      const result = await create(
        makeContext({
          method: "POST",
          body: { name: "Buddy" },
          state,
          pluginState,
        }),
      );

      // The response carries the eagerly allocated id, but nothing is stored yet.
      expect(result).toEqual([201, { name: "Buddy", petId: 1 }]);
      expect(state["openapi:collections:/pets"]).toEqual([]);
      expect(state["openapi:counter:/pets"]).toBe(1);

      const pending = takePending(pluginState);
      expect(pending).toHaveLength(1);
      for (const commit of pending) commit();

      expect(state["openapi:collections:/pets"]).toEqual([
        { name: "Buddy", petId: 1 },
      ]);
    });

    it("defers the update write until the pending mutation runs", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [{ petId: 1, name: "Buddy" }],
      };
      const pluginState = new Map<string, unknown>();

      const update = createUpdateGenerator(resource);
      const result = await update(
        makeContext({
          method: "PUT",
          path: "/pets/1",
          params: { petId: "1" },
          body: { name: "Max" },
          state,
          pluginState,
        }),
      );

      expect(result).toEqual({ petId: 1, name: "Max" });
      expect(state["openapi:collections:/pets"]).toEqual([
        { petId: 1, name: "Buddy" },
      ]);

      for (const commit of takePending(pluginState)) commit();

      expect(state["openapi:collections:/pets"]).toEqual([
        { petId: 1, name: "Max" },
      ]);
    });

    it("defers the delete splice until the pending mutation runs", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [{ petId: 1, name: "Buddy" }],
      };
      const pluginState = new Map<string, unknown>();

      const del = createDeleteGenerator(resource);
      const result = await del(
        makeContext({
          method: "DELETE",
          path: "/pets/1",
          params: { petId: "1" },
          state,
          pluginState,
        }),
      );

      expect(result).toEqual([204, undefined]);
      expect(state["openapi:collections:/pets"]).toEqual([
        { petId: 1, name: "Buddy" },
      ]);

      for (const commit of takePending(pluginState)) commit();

      expect(state["openapi:collections:/pets"]).toEqual([]);
    });

    it("re-finds the item at commit time when the collection was replaced", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [
          { petId: 1, name: "Buddy" },
          { petId: 2, name: "Rex" },
        ],
      };
      const pluginState = new Map<string, unknown>();

      const del = createDeleteGenerator(resource);
      await del(
        makeContext({
          method: "DELETE",
          path: "/pets/2",
          params: { petId: "2" },
          state,
          pluginState,
        }),
      );

      // A concurrent request shifts indices before the commit runs.
      state["openapi:collections:/pets"] = [
        { petId: 3, name: "Nala" },
        { petId: 1, name: "Buddy" },
        { petId: 2, name: "Rex" },
      ];
      for (const commit of takePending(pluginState)) commit();

      expect(state["openapi:collections:/pets"]).toEqual([
        { petId: 3, name: "Nala" },
        { petId: 1, name: "Buddy" },
      ]);
    });

    it("commits immediately when there is no plugin state", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [],
        "openapi:counter:/pets": 0,
      };

      const create = createCreateGenerator(resource);
      await create(makeContext({ method: "POST", body: { name: "A" }, state }));

      expect(state["openapi:collections:/pets"]).toEqual([
        { name: "A", petId: 1 },
      ]);
    });
  });

  // An unseeded resource writes no counter key, so a collection pre-loaded
  // through `schmock({ state })` reaches the create path with a live collection
  // and NO counter. Minting from 0 there hands the new item an id that already
  // exists, which makes read/update/delete address the wrong row.
  describe("id counter recovery", () => {
    it("resumes past a pre-loaded collection that has no counter key", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [
          { petId: 1, name: "pre-a" },
          { petId: 2, name: "pre-b" },
        ],
      };

      const create = createCreateGenerator(resource);
      const result = await create(
        makeContext({ method: "POST", body: { name: "new" }, state }),
      );

      expect(result).toEqual([201, { name: "new", petId: 3 }]);
      expect(state["openapi:counter:/pets"]).toBe(3);
    });

    it("recovers the counter for a uuid-keyed resource", async () => {
      const resource = makeResource({
        idKind: "uuid",
        schema: {
          type: "object",
          properties: {
            petId: { type: "string", format: "uuid" },
            name: { type: "string" },
          },
          required: ["petId", "name"],
        },
      });
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [
          { petId: "00000000-0000-4000-8000-000000000004", name: "pre" },
        ],
      };

      const create = createCreateGenerator(resource);
      const result = await create(
        makeContext({ method: "POST", body: { name: "new" }, state }),
      );

      expect(result).toEqual([
        201,
        { name: "new", petId: "00000000-0000-4000-8000-000000000005" },
      ]);
    });

    it("leaves an explicitly stored counter authoritative", async () => {
      // `createSeeder` legitimately stores 0 when no seed row carries a
      // recoverable id; a stored number must never be re-derived.
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [{ petId: 9, name: "pre" }],
        "openapi:counter:/pets": 0,
      };

      const create = createCreateGenerator(resource);
      const result = await create(
        makeContext({ method: "POST", body: { name: "new" }, state }),
      );

      expect(result).toEqual([201, { name: "new", petId: 1 }]);
    });

    it("recovers per parent scope on a nested collection", async () => {
      const resource = makeResource({
        basePath: "/owners/:ownerId/pets",
        itemPath: "/owners/:ownerId/pets/:petId",
      });
      const state: Record<string, unknown> = {
        "openapi:collections:/owners/:ownerId/pets|ownerId=7": [
          { petId: 4, name: "pre" },
        ],
      };

      const create = createCreateGenerator(resource);
      const result = await create(
        makeContext({
          method: "POST",
          path: "/owners/7/pets",
          params: { ownerId: "7" },
          body: { name: "new" },
          state,
        }),
      );

      expect(result).toEqual([201, { name: "new", petId: 5 }]);
    });
  });

  describe("generateSeedItems", () => {
    it("generates items with auto-assigned IDs", async () => {
      const schema = {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
        },
        required: ["name" as const],
      };

      const items = await generateSeedItems(schema, 3, "petId", "integer");
      expect(items).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        const item = items[i] as Record<string, unknown>;
        expect(item.petId).toBe(i + 1);
      }
    });

    it("shapes seed ids by the resource id kind", async () => {
      const schema = {
        type: "object" as const,
        properties: { name: { type: "string" as const } },
        required: ["name" as const],
      };

      const strings = await generateSeedItems(schema, 2, "id", "string");
      expect((strings[0] as Record<string, unknown>).id).toBe("1");
      expect((strings[1] as Record<string, unknown>).id).toBe("2");

      const uuids = await generateSeedItems(schema, 2, "id", "uuid");
      expect((uuids[0] as Record<string, unknown>).id).toBe(
        "00000000-0000-4000-8000-000000000001",
      );
      expect((uuids[1] as Record<string, unknown>).id).toBe(
        "00000000-0000-4000-8000-000000000002",
      );
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

    it("emits a boolean-typed header", () => {
      const headers = generateHeaderValues({
        "X-Flag": {
          schema: { type: "boolean" },
          description: "Flag",
        },
      });
      expect(headers["X-Flag"]).toBe("false");
    });
  });

  describe("seeded response headers", () => {
    const headerDefs = {
      "X-Request-Id": {
        schema: { type: "string" as const, format: "uuid" },
        description: "Request id",
      },
      "X-Served-At": {
        schema: { type: "string" as const, format: "date-time" },
        description: "Served at",
      },
    };

    const healthSpec = {
      openapi: "3.0.3",
      info: { title: "Health", version: "1.0.0" },
      paths: {
        "/health": {
          get: {
            responses: {
              "200": {
                description: "OK",
                headers: {
                  "X-Request-Id": {
                    schema: { type: "string", format: "uuid" },
                  },
                  "X-Served-At": {
                    schema: { type: "string", format: "date-time" },
                  },
                },
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { ok: { type: "boolean" } },
                    },
                  },
                },
              },
            },
          },
        },
        "/ready": {
          get: {
            responses: {
              "200": {
                description: "OK",
                headers: {
                  "X-Request-Id": {
                    schema: { type: "string", format: "uuid" },
                  },
                  "X-Served-At": {
                    schema: { type: "string", format: "date-time" },
                  },
                },
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { ready: { type: "boolean" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    async function healthHeaders(
      fakerSeed?: number,
    ): Promise<Record<string, string>> {
      const mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: healthSpec, fakerSeed }));
      const res = await mock.handle("GET", "/health");
      return res.headers;
    }

    it("reproduces uuid and date-time headers across two seeded mocks", async () => {
      const a = await healthHeaders(42);
      const b = await healthHeaders(42);
      expect(a["X-Request-Id"]).toBe(b["X-Request-Id"]);
      expect(a["X-Served-At"]).toBe(b["X-Served-At"]);
    });

    it("produces different header values for a different seed", async () => {
      const a = await healthHeaders(42);
      const b = await healthHeaders(7);
      expect(a["X-Request-Id"]).not.toBe(b["X-Request-Id"]);
      expect(a["X-Served-At"]).not.toBe(b["X-Served-At"]);
    });

    it("keeps unseeded headers random and wall-clock", async () => {
      const a = await healthHeaders();
      const b = await healthHeaders();
      expect(a["X-Request-Id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(a["X-Request-Id"]).not.toBe(b["X-Request-Id"]);
      expect(new Date(a["X-Served-At"]).getUTCFullYear()).toBe(
        new Date().getUTCFullYear(),
      );
    });

    it("advances by request ordinal within one seeded mock", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: healthSpec, fakerSeed: 42 }));
      const first = await mock.handle("GET", "/health");
      const second = await mock.handle("GET", "/health");
      expect(first.headers["X-Request-Id"]).not.toBe(
        second.headers["X-Request-Id"],
      );
    });

    it("shares the seeded header ordinal across routes in one installation", async () => {
      async function requestIds(seed: number): Promise<string[]> {
        const mock = schmock({ state: {} });
        mock.pipe(await openapi({ spec: healthSpec, fakerSeed: seed }));
        const health = await mock.handle("GET", "/health");
        const ready = await mock.handle("GET", "/ready");
        return [health.headers["X-Request-Id"], ready.headers["X-Request-Id"]];
      }

      const firstMock = await requestIds(42);
      const secondMock = await requestIds(42);

      expect(firstMock[0]).not.toBe(firstMock[1]);
      expect(secondMock).toEqual(firstMock);
    });

    it("keeps a seeded uuid header valid under validateResponses", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: healthSpec,
          fakerSeed: 42,
          validateResponses: true,
        }),
      );
      const res = await mock.handle("GET", "/health");
      expect(res.status).toBe(200);
      expect(res.headers["X-Request-Id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("keeps buildResponse header generation deterministic per seed", () => {
      const one = buildResponse({
        status: 200,
        body: {},
        headers: generateHeaderValues(headerDefs, createHeaderSeed(42)),
      });
      const two = buildResponse({
        status: 200,
        body: {},
        headers: generateHeaderValues(headerDefs, createHeaderSeed(42)),
      });
      expect(one).toEqual(two);
    });
  });

  describe("list generator with meta (wrapped response)", () => {
    it("wraps list in schema-defined object when wrapper detected", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [
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
      const result = await list(makeContext({ state }));
      const body = result as Record<string, unknown>;
      expect(body.data).toHaveLength(2);
      expect(body.total).toBeDefined();
    });

    it("returns flat array when no meta provided", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [{ petId: 1, name: "Buddy" }],
      };

      const list = createListGenerator(resource);
      const result = await list(makeContext({ state }));
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("create generator contract", () => {
    it("echoes the request and stamps the id when no contract is declared", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {};

      const created = await createCreateGenerator(resource)(
        makeContext({ method: "POST", body: { name: "Buddy" }, state }),
      );

      expect(created).toEqual([201, { name: "Buddy", petId: 1 }]);
    });

    it("generates the declared contract and overlays the request body", async () => {
      const resource = makeResource({
        idProperty: "id",
        idKind: "string",
        schema: {
          type: "object",
          properties: { id: { type: "string" }, createdAt: { type: "string" } },
        },
      });
      const meta: Schmock.CrudOperationMeta = {
        responseStatus: 201,
        responseSchema: {
          type: "object",
          required: ["id", "createdAt"],
          properties: {
            id: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
      };

      const created = (await createCreateGenerator(
        resource,
        meta,
      )(makeContext({ method: "POST", body: { label: "a" }, state: {} }))) as [
        number,
        Record<string, unknown>,
      ];

      expect(created[0]).toBe(201);
      expect(created[1].id).toBe("1");
      expect(typeof created[1].createdAt).toBe("string");
      expect(created[1]).not.toHaveProperty("petId");
    });

    it("drops undeclared request fields only under additionalProperties: false", async () => {
      const resource = makeResource({ idProperty: "id", idKind: "integer" });
      const closed: Schmock.CrudOperationMeta = {
        responseSchema: {
          type: "object",
          additionalProperties: false,
          properties: { id: { type: "integer" }, name: { type: "string" } },
        },
      };
      const open: Schmock.CrudOperationMeta = {
        responseSchema: {
          type: "object",
          properties: { id: { type: "integer" }, name: { type: "string" } },
        },
      };
      const body = { name: "Buddy", nickname: "Bud" };

      const strict = (await createCreateGenerator(
        resource,
        closed,
      )(makeContext({ method: "POST", body, state: {} }))) as [
        number,
        Record<string, unknown>,
      ];
      expect(strict[1].name).toBe("Buddy");
      expect(strict[1]).not.toHaveProperty("nickname");

      const lenient = (await createCreateGenerator(
        resource,
        open,
      )(makeContext({ method: "POST", body, state: {} }))) as [
        number,
        Record<string, unknown>,
      ];
      expect(lenient[1].nickname).toBe("Bud");
    });

    it("never lets a client-supplied identifier win", async () => {
      const resource = makeResource({ idProperty: "id", idKind: "integer" });
      const created = (await createCreateGenerator(resource)(
        makeContext({
          method: "POST",
          body: { id: 999, name: "Buddy" },
          state: {},
        }),
      )) as [number, Record<string, unknown>];

      expect(created[1].id).toBe(1);
    });

    it("mints string and synthetic-uuid identifiers in sequence", async () => {
      const stringResource = makeResource({
        idProperty: "id",
        idKind: "string",
      });
      const state: Record<string, unknown> = {};
      const first = (await createCreateGenerator(stringResource)(
        makeContext({ method: "POST", body: {}, state }),
      )) as [number, Record<string, unknown>];
      const second = (await createCreateGenerator(stringResource)(
        makeContext({ method: "POST", body: {}, state }),
      )) as [number, Record<string, unknown>];
      expect(first[1].id).toBe("1");
      expect(second[1].id).toBe("2");

      const uuidResource = makeResource({ idProperty: "id", idKind: "uuid" });
      const uuidState: Record<string, unknown> = {};
      const one = (await createCreateGenerator(uuidResource)(
        makeContext({ method: "POST", body: {}, state: uuidState }),
      )) as [number, Record<string, unknown>];
      const two = (await createCreateGenerator(uuidResource)(
        makeContext({ method: "POST", body: {}, state: uuidState }),
      )) as [number, Record<string, unknown>];

      expect(one[1].id).toBe("00000000-0000-4000-8000-000000000001");
      expect(two[1].id).toBe("00000000-0000-4000-8000-000000000002");
      expect(one[1].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it("selects the contract matching the Accept header", async () => {
      const resource = makeResource({ idProperty: "id", idKind: "integer" });
      const meta: Schmock.CrudOperationMeta = {
        responseStatus: 201,
        responseContentTypes: ["application/json", "application/xml"],
        responseSchemasByMediaType: new Map<string, Schmock.JSONSchema7>([
          [
            "application/json",
            {
              type: "object",
              properties: { kind: { type: "string", const: "json" } },
            },
          ],
          [
            "application/xml",
            {
              type: "object",
              properties: { kind: { type: "string", const: "xml" } },
            },
          ],
        ]),
      };

      const xml = (await createCreateGenerator(
        resource,
        meta,
      )(
        makeContext({
          method: "POST",
          body: {},
          headers: { accept: "application/xml" },
          state: {},
        }),
      )) as [number, Record<string, unknown>];
      expect(xml[1].kind).toBe("xml");

      const json = (await createCreateGenerator(
        resource,
        meta,
      )(makeContext({ method: "POST", body: {}, state: {} }))) as [
        number,
        Record<string, unknown>,
      ];
      expect(json[1].kind).toBe("json");
    });
  });

  describe("onSchema during CRUD generation", () => {
    it("fires for the create contract with the route context", async () => {
      const resource = makeResource({ idProperty: "id", idKind: "integer" });
      const seen: Array<{ method: string; path: string }> = [];
      const meta: Schmock.CrudOperationMeta = {
        responseSchema: {
          type: "object",
          properties: { id: { type: "integer" } },
        },
      };

      const created = (await createCreateGenerator(resource, meta, {
        method: "POST",
        path: "/pets",
        onSchema: (schema, ctx) => {
          seen.push({ method: ctx.method, path: ctx.path });
          return {
            ...schema,
            properties: {
              ...(schema.properties ?? {}),
              generatedBy: { type: "string", const: "onSchema" },
            },
          };
        },
      })(makeContext({ method: "POST", body: {}, state: {} }))) as [
        number,
        Record<string, unknown>,
      ];

      expect(seen).toEqual([{ method: "POST", path: "/pets" }]);
      expect(created[1].generatedBy).toBe("onSchema");
    });

    it("fires for the list wrapper skeleton", async () => {
      const resource = makeResource();
      const seen: string[] = [];
      const meta: Schmock.CrudOperationMeta = {
        responseSchema: {
          type: "object",
          properties: { data: { type: "array", items: { type: "object" } } },
        },
      };

      const result = await createListGenerator(resource, meta, {
        method: "GET",
        path: "/pets",
        onSchema: (schema, ctx) => {
          seen.push(`${ctx.method} ${ctx.path}`);
          return {
            ...schema,
            properties: {
              ...(schema.properties ?? {}),
              wrappedBy: { type: "string", const: "onSchema" },
            },
          };
        },
      })(makeContext({ state: { "openapi:collections:/pets": [] } }));

      expect(seen).toEqual(["GET /pets"]);
      expect((result as Record<string, unknown>).wrappedBy).toBe("onSchema");
    });

    it("fires on the 404 path of read, update and delete", async () => {
      const resource = makeResource();
      const seen: string[] = [];
      const errorSchemas = new Map<number, Schmock.JSONSchema7>([
        [404, { type: "object", properties: { code: { type: "string" } } }],
      ]);
      const meta: Schmock.CrudOperationMeta = { errorSchemas };
      const hooks = {
        method: "GET",
        path: "/pets/:petId",
        onSchema: (schema: Schmock.JSONSchema7) => {
          seen.push("fired");
          return {
            ...schema,
            properties: {
              ...(schema.properties ?? {}),
              code: { type: "string", const: "GONE" },
            },
          };
        },
      };
      const state = { "openapi:collections:/pets": [] };

      for (const factory of [
        createReadGenerator,
        createUpdateGenerator,
        createDeleteGenerator,
      ]) {
        const result = (await factory(
          resource,
          meta,
          hooks,
        )(makeContext({ params: { petId: "999" }, state }))) as [
          number,
          Record<string, unknown>,
        ];
        expect(result[0]).toBe(404);
        expect(result[1].code).toBe("GONE");
      }
      expect(seen).toHaveLength(3);
    });

    it("does not fire for a read that hits stored state", async () => {
      const resource = makeResource();
      let calls = 0;

      const result = await createReadGenerator(resource, undefined, {
        method: "GET",
        path: "/pets/:petId",
        onSchema: (schema) => {
          calls += 1;
          return schema;
        },
      })(
        makeContext({
          params: { petId: "1" },
          state: { "openapi:collections:/pets": [{ petId: 1, name: "Buddy" }] },
        }),
      );

      expect(result).toEqual({ petId: 1, name: "Buddy" });
      expect(calls).toBe(0);
    });
  });

  describe("error generator with meta (spec-defined errors)", () => {
    it("uses error schema from meta when available", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [],
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
      const result = await read(
        makeContext({ path: "/pets/999", params: { petId: "999" }, state }),
      );

      expect(Array.isArray(result)).toBe(true);
      const tuple = result as [number, unknown];
      expect(tuple[0]).toBe(404);
      const body = tuple[1] as Record<string, unknown>;
      expect(body.title).toBeDefined();
      expect(body.status).toBeDefined();
    });

    it("falls back to default error when no meta", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:/pets": [],
      };

      const read = createReadGenerator(resource);
      const result = await read(
        makeContext({ path: "/pets/999", params: { petId: "999" }, state }),
      );

      expect(result).toEqual([404, { error: "Not found", code: "NOT_FOUND" }]);
    });
  });

  describe("buildResponse", () => {
    it("keeps a multi-element array body intact when adding headers", () => {
      // Regression pin against the deleted addHeaders(), which sniffed its
      // input and read a flat 2-item list body as a [status, body] tuple.
      const result = buildResponse({
        status: undefined,
        body: ["a", "b"],
        headers: { "X-Total": "2" },
      });

      expect(result).toEqual([200, ["a", "b"], { "X-Total": "2" }]);
    });

    it("returns the bare body when there is no status and no headers", () => {
      expect(buildResponse({ body: { a: 1 } })).toEqual({ a: 1 });
    });

    it("suppresses the body for 204 and keeps declared headers", () => {
      const result = buildResponse({
        status: 204,
        body: { a: 1 },
        headers: { "X-Cache": "HIT" },
      });

      expect(result).toEqual([204, undefined, { "X-Cache": "HIT" }]);
    });

    it("returns a 2-tuple with no headers slot when headers are undefined", () => {
      const result = buildResponse({ status: 201, body: { id: 1 } });
      expect(result).toEqual([201, { id: 1 }]);
      expect((result as unknown[]).length).toBe(2);
    });

    it("treats header defs that yield no value as no headers", () => {
      const result = buildResponse({
        status: 200,
        body: { a: 1 },
        headers: generateHeaderValues({
          "X-Object": { schema: { type: "object" }, description: "Unusable" },
          "X-NoSchema": { description: "No schema" },
        }),
      });

      expect(result).toEqual([200, { a: 1 }]);
      expect((result as unknown[]).length).toBe(2);
    });
  });

  describe("createStaticGenerator response headers", () => {
    function makeParsedPath(overrides?: Partial<ParsedPath>): ParsedPath {
      return {
        path: "/status",
        method: "GET",
        parameters: [],
        requestBodyRequired: false,
        responses: new Map(),
        tags: [],
        ...overrides,
      };
    }

    it("emits declared response headers on a static route", async () => {
      const generator = createStaticGenerator(
        makeParsedPath({
          responses: new Map([
            [
              200,
              {
                description: "OK",
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                },
                headers: {
                  "X-Request-ID": {
                    schema: { type: "string", format: "uuid" },
                    description: "Request id",
                  },
                },
              },
            ],
          ]),
        }),
      );

      const result = await generator(makeContext({ path: "/status" }));
      const tuple = result as [number, unknown, Record<string, string>];
      expect(tuple).toHaveLength(3);
      expect(tuple[0]).toBe(200);
      expect(typeof tuple[2]["X-Request-ID"]).toBe("string");
      expect(tuple[2]["X-Request-ID"].length).toBeGreaterThan(0);
    });

    it("suppresses the body but keeps headers for a declared 204", async () => {
      const generator = createStaticGenerator(
        makeParsedPath({
          responses: new Map([
            [
              204,
              {
                description: "No content",
                headers: {
                  "X-Cache": {
                    schema: { type: "string", enum: ["HIT"] },
                    description: "Cache",
                  },
                },
              },
            ],
          ]),
        }),
      );

      const result = await generator(makeContext({ path: "/status" }));
      expect(result).toEqual([204, undefined, { "X-Cache": "HIT" }]);
    });

    it("emits headers declared on a default-only response at status 200", async () => {
      const generator = createStaticGenerator(
        makeParsedPath({
          responses: new Map([
            [
              "default",
              {
                description: "Default",
                headers: {
                  "X-Fallback": {
                    schema: { type: "string", enum: ["yes"] },
                    description: "Fallback",
                  },
                },
              },
            ],
          ]),
        }),
      );

      const result = await generator(makeContext({ path: "/status" }));
      expect(result).toEqual([200, {}, { "X-Fallback": "yes" }]);
    });

    it("emits the declared error entry's headers at its own status", async () => {
      const generator = createStaticGenerator(
        makeParsedPath({
          responses: new Map([
            [
              400,
              {
                description: "Bad request",
                headers: {
                  "X-Error-Code": {
                    schema: { type: "string", enum: ["BAD"] },
                    description: "Error code",
                  },
                },
              },
            ],
          ]),
        }),
      );

      // An operation with no 2xx answers its lowest declared status, so the
      // headers captured are that entry's — they are not "leaking" onto a
      // synthesised 200, because no 200 is synthesised any more.
      const result = await generator(makeContext({ path: "/status" }));
      expect(result).toEqual([400, {}, { "X-Error-Code": "BAD" }]);
    });

    it("still falls back to 200 for an operation declaring no responses", async () => {
      const generator = createStaticGenerator(
        makeParsedPath({ responses: new Map() }),
      );

      const result = await generator(makeContext({ path: "/status" }));
      expect(result).toEqual([200, {}]);
      expect((result as unknown[]).length).toBe(2);
    });
  });
});

// ===========================================================================
// Per-scope state growth (DEF-STATE-EVICTION)
// ===========================================================================

describe("per-parent state allocation", () => {
  const nestedSpec = {
    openapi: "3.0.3",
    info: { title: "Owners", version: "1.0.0" },
    paths: {
      "/owners/{ownerId}/pets": {
        get: {
          parameters: [
            {
              name: "ownerId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "List",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        petId: { type: "integer" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          parameters: [
            {
              name: "ownerId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      petId: { type: "integer" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/owners/{ownerId}/pets/{petId}": {
        get: {
          parameters: [
            {
              name: "ownerId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "petId",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": {
              description: "Item",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      petId: { type: "integer" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
            "404": { description: "Missing" },
          },
        },
      },
    },
  };

  async function nestedMock(
    state: Record<string, unknown>,
    seed?: Record<string, { count: number }>,
  ): Promise<Schmock.CallableMockInstance> {
    const mock = schmock({ state });
    mock.pipe(await openapi({ spec: nestedSpec, seed, fakerSeed: 1 }));
    return mock;
  }

  it("allocates nothing for read-only traffic across many parent ids", async () => {
    const state: Record<string, unknown> = {};
    const mock = await nestedMock(state);

    for (let i = 0; i < 50; i++) {
      const res = await mock.handle("GET", `/owners/${i}/pets`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    }
    const missing = await mock.handle("GET", "/owners/0/pets/9");
    expect(missing.status).toBe(404);

    expect(Object.keys(state)).toEqual([]);
  });

  it("still stores a created item in its own scope", async () => {
    const state: Record<string, unknown> = {};
    const mock = await nestedMock(state);

    const created = await mock.handle("POST", "/owners/7/pets", {
      body: { name: "Rex" },
    });
    expect(created.status).toBe(201);

    const mine = await mock.handle("GET", "/owners/7/pets");
    expect(mine.body).toEqual([expect.objectContaining({ name: "Rex" })]);

    // A sibling scope neither sees the item nor allocates state of its own.
    const other = await mock.handle("GET", "/owners/8/pets");
    expect(other.body).toEqual([]);

    expect(Object.keys(state).sort()).toEqual([
      "openapi:collections:/owners/:ownerId/pets|ownerId=7",
      "openapi:counter:/owners/:ownerId/pets|ownerId=7",
    ]);
  });

  it("still seeds a scope on read when seed data is configured", async () => {
    const state: Record<string, unknown> = {};
    const mock = await nestedMock(state, { pets: { count: 2 } });

    const first = await mock.handle("GET", "/owners/3/pets");
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(2);

    // Re-seeding on every GET would hand back a different collection each time.
    const second = await mock.handle("GET", "/owners/3/pets");
    expect(second.body).toEqual(first.body);

    expect(state["openapi:seeded:/owners/:ownerId/pets|ownerId=3"]).toBe(true);
  });
});
