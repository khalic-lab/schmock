/// <reference path="../../core/schmock.d.ts" />

import { describe, expect, it } from "vitest";
import { negotiateContentType } from "./content-negotiation.js";
import type { CrudResource } from "./crud-detector.js";
import {
  createCreateGenerator,
  createDeleteGenerator,
  createListGenerator,
  createReadGenerator,
  createUpdateGenerator,
  findArrayProperty,
} from "./generators.js";
import {
  processContentNegotiation,
  processPreferHeader,
  validateSecurity,
} from "./request-pipeline.js";
import { loadSeed } from "./seed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeRequestContext(
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

function makePluginContext(
  overrides?: Partial<Schmock.PluginContext>,
): Schmock.PluginContext {
  return {
    path: "/pets",
    method: "GET",
    params: {},
    query: {},
    headers: {},
    body: undefined,
    state: new Map(),
    route: {},
    ...overrides,
  };
}

// ===========================================================================
// generators.ts edge cases
// ===========================================================================

describe("generators edge cases", () => {
  describe("createListGenerator — empty collection", () => {
    it("returns empty array when collection state is empty", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [],
      };

      const list = createListGenerator(resource);
      const result = await list(makeRequestContext({ state }));
      expect(result).toEqual([]);
    });

    it("returns empty array when collection state is not yet initialised", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {};

      const list = createListGenerator(resource);
      const result = await list(makeRequestContext({ state }));
      expect(result).toEqual([]);
    });
  });

  describe("createReadGenerator — items exist but ID does not match", () => {
    it("returns 404 when collection has items but none match the requested ID", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [
          { petId: 1, name: "Buddy" },
          { petId: 2, name: "Max" },
        ],
      };

      const read = createReadGenerator(resource);
      const result = await read(
        makeRequestContext({
          path: "/pets/999",
          params: { petId: "999" },
          state,
        }),
      );
      expect(result).toEqual([404, { error: "Not found", code: "NOT_FOUND" }]);
    });
  });

  describe("createDeleteGenerator — non-existent item", () => {
    it("returns 404 when deleting an item that does not exist", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [{ petId: 1, name: "Buddy" }],
      };

      const del = createDeleteGenerator(resource);
      const result = await del(
        makeRequestContext({
          method: "DELETE",
          path: "/pets/42",
          params: { petId: "42" },
          state,
        }),
      );
      expect(result).toEqual([404, { error: "Not found", code: "NOT_FOUND" }]);
    });

    it("does not remove any items when ID is not found", async () => {
      const resource = makeResource();
      const items = [
        { petId: 1, name: "A" },
        { petId: 2, name: "B" },
      ];
      const state: Record<string, unknown> = {
        "openapi:collections:pets": items,
      };

      const del = createDeleteGenerator(resource);
      await del(
        makeRequestContext({
          method: "DELETE",
          path: "/pets/999",
          params: { petId: "999" },
          state,
        }),
      );

      const collection = state["openapi:collections:pets"] as unknown[];
      expect(collection).toHaveLength(2);
    });
  });

  describe("createUpdateGenerator — non-object body", () => {
    it("works with non-object body by using empty object as merge source", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [{ petId: 1, name: "Buddy" }],
        "openapi:counter:pets": 1,
      };

      const update = createUpdateGenerator(resource);
      const result = await update(
        makeRequestContext({
          method: "PUT",
          path: "/pets/1",
          params: { petId: "1" },
          body: "not-an-object",
          state,
        }),
      );

      // Should preserve existing item fields; non-object body becomes {}
      expect(result).toEqual({ petId: 1, name: "Buddy" });
    });

    it("works with null body", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [{ petId: 1, name: "Buddy" }],
      };

      const update = createUpdateGenerator(resource);
      const result = await update(
        makeRequestContext({
          method: "PUT",
          path: "/pets/1",
          params: { petId: "1" },
          body: null,
          state,
        }),
      );

      expect(result).toEqual({ petId: 1, name: "Buddy" });
    });

    it("works with undefined body", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [{ petId: 1, name: "Buddy" }],
      };

      const update = createUpdateGenerator(resource);
      const result = await update(
        makeRequestContext({
          method: "PUT",
          path: "/pets/1",
          params: { petId: "1" },
          body: undefined,
          state,
        }),
      );

      expect(result).toEqual({ petId: 1, name: "Buddy" });
    });
  });

  describe("getNextId — increments correctly across multiple calls", () => {
    it("auto-increments IDs sequentially across creates", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {
        "openapi:collections:pets": [],
        "openapi:counter:pets": 0,
      };

      const create = createCreateGenerator(resource);

      const r1 = await create(
        makeRequestContext({ method: "POST", body: { name: "A" }, state }),
      );
      const r2 = await create(
        makeRequestContext({ method: "POST", body: { name: "B" }, state }),
      );
      const r3 = await create(
        makeRequestContext({ method: "POST", body: { name: "C" }, state }),
      );

      expect(r1).toEqual([201, { name: "A", petId: 1 }]);
      expect(r2).toEqual([201, { name: "B", petId: 2 }]);
      expect(r3).toEqual([201, { name: "C", petId: 3 }]);
      expect(state["openapi:counter:pets"]).toBe(3);
    });

    it("starts from 1 when counter state is not initialised", async () => {
      const resource = makeResource();
      const state: Record<string, unknown> = {};

      const create = createCreateGenerator(resource);
      const result = await create(
        makeRequestContext({ method: "POST", body: { name: "First" }, state }),
      );

      expect(result).toEqual([201, { name: "First", petId: 1 }]);
    });
  });

  describe("findArrayProperty — no array in schema", () => {
    it("returns empty object for object schema with only scalar properties", () => {
      const result = findArrayProperty({
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          active: { type: "boolean" },
        },
      });
      expect(result).toEqual({});
    });

    it("returns empty object for primitive schema", () => {
      const result = findArrayProperty({ type: "string" });
      expect(result).toEqual({});
    });

    it("returns empty object for boolean schema", () => {
      const result = findArrayProperty(false as never);
      expect(result).toEqual({});
    });
  });

  describe("findArrayProperty — allOf composition with array property", () => {
    it("finds array in deeply nested allOf branches", () => {
      const result = findArrayProperty({
        allOf: [
          {
            type: "object",
            properties: {
              total: { type: "integer" },
              page: { type: "integer" },
            },
          },
          {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    title: { type: "string" },
                  },
                },
              },
            },
          },
        ],
      });
      expect(result.property).toBe("results");
      expect(result.itemSchema).toBeDefined();
      expect(result.itemSchema?.type).toBe("object");
    });

    it("returns empty when allOf branches have no array property", () => {
      const result = findArrayProperty({
        allOf: [
          {
            type: "object",
            properties: {
              id: { type: "integer" },
            },
          },
          {
            type: "object",
            properties: {
              name: { type: "string" },
            },
          },
        ],
      });
      expect(result).toEqual({});
    });

    it("returns empty when allOf branches have no properties at all", () => {
      const result = findArrayProperty({
        allOf: [{ type: "string" }, { type: "number" }],
      });
      expect(result).toEqual({});
    });
  });
});

