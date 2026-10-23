import { schmock } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { detectCrudResources } from "./crud-detector";
import type { ParsedPath } from "./parser";
import { openapi } from "./plugin";
import type { ResponseStatusKey } from "./response-status";

function makePath(
  method: Schmock.HttpMethod,
  path: string,
  responseSchema?: Record<string, unknown>,
): ParsedPath {
  const responses = new Map<number, { schema?: any; description: string }>();
  if (responseSchema) {
    responses.set(200, { schema: responseSchema, description: "OK" });
  }
  return {
    path,
    method,
    parameters: [],
    responses,
    tags: [],
  };
}

function makePathWithStatus(
  method: Schmock.HttpMethod,
  path: string,
  status: number,
): ParsedPath {
  const responses = new Map<number, { schema?: any; description: string }>();
  responses.set(status, { description: "OK" });
  return {
    path,
    method,
    parameters: [],
    responses,
    tags: [],
  };
}

describe("detectCrudResources", () => {
  it("detects a standard CRUD resource", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/pets", {
        type: "array",
        items: { type: "object", properties: { petId: { type: "integer" } } },
      }),
      makePath("POST", "/pets"),
      makePath("GET", "/pets/:petId", {
        type: "object",
        properties: { petId: { type: "integer" } },
      }),
      makePath("PUT", "/pets/:petId"),
      makePath("DELETE", "/pets/:petId"),
    ];

    const result = detectCrudResources(paths);

    expect(result.resources).toHaveLength(1);
    expect(result.nonCrudPaths).toHaveLength(0);

    const resource = result.resources[0];
    expect(resource.name).toBe("pets");
    expect(resource.basePath).toBe("/pets");
    expect(resource.itemPath).toBe("/pets/:petId");
    expect(resource.idParam).toBe("petId");
    expect(resource.operations).toContain("list");
    expect(resource.operations).toContain("create");
    expect(resource.operations).toContain("read");
    expect(resource.operations).toContain("update");
    expect(resource.operations).toContain("delete");
  });

  it("detects a read-only API", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/articles", {
        type: "array",
        items: {
          type: "object",
          properties: { articleId: { type: "integer" } },
        },
      }),
      makePath("GET", "/articles/:articleId"),
    ];

    const result = detectCrudResources(paths);

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].operations).toEqual(["list", "read"]);
  });

  it("handles non-CRUD endpoints", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/health"),
      makePath("POST", "/login"),
    ];

    const result = detectCrudResources(paths);

    expect(result.resources).toHaveLength(0);
    expect(result.nonCrudPaths).toHaveLength(2);
  });

  it("handles mixed CRUD and non-CRUD endpoints", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/pets"),
      makePath("POST", "/pets"),
      makePath("GET", "/health"),
    ];

    const result = detectCrudResources(paths);

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].name).toBe("pets");
    expect(result.nonCrudPaths).toHaveLength(1);
    expect(result.nonCrudPaths[0].path).toBe("/health");
  });

  it("handles nested resources", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/owners/:ownerId/pets"),
      makePath("POST", "/owners/:ownerId/pets"),
    ];

    const result = detectCrudResources(paths);

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].name).toBe("pets");
    expect(result.resources[0].basePath).toBe("/owners/:ownerId/pets");
  });

  it("extracts schema from list response items", () => {
    const itemSchema = {
      type: "object",
      properties: {
        petId: { type: "integer" },
        name: { type: "string" },
      },
    };

    const paths: ParsedPath[] = [
      makePath("GET", "/pets", {
        type: "array",
        items: itemSchema,
      }),
      makePath("POST", "/pets"),
    ];

    const result = detectCrudResources(paths);

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].schema).toEqual(itemSchema);
  });

  it("keeps a distinct descriptor and metadata per declared update method", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/pets"),
      makePath("POST", "/pets"),
      makePathWithStatus("PUT", "/pets/:petId", 200),
      makePathWithStatus("PATCH", "/pets/:petId", 204),
    ];

    const result = detectCrudResources(paths);
    const resource = result.resources[0];

    const updates = resource.routes.filter((r) => r.op === "update");
    expect(updates).toHaveLength(2);
    expect(updates.map((r) => r.method)).toEqual(["PUT", "PATCH"]);
    expect(updates[0].meta.responseStatus).toBe(200);
    expect(updates[1].meta.responseStatus).toBe(204);

    // `operations` stays a deduped list of CRUD roles
    const updateCount = resource.operations.filter(
      (op) => op === "update",
    ).length;
    expect(updateCount).toBe(1);
  });

  it("a PUT-only item path yields no PATCH descriptor", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/pets"),
      makePath("POST", "/pets"),
      makePath("PUT", "/pets/:petId"),
    ];

    const result = detectCrudResources(paths);
    const resource = result.resources[0];

    expect(resource.routes.some((r) => r.method === "PATCH")).toBe(false);
    expect(resource.routes.some((r) => r.method === "PUT")).toBe(true);
  });

  it("unclassified methods inside a CRUD group are returned as non-CRUD", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/pets"),
      makePath("POST", "/pets"),
      makePath("GET", "/pets/:petId"),
      makePath("HEAD", "/pets/:petId"),
      makePath("OPTIONS", "/pets"),
    ];

    const result = detectCrudResources(paths);

    expect(result.resources).toHaveLength(1);
    expect(
      result.resources[0].routes.some(
        (r) => r.method === "HEAD" || r.method === "OPTIONS",
      ),
    ).toBe(false);

    const leftovers = result.nonCrudPaths.map((p) => `${p.method} ${p.path}`);
    expect(leftovers).toContain("HEAD /pets/:petId");
    expect(leftovers).toContain("OPTIONS /pets");
  });

  it("keeps list and create in the resource when paths end in a slash", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/api/pets/"),
      makePath("POST", "/api/pets/"),
      makePath("GET", "/api/pets/:id/"),
      makePath("PUT", "/api/pets/:id/"),
      makePath("DELETE", "/api/pets/:id"),
    ];

    const result = detectCrudResources(paths);

    expect(result.nonCrudPaths).toEqual([]);
    expect(result.resources).toHaveLength(1);
    const resource = result.resources[0];
    expect(resource.basePath).toBe("/api/pets");
    expect(resource.idParam).toBe("id");
    expect(resource.operations).toEqual([
      "list",
      "create",
      "read",
      "update",
      "delete",
    ]);
    // Routes still register at the paths the spec declared.
    expect(resource.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/pets/",
      "POST /api/pets/",
      "GET /api/pets/:id/",
      "PUT /api/pets/:id/",
      "DELETE /api/pets/:id",
    ]);
  });

  it("an item path with a mismatched id param is returned as non-CRUD", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/pets"),
      makePath("POST", "/pets"),
      makePath("GET", "/pets/:petId"),
      makePath("PUT", "/pets/:id"),
    ];

    const result = detectCrudResources(paths);
    const resource = result.resources[0];

    expect(resource.itemPath).toBe("/pets/:petId");
    expect(resource.routes.some((r) => r.op === "update")).toBe(false);

    const leftovers = result.nonCrudPaths.map((p) => `${p.method} ${p.path}`);
    expect(leftovers).toContain("PUT /pets/:id");
  });
});

