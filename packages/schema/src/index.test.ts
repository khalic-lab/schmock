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
      expect(() => generateFromSchema({ schema: {} as any })).toThrow("Schema cannot be empty");
      expect(() => generateFromSchema({ schema: null as any })).toThrow("Schema must be a valid JSON Schema object");
    });
  });

  describe("schemaPlugin", () => {
    it("returns plugin with correct metadata", () => {
      const plugin = schemaPlugin();
      
      expect(plugin.name).toBe("schema");
      expect(plugin.version).toBe("0.1.0");
      expect(plugin.generate).toBeTypeOf("function");
    });
  });
});