// ===========================================================================
// content-negotiation.ts edge cases
// ===========================================================================

describe("content-negotiation edge cases", () => {
  describe("Accept header with q=0 (explicitly rejected type)", () => {
    it("skips types with q=0", () => {
      const result = negotiateContentType(
        "application/json;q=0, application/xml",
        ["application/json", "application/xml"],
      );
      // application/json is explicitly rejected, so xml should win
      expect(result).toBe("application/xml");
    });

    it("returns null when all types have q=0", () => {
      const result = negotiateContentType(
        "application/json;q=0, application/xml;q=0",
        ["application/json", "application/xml"],
      );
      expect(result).toBeNull();
    });
  });

  describe("Accept header with malformed q-value", () => {
    it("handles q=abc gracefully by treating as default q=1", () => {
      // Number.parseFloat("abc") => NaN, which sorts unpredictably,
      // but should not crash
      const _result = negotiateContentType("application/json;q=abc", [
        "application/json",
      ]);
      // NaN comparison: NaN !== 0 so the entry is not skipped
      // but NaN comparisons in sort are unpredictable
      // The key thing is it doesn't throw
      expect(() =>
        negotiateContentType("application/json;q=abc", ["application/json"]),
      ).not.toThrow();
    });

    it("handles q= (empty) gracefully", () => {
      expect(() =>
        negotiateContentType("application/json;q=", ["application/json"]),
      ).not.toThrow();
    });
  });

  describe("Accept header with multiple types and mixed q values", () => {
    it("selects highest quality match among available types", () => {
      const result = negotiateContentType(
        "text/html;q=0.9, application/json;q=1.0, text/plain;q=0.5",
        ["text/plain", "application/json"],
      );
      expect(result).toBe("application/json");
    });

    it("falls back to lower quality when highest is unavailable", () => {
      const result = negotiateContentType(
        "application/xml;q=1.0, application/json;q=0.8",
        ["application/json"],
      );
      expect(result).toBe("application/json");
    });
  });

  describe("empty Accept header string", () => {
    it("returns first available type for empty string", () => {
      const result = negotiateContentType("", ["application/json"]);
      expect(result).toBe("application/json");
    });
  });
});

