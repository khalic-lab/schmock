import { describe, expect, it } from "vitest";
import { detectCrudResources } from "./crud-detector";
import type { ParsedPath } from "./parser";

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
});