describe("CRUD error schemas", () => {
  const pet = { type: "object", properties: { id: { type: "integer" } } };
  const problem = {
    type: "object",
    required: ["code", "message"],
    properties: { code: { type: "integer" }, message: { type: "string" } },
  };
  const other = { type: "object", properties: { reason: { type: "string" } } };

  function itemRead(
    responses: Array<[ResponseStatusKey, Record<string, unknown>]>,
  ): Schmock.CrudOperationMeta {
    const read: ParsedPath = {
      path: "/pets/:id",
      method: "GET",
      parameters: [],
      responses: new Map(
        responses.map(([key, schema]) => [
          key,
          { schema: schema as JSONSchema7, description: String(key) },
        ]),
      ),
      tags: [],
    };
    const resource = detectCrudResources([makePath("GET", "/pets"), read])
      .resources[0];
    const route = resource.routes.find((r) => r.op === "read");
    if (!route) throw new Error("expected a read route");
    return route.meta;
  }

  it("uses a `default` error response for the CRUD error statuses", () => {
    const meta = itemRead([
      [200, pet],
      ["default", problem],
    ]);
    for (const status of [400, 404, 409]) {
      expect(meta.errorSchemas?.get(status)).toBe(problem);
    }
  });

  it("prefers the exact status, then the range, then `default`", () => {
    const meta = itemRead([
      [200, pet],
      [404, other],
      ["4XX", problem],
      ["default", pet],
    ]);
    expect(meta.errorSchemas?.get(404)).toBe(other);
    expect(meta.errorSchemas?.get(400)).toBe(problem);
    expect(meta.errorSchemas?.get(409)).toBe(problem);
  });

  it("never answers a CRUD error with the `default` entry that is the success contract", () => {
    const meta = itemRead([["default", pet]]);
    expect(meta.responseSchema).toBe(pet);
    expect(meta.errorSchemas).toBeUndefined();
  });

  it("answers a missing row with the declared `default` error body under validateResponses", async () => {
    const json = (schema: object) => ({ "application/json": { schema } });
    const errors = {
      default: { description: "error", content: json(problem) },
    };
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Defaults", version: "1.0.0" },
          paths: {
            "/pets": {
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: json({ type: "array", items: pet }),
                  },
                  ...errors,
                },
              },
            },
            "/pets/{id}": {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "integer" },
                },
              ],
              get: {
                responses: {
                  "200": { description: "ok", content: json(pet) },
                  ...errors,
                },
              },
              delete: {
                responses: { "204": { description: "gone" }, ...errors },
              },
            },
          },
        },
        validateResponses: true,
      }),
    );

    for (const method of ["GET", "DELETE"] as const) {
      const response = await mock.handle(method, "/pets/999");
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        code: expect.any(Number),
        message: expect.any(String),
      });
    }
  });
});

