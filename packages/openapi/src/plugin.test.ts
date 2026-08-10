import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");

describe("openapi plugin", () => {
  it("rejects unsupported query features with a structured setup error", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "test", version: "1.0.0" },
      paths: {},
    };

    await expect(
      openapi({ spec, queryFeatures: { pagination: true } }),
    ).rejects.toMatchObject({
      code: "OPENAPI_UNSUPPORTED_OPTION",
      context: { option: "queryFeatures" },
    });
  });

  describe("Swagger 2.0 integration", () => {
    it("auto-registers all routes from Petstore spec", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      // List (should be empty initially)
      const listResponse = await mock.handle("GET", "/pets");
      expect(listResponse.status).toBe(200);
      expect(listResponse.body).toEqual([]);
    });

    it("CRUD lifecycle with Swagger 2.0", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      // Create
      const created = await mock.handle("POST", "/pets", {
        body: { name: "Buddy", tag: "dog" },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: "Buddy", petId: 1 });

      // Read
      const read = await mock.handle("GET", "/pets/1");
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ name: "Buddy", petId: 1 });

      // Update
      const updated = await mock.handle("PUT", "/pets/1", {
        body: { name: "Max" },
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: "Max", petId: 1 });

      // List
      const list = await mock.handle("GET", "/pets");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);

      // Delete
      const deleted = await mock.handle("DELETE", "/pets/1");
      expect(deleted.status).toBe(204);

      // Verify deletion
      const afterDelete = await mock.handle("GET", "/pets/1");
      expect(afterDelete.status).toBe(404);
      expect(afterDelete.body).toMatchObject({
        error: "Not found",
        code: "NOT_FOUND",
      });
    });

    it("handles non-CRUD endpoints", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      // Health endpoint — should return a generated response
      const health = await mock.handle("GET", "/health");
      expect(health.status).toBe(200);
      expect(health.body).toBeDefined();
    });
  });

  describe("OpenAPI 3.0 integration", () => {
    it("auto-registers routes from OpenAPI 3.0 spec", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-openapi3.json` }),
      );

      const list = await mock.handle("GET", "/pets");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body)).toBe(true);
    });
  });

  describe("seed data", () => {
    it("seeds inline data", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: `${fixturesDir}/petstore-swagger2.json`,
          seed: {
            pets: [
              { petId: 1, name: "Buddy" },
              { petId: 2, name: "Max" },
            ],
          },
        }),
      );

      const list = await mock.handle("GET", "/pets");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(2);
    });

    it("seeds auto-generated data from schema", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: `${fixturesDir}/petstore-swagger2.json`,
          seed: {
            pets: { count: 5 },
          },
        }),
      );

      const list = await mock.handle("GET", "/pets");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(5);
    });

    it("seeded data works with read endpoints", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: `${fixturesDir}/petstore-swagger2.json`,
          seed: {
            pets: [{ petId: 42, name: "Luna" }],
          },
        }),
      );

      const read = await mock.handle("GET", "/pets/42");
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ petId: 42, name: "Luna" });
    });

    it("continues auto-incrementing after seeded data", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({
          spec: `${fixturesDir}/petstore-swagger2.json`,
          seed: {
            pets: [
              { petId: 1, name: "Buddy" },
              { petId: 2, name: "Max" },
            ],
          },
        }),
      );

      const created = await mock.handle("POST", "/pets", {
        body: { name: "New" },
      });
      expect(created.status).toBe(201);
      // Should get ID 3 since max existing ID is 2
      expect(created.body).toMatchObject({ petId: 3 });
    });
  });

  describe("404 handling", () => {
    it("returns 404 for non-existent items", async () => {
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      const read = await mock.handle("GET", "/pets/999");
      expect(read.status).toBe(404);
      expect(read.body).toMatchObject({
        error: "Not found",
        code: "NOT_FOUND",
      });
    });
  });

  describe("route metadata", () => {
    const metadataSpec = {
      openapi: "3.0.3",
      info: { title: "Metadata", version: "1.0.0" },
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            tags: ["pets"],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
          post: {
            operationId: "createPet",
            tags: ["pets", "write"],
            responses: {
              "201": {
                description: "Created",
                content: {
                  "application/json": { schema: { type: "object" } },
                },
              },
            },
          },
        },
        "/pets/{petId}": {
          get: {
            operationId: "readPet",
            tags: ["pets"],
            parameters: [
              {
                name: "petId",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": { schema: { type: "object" } },
                },
              },
            },
          },
        },
        "/health": {
          get: {
            operationId: "checkHealth",
            tags: ["ops"],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": { schema: { type: "object" } },
                },
              },
            },
          },
        },
      },
    };

    async function probeRoutes(): Promise<Map<string, Schmock.RouteConfig>> {
      const seen = new Map<string, Schmock.RouteConfig>();
      const mock = schmock({ state: {} });
      mock.pipe(await openapi({ spec: metadataSpec }));
      mock.pipe({
        name: "metadata-probe",
        beforeRequest(context) {
          seen.set(`${context.method} ${context.path}`, context.route);
          return undefined;
        },
        process(context, response) {
          return { context, response };
        },
      });

      await mock.handle("GET", "/pets");
      await mock.handle("POST", "/pets", { body: {} });
      await mock.handle("GET", "/health");
      return seen;
    }

    it("carries operationId and tags on both CRUD and non-CRUD routes", async () => {
      const seen = await probeRoutes();

      expect(seen.get("GET /pets")?.["openapi:operationId"]).toBe("listPets");
      expect(seen.get("GET /pets")?.["openapi:tags"]).toEqual(["pets"]);
      expect(seen.get("POST /pets")?.["openapi:operationId"]).toBe("createPet");
      expect(seen.get("GET /health")?.["openapi:operationId"]).toBe(
        "checkHealth",
      );
      expect(seen.get("GET /health")?.["openapi:tags"]).toEqual(["ops"]);
    });

    it("keeps the preflight status asymmetry between CRUD list, CRUD create and non-CRUD", async () => {
      const seen = await probeRoutes();

      expect(
        seen.get("GET /pets")?.["openapi:preflightResponseStatus"],
      ).toBeUndefined();
      expect(seen.get("POST /pets")?.["openapi:preflightResponseStatus"]).toBe(
        201,
      );
      expect(seen.get("GET /health")?.["openapi:preflightResponseStatus"]).toBe(
        200,
      );
    });
  });

  describe("state isolation", () => {
    it("isolates state between separate mock instances", async () => {
      const mock1 = schmock({ state: {} });
      mock1.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      const mock2 = schmock({ state: {} });
      mock2.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      await mock1.handle("POST", "/pets", { body: { name: "A" } });

      const list1 = await mock1.handle("GET", "/pets");
      const list2 = await mock2.handle("GET", "/pets");

      const body1 = list1.body;
      const body2 = list2.body;
      expect(Array.isArray(body1) && body1.length).toBe(1);
      expect(Array.isArray(body2) && body2.length).toBe(0);
    });
  });

  describe("transactional mutations", () => {
    it("commits a create exactly once when two plugins are piped", async () => {
      // The second instance owns none of the routes (first registration wins),
      // so it early-returns before settling; the queue is cleared by the first
      // process() either way.
      const mock = schmock({ state: {} });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      const created = await mock.handle("POST", "/pets", {
        body: { name: "Buddy" },
      });
      expect(created.status).toBe(201);

      const list = await mock.handle("GET", "/pets");
      expect(list.body).toHaveLength(1);
    });

    it("clears the pending queue after committing", async () => {
      const state: Record<string, unknown> = {};
      const mock = schmock({ state });
      mock.pipe(
        await openapi({ spec: `${fixturesDir}/petstore-swagger2.json` }),
      );

      await mock.handle("POST", "/pets", { body: { name: "A" } });
      await mock.handle("POST", "/pets", { body: { name: "B" } });

      const list = await mock.handle("GET", "/pets");
      expect(list.body).toHaveLength(2);
      // The queue lives in the per-request plugin Map, never in shared state.
      expect(state["openapi:pendingMutations"]).toBeUndefined();
    });
  });

  describe("validator isolation", () => {
    it("isolates request and response schemas with the same $id", async () => {
      const sharedSchema = {
        $id: "https://example.com/schemas/item.json",
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      };
      const spec = {
        openapi: "3.0.3",
        info: { title: "test", version: "1.0.0" },
        paths: {
          "/echo": {
            post: {
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: sharedSchema },
                },
              },
              responses: {
                "201": {
                  description: "created",
                  content: {
                    "application/json": { schema: sharedSchema },
                  },
                },
              },
            },
          },
        },
      };
      const mock = schmock();
      mock.pipe(
        await openapi({
          spec,
          validateRequests: true,
          validateResponses: true,
        }),
      );

      const response = await mock.handle("POST", "/echo", {
        body: { name: "valid" },
        headers: { accept: "application/json" },
      });

      expect(response.status).toBe(201);
    });

    it("two plugins with overlapping schema $id values don't collide on AJV compile", async () => {
      const sharedId = "https://example.com/schemas/user.json";
      const specBuilder = (minLen: number) => ({
        openapi: "3.0.0",
        info: { title: "test", version: "1.0.0" },
        paths: {
          "/users": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      $id: sharedId,
                      type: "object",
                      properties: {
                        name: { type: "string", minLength: minLen },
                      },
                      required: ["name"],
                    },
                  },
                },
              },
              responses: { "201": { description: "created" } },
            },
          },
        },
      });

      const mockA = schmock();
      const mockB = schmock();
      mockA.pipe(
        await openapi({ spec: specBuilder(1) as any, validateRequests: true }),
      );
      mockB.pipe(
        await openapi({ spec: specBuilder(5) as any, validateRequests: true }),
      );

      const resA = await mockA.handle("POST", "/users", {
        body: { name: "x" },
      });
      const resB = await mockB.handle("POST", "/users", {
        body: { name: "x" },
      });

      expect(resA.status).toBeLessThan(400);
      expect(resB.status).toBe(400);
    });
  });
});

describe("schema overrides", () => {
  const twoMediaTypeSpec = {
    openapi: "3.0.3",
    info: { title: "Media", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { kind: { type: "string", const: "json" } },
                  },
                },
                "application/xml": {
                  schema: {
                    type: "object",
                    properties: { kind: { type: "string", const: "xml" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  it("patches only the JSON branch of a multi-media-type response", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: twoMediaTypeSpec,
        schemas: {
          "GET /items": {
            type: "object",
            properties: { patched: { type: "string", const: "yes" } },
          },
        },
      }),
    );

    const json = await mock.handle("GET", "/items");
    expect(json.body).toEqual({ patched: "yes" });

    const xml = await mock.handle("GET", "/items", {
      headers: { accept: "application/xml" },
    });
    expect(xml.body).toEqual({ kind: "xml" });
  });

  it("still patches an operation declaring a single non-JSON media type", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "XmlOnly", version: "1.0.0" },
          paths: {
            "/reports": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/xml": {
                        schema: {
                          type: "object",
                          properties: {
                            kind: { type: "string", const: "xml" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        schemas: {
          "GET /reports": {
            type: "object",
            properties: { patched: { type: "string", const: "yes" } },
          },
        },
      }),
    );

    const res = await mock.handle("GET", "/reports", {
      headers: { accept: "application/xml" },
    });
    expect(res.body).toEqual({ patched: "yes" });
  });

  it("applies before CRUD seeding, so generated seed items match the override", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: `${fixturesDir}/petstore-openapi3.json`,
        schemas: {
          "GET /pets": {
            type: "array",
            items: {
              type: "object",
              required: ["petId", "nickname"],
              properties: {
                petId: { type: "integer" },
                nickname: { type: "string" },
              },
            },
          },
        },
        seed: { pets: { count: 2 } },
      }),
    );

    const list = await mock.handle("GET", "/pets");
    expect(list.status).toBe(200);
    const items = list.body as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toHaveProperty("nickname");
      expect(item).not.toHaveProperty("tag");
    }
  });
});

describe("identifier policy", () => {
  const thingsSpec = {
    openapi: "3.0.3",
    info: { title: "Things", version: "1.0.0" },
    paths: {
      "/things": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
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
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id", "name"],
                    properties: {
                      id: { type: "integer" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/things/{thingId}": {
        get: {
          parameters: [
            {
              name: "thingId",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  it("normalizes legacy seed rows onto the declared id property", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: thingsSpec,
        seed: { things: [{ thingId: 5, name: "Seeded" }] },
      }),
    );

    const list = await mock.handle("GET", "/things");
    expect(list.body).toEqual([{ id: 5, name: "Seeded" }]);

    // Read still goes through the path parameter's value.
    const read = await mock.handle("GET", "/things/5");
    expect(read.status).toBe(200);
    expect((read.body as Record<string, unknown>).name).toBe("Seeded");

    // The counter continued past the seeded maximum.
    const created = await mock.handle("POST", "/things", {
      body: { name: "Fresh" },
    });
    expect((created.body as Record<string, unknown>).id).toBe(6);
  });

  it("returns the declared create contract instead of the path parameter key", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(await openapi({ spec: thingsSpec }));

    const created = await mock.handle("POST", "/things", {
      body: { name: "Fresh" },
    });
    expect(created.status).toBe(201);
    const body = created.body as Record<string, unknown>;
    expect(body.id).toBe(1);
    expect(body.name).toBe("Fresh");
    expect(body).not.toHaveProperty("thingId");

    const read = await mock.handle("GET", `/things/${body.id}`);
    expect(read.status).toBe(200);
  });
});

describe("server URLs", () => {
  // `ParsedSpec.basePath` was computed and never applied. Removing it turns an
  // accident into a decision: routes register at the spec's own path templates
  // and a prefix is the adapter's `baseUrl` to choose, not the spec's.
  it("does not prefix routes with the servers[].url pathname", async () => {
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Prefixed", version: "1.0.0" },
          servers: [{ url: "https://api.example.com/v2" }],
          paths: {
            "/pets": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: { petId: { type: "integer" } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );

    expect((await mock.handle("GET", "/pets")).status).toBe(200);
    expect((await mock.handle("GET", "/v2/pets")).status).toBe(404);
  });
});
