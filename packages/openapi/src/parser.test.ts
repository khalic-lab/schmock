import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSpec } from "./parser";

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");

describe("parseSpec", () => {
  describe("Swagger 2.0", () => {
    it("parses Swagger 2.0 Petstore spec", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);

      expect(spec.title).toBe("Petstore");
      expect(spec.version).toBe("1.0.0");
      expect(spec.basePath).toBe("/api");
      expect(spec.paths.length).toBeGreaterThan(0);
    });

    it("extracts path parameters from Swagger 2.0", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const getPet = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets/:petId",
      );

      expect(getPet).toBeDefined();
      expect(getPet?.parameters).toContainEqual(
        expect.objectContaining({
          name: "petId",
          in: "path",
          required: true,
        }),
      );
    });

    it("extracts query parameters", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const listPets = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets",
      );

      expect(listPets).toBeDefined();
      expect(listPets?.parameters).toContainEqual(
        expect.objectContaining({
          name: "limit",
          in: "query",
        }),
      );
    });

    it("extracts request body from Swagger 2.0 body parameter", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const createPet = spec.paths.find(
        (p) => p.method === "POST" && p.path === "/pets",
      );

      expect(createPet).toBeDefined();
      expect(createPet?.requestBody).toBeDefined();
      expect(createPet?.requestBody?.type).toBe("object");
    });

    it("extracts response schemas with multiple status codes", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const listPets = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets",
      );

      expect(listPets).toBeDefined();
      expect(listPets?.responses.has(200)).toBe(true);
      expect(listPets?.responses.get(200)?.schema?.type).toBe("array");
    });

    it("converts {param} to :param in paths", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const getPet = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets/:petId",
      );
      expect(getPet).toBeDefined();
    });
  });

  describe("OpenAPI 3.0", () => {
    it("parses OpenAPI 3.0 spec", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);

      expect(spec.title).toBe("Petstore");
      expect(spec.version).toBe("2.0.0");
      expect(spec.basePath).toBe("/v2");
    });

    it("extracts request body from OpenAPI 3.x requestBody", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      const createPet = spec.paths.find(
        (p) => p.method === "POST" && p.path === "/pets",
      );

      expect(createPet).toBeDefined();
      expect(createPet?.requestBody).toBeDefined();
    });

    it("resolves $ref pointers via dereference", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      const getPet = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets/:petId",
      );

      // Should be fully resolved, no $ref
      expect(getPet?.responses.get(200)?.schema).toBeDefined();
      expect(getPet?.responses.get(200)?.schema).not.toHaveProperty("$ref");
    });

    it("merges path-level and operation-level parameters", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      const getPet = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets/:petId",
      );

      // petId is defined at path level, should be merged into operation
      expect(getPet?.parameters).toContainEqual(
        expect.objectContaining({
          name: "petId",
          in: "path",
        }),
      );
    });

    it("extracts tags", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      const listPets = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets",
      );
      expect(listPets?.tags).toContain("pets");
    });
  });

  describe("OpenAPI 3.1", () => {
    it("parses OpenAPI 3.1 spec", async () => {
      const spec = await parseSpec(`${fixturesDir}/openapi31.json`);

      expect(spec.title).toBe("Simple API");
      expect(spec.version).toBe("3.1.0");
    });
  });

  describe("inline spec objects", () => {
    it("accepts inline spec object", async () => {
      const spec = await parseSpec({
        openapi: "3.0.3",
        info: { title: "Inline", version: "1.0.0" },
        paths: {
          "/hello": {
            get: {
              responses: {
                "200": {
                  description: "Hello",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { msg: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      expect(spec.title).toBe("Inline");
      expect(spec.paths).toHaveLength(1);
      expect(spec.paths[0].method).toBe("GET");
      expect(spec.paths[0].path).toBe("/hello");
    });
  });

  describe("error handling", () => {
    it("throws on invalid spec", async () => {
      await expect(parseSpec({ invalid: true })).rejects.toThrow();
    });
  });
});