describe("trailing-slash specs through the plugin", () => {
  it("stores, lists and reads rows of a Django REST Framework style resource", async () => {
    const pet = {
      type: "object",
      properties: { id: { type: "integer" }, name: { type: "string" } },
    };
    const json = (schema: object) => ({ "application/json": { schema } });
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "DRF", version: "1.0.0" },
          paths: {
            "/api/pets/": {
              get: {
                responses: {
                  "200": {
                    description: "ok",
                    content: json({ type: "array", items: pet }),
                  },
                },
              },
              post: {
                requestBody: { content: json(pet) },
                responses: { "201": { description: "ok", content: json(pet) } },
              },
            },
            "/api/pets/{id}/": {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "integer" },
                },
              ],
              get: {
                responses: { "200": { description: "ok", content: json(pet) } },
              },
            },
          },
        },
        seed: { pets: [{ id: 1, name: "Seeded" }] },
      }),
    );

    const created = await mock.handle("POST", "/api/pets/", {
      body: { name: "Rex" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: 2, name: "Rex" });

    const list = await mock.handle("GET", "/api/pets/");
    expect(list.body).toEqual([
      { id: 1, name: "Seeded" },
      { id: 2, name: "Rex" },
    ]);
    const read = await mock.handle("GET", "/api/pets/2/");
    expect(read.body).toEqual({ id: 2, name: "Rex" });
  });
});

