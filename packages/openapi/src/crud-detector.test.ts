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

  it("does not duplicate update operation for PUT and PATCH", () => {
    const paths: ParsedPath[] = [
      makePath("GET", "/pets"),
      makePath("PUT", "/pets/:petId"),
      makePath("PATCH", "/pets/:petId"),
    ];

    const result = detectCrudResources(paths);
    const updateCount = result.resources[0].operations.filter(
      (op) => op === "update",
    ).length;
    expect(updateCount).toBe(1);
  });
});