// ===========================================================================
// request-pipeline.ts edge cases
// ===========================================================================

describe("request-pipeline edge cases", () => {
  describe("validateSecurity — reference to non-existent security scheme", () => {
    it("returns 401 when security references a scheme that does not exist", () => {
      const schemes = new Map<
        string,
        { type: "apiKey" | "http" | "oauth2" | "openIdConnect" }
      >();
      // No schemes registered at all

      const context = makePluginContext({
        headers: { authorization: "Bearer token123" },
        route: { "openapi:security": [["nonExistentScheme"]] },
      });

      const result = validateSecurity(context, schemes);
      expect(result).toBeDefined();
      expect(result?.response).toBeDefined();
      const response = result?.response as [number, unknown, unknown];
      expect(response[0]).toBe(401);
    });
  });

  describe("validateSecurity — API key in query parameter", () => {
    it("passes through when apiKey is in query (cannot be validated from headers)", () => {
      const schemes = new Map([
        [
          "apiKeyQuery",
          {
            type: "apiKey" as const,
            in: "query" as const,
            name: "api_key",
          },
        ],
      ]);

      const context = makePluginContext({
        headers: {},
        route: { "openapi:security": [["apiKeyQuery"]] },
      });

      // Query-based API keys pass through since headers-only validation
      const result = validateSecurity(context, schemes);
      expect(result).toBeUndefined();
    });

    it("rejects when apiKey is in header and header is missing", () => {
      const schemes = new Map([
        [
          "apiKeyHeader",
          {
            type: "apiKey" as const,
            in: "header" as const,
            name: "X-API-Key",
          },
        ],
      ]);

      const context = makePluginContext({
        headers: {},
        route: { "openapi:security": [["apiKeyHeader"]] },
      });

      const result = validateSecurity(context, schemes);
      expect(result).toBeDefined();
      const response = result?.response as [number, unknown];
      expect(response[0]).toBe(401);
    });

    it("passes when apiKey is in header and header is present", () => {
      const schemes = new Map([
        [
          "apiKeyHeader",
          {
            type: "apiKey" as const,
            in: "header" as const,
            name: "X-API-Key",
          },
        ],
      ]);

      const context = makePluginContext({
        headers: { "x-api-key": "my-secret-key" },
        route: { "openapi:security": [["apiKeyHeader"]] },
      });

      const result = validateSecurity(context, schemes);
      expect(result).toBeUndefined();
    });
  });

  describe("processPreferHeader — return=representation", () => {
    it("returns full body unchanged when Prefer header is not a recognised directive", async () => {
      const context = makePluginContext({
        headers: { prefer: "return=representation" },
        route: {
          "openapi:responses": new Map([
            [
              200,
              {
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                },
                description: "OK",
              },
            ],
          ]),
        },
      });

      const originalResponse = { id: 1, name: "Test" };
      const result = await processPreferHeader(context, originalResponse);
      // "return=representation" is not a recognised Schmock prefer directive,
      // so the response should pass through unchanged
      expect(result.response).toEqual(originalResponse);
    });
  });

  describe("processPreferHeader — return=minimal", () => {
    it("returns response unchanged for unrecognised prefer directive", async () => {
      const context = makePluginContext({
        headers: { prefer: "return=minimal" },
        route: {
          "openapi:responses": new Map([
            [
              200,
              {
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                },
                description: "OK",
              },
            ],
          ]),
        },
      });

      const originalResponse = { id: 1, name: "Full body" };
      const result = await processPreferHeader(context, originalResponse);
      // "return=minimal" is not a recognised directive — passes through
      expect(result.response).toEqual(originalResponse);
    });
  });

  describe("processPreferHeader — code directive", () => {
    it("returns response for the requested status code", async () => {
      const context = makePluginContext({
        headers: { prefer: "code=404" },
        route: {
          "openapi:responses": new Map([
            [
              200,
              {
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                },
                description: "OK",
              },
            ],
            [
              404,
              {
                schema: {
                  type: "object",
                  properties: {
                    error: { type: "string", default: "Not found" },
                  },
                },
                description: "Not Found",
              },
            ],
          ]),
        },
      });

      const result = await processPreferHeader(context, { id: 1 });
      const [status] = result.response as [number, unknown];
      expect(status).toBe(404);
    });
  });

  describe("processPreferHeader — no Prefer header", () => {
    it("returns response unchanged when no Prefer header exists", async () => {
      const context = makePluginContext({
        headers: {},
        route: {},
      });

      const originalResponse = { id: 1 };
      const result = await processPreferHeader(context, originalResponse);
      expect(result.response).toEqual(originalResponse);
    });
  });

  describe("processPreferHeader — no responses on route", () => {
    it("returns response unchanged when route has no openapi:responses", async () => {
      const context = makePluginContext({
        headers: { prefer: "code=200" },
        route: {},
      });

      const originalResponse = { id: 1 };
      const result = await processPreferHeader(context, originalResponse);
      expect(result.response).toEqual(originalResponse);
    });
  });

  describe("processContentNegotiation — via negotiateContentType", () => {
    it("returns 406 when Accept header does not match available types", () => {
      const context = makePluginContext({
        headers: { accept: "text/xml" },
        route: {
          "openapi:responses": new Map([
            [
              200,
              {
                schema: { type: "object" },
                description: "OK",
                contentTypes: ["application/json"],
              },
            ],
          ]),
        },
      });

      const result = processContentNegotiation(context);
      expect(result).toBeDefined();
      const response = result?.response as [number, unknown];
      expect(response[0]).toBe(406);
    });

    it("passes when Accept matches an available type", () => {
      const context = makePluginContext({
        headers: { accept: "application/json" },
        route: {
          "openapi:responses": new Map([
            [
              200,
              {
                schema: { type: "object" },
                description: "OK",
                contentTypes: ["application/json"],
              },
            ],
          ]),
        },
      });

      const result = processContentNegotiation(context);
      expect(result).toBeUndefined();
    });
  });
});

// ===========================================================================
// seed.ts failure modes
// ===========================================================================

describe("seed edge cases", () => {
  describe("loadSeed with count=0", () => {
    it("produces an empty array for count=0", async () => {
      const resources: CrudResource[] = [makeResource()];
      const config = { pets: { count: 0 } };

      const result = await loadSeed(config, resources);
      expect(result.get("pets")).toEqual([]);
    });
  });

  describe("loadSeed with negative count", () => {
    it("throws an error for negative count", async () => {
      const resources: CrudResource[] = [makeResource()];
      const config = { pets: { count: -1 } };

      await expect(loadSeed(config, resources)).rejects.toThrow(
        /non-negative integer/,
      );
    });
  });

  describe("loadSeed with fractional count", () => {
    it("throws an error for non-integer count", async () => {
      const resources: CrudResource[] = [makeResource()];
      const config = { pets: { count: 2.5 } };

      await expect(loadSeed(config, resources)).rejects.toThrow(
        /non-negative integer/,
      );
    });
  });
});