describe("identifier resolution", () => {
  function detectOne(
    collection: string,
    itemParam: string,
    itemSchema?: Record<string, unknown>,
  ) {
    const paths: ParsedPath[] = [
      makePath(
        "GET",
        collection,
        itemSchema ? { type: "array", items: itemSchema } : undefined,
      ),
      makePath("POST", collection),
      makePath("GET", `${collection}/:${itemParam}`, itemSchema),
    ];
    return detectCrudResources(paths).resources[0];
  }

  it("keeps the path parameter when the item schema declares it", () => {
    const resource = detectOne("/pets", "petId", {
      type: "object",
      properties: { petId: { type: "integer" }, name: { type: "string" } },
    });

    expect(resource.idParam).toBe("petId");
    expect(resource.idProperty).toBe("petId");
    expect(resource.idKind).toBe("integer");
  });

  it("falls back to a declared `id` and reads its uuid format", () => {
    const resource = detectOne("/bookings", "bookingId", {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        passenger_name: { type: "string" },
      },
    });

    expect(resource.idParam).toBe("bookingId");
    expect(resource.idProperty).toBe("id");
    expect(resource.idKind).toBe("uuid");
  });

  it("treats a plain string id as the string kind", () => {
    const resource = detectOne("/things", "thingId", {
      type: "object",
      properties: { id: { type: "string" } },
    });

    expect(resource.idProperty).toBe("id");
    expect(resource.idKind).toBe("string");
  });

  it("keeps the path parameter when no item schema is declared", () => {
    const resource = detectOne("/widgets", "widgetId");

    expect(resource.idProperty).toBe("widgetId");
    expect(resource.idKind).toBe("integer");
  });

  it("finds an identifier declared through an allOf branch", () => {
    const resource = detectOne("/orders", "orderId", {
      allOf: [
        { type: "object", properties: { id: { type: "string" } } },
        { type: "object", properties: { total: { type: "number" } } },
      ],
    });

    expect(resource.idProperty).toBe("id");
    expect(resource.idKind).toBe("string");
  });

  it("tolerates a nullable union on the declared identifier", () => {
    const resource = detectOne("/notes", "noteId", {
      type: "object",
      properties: { id: { type: ["string", "null"], format: "uuid" } },
    });

    expect(resource.idProperty).toBe("id");
    expect(resource.idKind).toBe("uuid");
  });

  describe("polymorphic item schemas", () => {
    const variant = (id: Record<string, unknown>, extra: string) => ({
      type: "object",
      properties: { id, [extra]: { type: "string" } },
    });

    it("reads a string id every anyOf branch declares", () => {
      const resource = detectOne("/sources", "sourceId", {
        anyOf: [
          variant({ type: "string" }, "last4"),
          variant({ type: "string" }, "brand"),
        ],
      });

      expect(resource.idProperty).toBe("id");
      expect(resource.idKind).toBe("string");
    });

    it("reads a uuid id every oneOf branch declares, behind a nullable wrapper", () => {
      const resource = detectOne("/pets", "petId", {
        anyOf: [
          { type: "null" },
          {
            oneOf: [
              variant({ type: "string", format: "uuid" }, "meow"),
              variant({ type: "string", format: "uuid" }, "bark"),
            ],
          },
        ],
      });

      expect(resource.idParam).toBe("petId");
      expect(resource.idProperty).toBe("id");
      expect(resource.idKind).toBe("uuid");
    });

    it("settles for the string kind when only some branches say uuid", () => {
      const resource = detectOne("/sources", "sourceId", {
        oneOf: [
          variant({ type: "string", format: "uuid" }, "last4"),
          variant({ type: "string" }, "brand"),
        ],
      });

      expect(resource.idKind).toBe("string");
    });

    it("mints integers when any branch declares a non-string id", () => {
      const resource = detectOne("/sources", "sourceId", {
        oneOf: [
          variant({ type: "string" }, "last4"),
          variant({ type: "integer" }, "brand"),
        ],
      });

      expect(resource.idProperty).toBe("id");
      expect(resource.idKind).toBe("integer");
    });

    it("keeps the path parameter when a branch declares it", () => {
      const resource = detectOne("/sources", "sourceId", {
        oneOf: [
          variant({ type: "string" }, "sourceId"),
          variant({ type: "string" }, "brand"),
        ],
      });

      expect(resource.idProperty).toBe("sourceId");
      expect(resource.idKind).toBe("string");
    });
  });

  it("stores a polymorphic create under a minted string id", async () => {
    const json = (schema: object) => ({ "application/json": { schema } });
    const source = {
      anyOf: [
        {
          type: "object",
          properties: { id: { type: "string" }, last4: { type: "string" } },
        },
        {
          type: "object",
          properties: { id: { type: "string" }, brand: { type: "string" } },
        },
      ],
    };
    const mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "Sources", version: "1.0.0" },
          paths: {
            "/sources": {
              post: {
                requestBody: { content: json(source) },
                responses: {
                  "201": { description: "ok", content: json(source) },
                },
              },
            },
            "/sources/{sourceId}": {
              parameters: [
                {
                  name: "sourceId",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              get: {
                responses: {
                  "200": { description: "ok", content: json(source) },
                },
              },
            },
          },
        },
        validateResponses: true,
      }),
    );

    const created = await mock.handle("POST", "/sources", {
      body: { last4: "4242" },
    });
    expect(created.status).toBe(201);
    const id = (created.body as Record<string, unknown>).id;
    expect(typeof id).toBe("string");
    const read = await mock.handle("GET", `/sources/${id}`);
    expect(read.body).toMatchObject({ id, last4: "4242" });
  });
});
