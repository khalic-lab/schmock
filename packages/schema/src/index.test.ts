import { describe, expect, it } from "vitest";
import { generateFromSchema, schemaPlugin } from "./index";

describe("schema generation", () => {
  describe("generateFromSchema", () => {
    it("generates data from simple object schema", () => {
      const schema = {
        type: "object" as const,
        properties: {
          id: { type: "number" as const },
          name: { type: "string" as const },
        },
      };

      const result = generateFromSchema({ schema });

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(typeof result.id).toBe("number");
      expect(typeof result.name).toBe("string");
    });

    it("generates array with specified count", () => {
      const schema = {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            id: { type: "number" as const },
          },
        },
      };

      const result = generateFromSchema({ schema, count: 5 });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(5);
    });

    it("applies smart field mapping", () => {
      const schema = {
        type: "object" as const,
        properties: {
          email: { type: "string" as const },
          firstName: { type: "string" as const },
          createdAt: { type: "string" as const },
        },
      };

      const result = generateFromSchema({ schema });

      expect(result.email).toMatch(/@/);
      expect(result.firstName).toBeTruthy();
      expect(result.createdAt).toBeTruthy();
    });

    it("applies overrides with template processing", () => {
      const schema = {
        type: "object" as const,
        properties: {
          id: { type: "number" as const },
          userId: { type: "string" as const },
        },
      };

      const result = generateFromSchema({
        schema,
        overrides: { userId: "{{params.id}}" },
        params: { id: "123" },
      });

      expect(result.userId).toBe(123); // Template converts to number
    });

    it("validates schema and throws on invalid input", () => {
      expect(() => generateFromSchema({ schema: {} as any })).toThrow(
        "Schema cannot be empty",
      );
      expect(() => generateFromSchema({ schema: null as any })).toThrow(
        "Schema must be a valid JSON Schema object",
      );
    });
  });

  describe("schemaPlugin", () => {
    it("returns plugin with correct metadata", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            id: { type: "number" },
          },
        },
      });

      expect(plugin.name).toBe("schema");
      expect(plugin.version).toBe("0.1.0");
      expect(plugin.process).toBeTypeOf("function");
    });

    it("generates response from schema configuration", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
          },
        },
      });

      const mockContext = {
        method: "GET",
        path: "/test",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      const result = plugin.process(mockContext);

      expect(result.response).toHaveProperty("id");
      expect(result.response).toHaveProperty("name");
      expect(typeof result.response.id).toBe("number");
      expect(typeof result.response.name).toBe("string");
    });

    it("passes through existing response", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            id: { type: "number" },
          },
        },
      });

      const mockContext = {
        method: "GET",
        path: "/test",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      const existingResponse = { custom: "data" };
      const result = plugin.process(mockContext, existingResponse);

      expect(result.response).toEqual(existingResponse);
    });

    it("applies overrides with context data", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            id: { type: "number" },
            userId: { type: "string" },
          },
        },
        overrides: {
          userId: "{{params.id}}",
        },
      });

      const mockContext = {
        method: "GET",
        path: "/test",
        params: { id: "123" },
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      const result = plugin.process(mockContext);

      expect(result.response.userId).toBe(123); // Template converts to number
    });

    it("validates schema at plugin creation time", () => {
      // Invalid schema: empty object
      expect(() => {
        schemaPlugin({
          schema: {} as any,
        });
      }).toThrow("Schema cannot be empty");

      // Invalid schema: invalid type
      expect(() => {
        schemaPlugin({
          schema: {
            type: "invalid" as any,
          },
        });
      }).toThrow('Invalid schema type: "invalid"');

      // Invalid schema: array without items
      expect(() => {
        schemaPlugin({
          schema: {
            type: "array",
            items: null as any,
          },
        });
      }).toThrow("Array schema must have valid items definition");
    });
  });
});
