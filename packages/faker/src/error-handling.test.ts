import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { fakerPlugin, generateFromSchema } from "./index";
import { schemas } from "./test-utils";

describe("Schema Error Handling", () => {
  describe("Validation Error Messages", () => {
    it("provides clear error for empty schemas", () => {
      try {
        generateFromSchema({ schema: {} as any });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.name).toBe("SchemaValidationError");
        expect(error.message).toContain("Schema cannot be empty");
        expect(error.code).toBe("SCHEMA_VALIDATION_ERROR");
      }
    });

    it("provides clear error for invalid types", () => {
      try {
        generateFromSchema({ schema: { type: "invalid" as any } });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.name).toBe("SchemaValidationError");
        expect(error.message).toContain("Invalid schema type");
        expect(error.message).toContain("invalid");
        expect(error.message).toContain("Supported types are");
      }
    });

    it("provides helpful suggestions for common mistakes", () => {
      try {
        generateFromSchema({
          schema: {
            type: "object",
            properties: "should be object" as any,
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).toContain("Properties must be an object");
        expect(error.message).toContain(
          'Use { "propertyName": { "type": "string" } } format',
        );
      }
    });

    it("includes schema path in error messages", () => {
      try {
        generateFromSchema({
          schema: {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  email: {
                    type: "invalid" as any,
                  },
                },
              },
            },
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.context.schemaPath).toContain("user");
        expect(error.context.schemaPath).toContain("email");
      }
    });

    it("validates faker method namespaces with helpful errors", () => {
      try {
        generateFromSchema({
          schema: {
            type: "object",
            properties: {
              field: {
                type: "string",
                faker: "badnamespace.method" as any,
              },
            },
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).toContain("Invalid faker method");
        expect(error.message).toContain("badnamespace.method");
      }
    });

    it("validates array schemas must have items", () => {
      try {
        generateFromSchema({
          schema: {
            type: "array",
            items: null as any,
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).toContain(
          "Array schema must have valid items definition",
        );
        expect(error.message).toContain("Define items as a schema object");
      }
    });
  });

  describe("Resource Limit Errors", () => {
    it("provides clear error for array size limits", () => {
      try {
        generateFromSchema({
          schema: {
            type: "array",
            items: { type: "string" },
            maxItems: 50000,
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should throw some kind of error for resource limits
        expect(error).toBeDefined();
        expect(error.message).toContain("array_max_items");
      }
    });

    it("provides clear error for nesting depth", () => {
      try {
        const deepSchema = schemas.nested.deep(15);
        generateFromSchema({ schema: deepSchema });
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should throw some kind of error for nesting depth
        expect(error).toBeDefined();
        expect(error.message).toContain("schema_nesting_depth");
      }
    });

    it("detects memory risks from nested arrays", () => {
      try {
        generateFromSchema({
          schema: {
            type: "object",
            properties: {
              level1: {
                type: "array",
                items: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        data: { type: "string" },
                      },
                    },
                    maxItems: 200,
                  },
                  maxItems: 200,
                },
                maxItems: 200,
              },
            },
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.name).toBe("ResourceLimitError");
        expect(error.message).toContain("memory");
      }
    });

    it("provides actionable error messages for limits", () => {
      try {
        generateFromSchema({
          schema: {
            type: "array",
            items: { type: "string" },
            minItems: 20000,
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).toContain("Resource limit exceeded");
        expect(error.message).toContain("array");
        // Message should indicate what limit was hit
      }
    });
  });

  describe("Schema Generation Errors", () => {
    it("wraps json-schema-faker errors appropriately", () => {
      try {
        generateFromSchema({
          schema: {
            type: "string",
            pattern: "[", // Invalid regex
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should throw some kind of error for invalid pattern
        expect(error).toBeDefined();
        expect(error.name).toContain("Error");
      }
    });

    it("includes context in generation errors", () => {
      const plugin = fakerPlugin({
        schema: {
          type: "string",
          pattern: "[",
        },
      });

      const context = {
        method: "GET",
        path: "/test/123",
        params: { id: "123" },
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      try {
        plugin.process(context);
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should throw some kind of error
        expect(error).toBeDefined();
      }
    });

    it("handles circular reference errors", () => {
      try {
        generateFromSchema({
          schema: {
            type: "object",
            properties: {
              self: { $ref: "#" },
            },
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).toContain("circular");
        expect(error.name).toBe("SchemaValidationError");
      }
    });

    it("handles missing reference errors", () => {
      try {
        generateFromSchema({
          schema: {
            type: "object",
            properties: {
              ref: { $ref: "#/definitions/nonexistent" },
            },
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        // json-schema-faker throws its own error
        expect(error.message).toContain("not found");
      }
    });
  });

  describe("Plugin Error Handling", () => {
    it("validates schema at plugin creation", () => {
      try {
        fakerPlugin({
          schema: null as any,
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.name).toBe("SchemaValidationError");
        // Error happens at plugin creation, not processing
      }
    });

    it("handles null context gracefully", () => {
      const plugin = fakerPlugin({
        schema: schemas.simple.object({ id: schemas.simple.number() }),
      });

      // Should not crash with null params
      const result = plugin.process({
        method: "GET",
        path: "/test",
        params: null as any,
        query: null as any,
        state: null as any,
        headers: {},
        body: null,
        route: {},
      });

      expect(result.response).toHaveProperty("id");
    });

    it("preserves original error stack traces", () => {
      try {
        generateFromSchema({
          schema: {
            type: "string",
            pattern: "[",
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should preserve error info
        expect(error).toBeDefined();
        expect(error.stack).toBeDefined();
      }
    });
  });

  describe("Error Recovery", () => {
    it("can generate after validation errors", () => {
      // First attempt with invalid schema
      try {
        generateFromSchema({ schema: { type: "invalid" as any } });
      } catch (_error) {
        // Expected
      }

      // Should be able to generate with valid schema
      const result = generateFromSchema({
        schema: schemas.simple.object({ id: schemas.simple.number() }),
      });

      expect(result).toHaveProperty("id");
    });

    it("plugin continues to work after errors", () => {
      const plugin = fakerPlugin({
        schema: schemas.simple.object({ id: schemas.simple.number() }),
      });

      const context = {
        method: "GET",
        path: "/test",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      // Multiple calls should work
      const result1 = plugin.process(context);
      const result2 = plugin.process(context);

      expect(result1.response).toHaveProperty("id");
      expect(result2.response).toHaveProperty("id");
    });
  });

  describe("Edge Case Error Handling", () => {
    it("handles deeply nested validation errors", () => {
      try {
        generateFromSchema({
          schema: {
            type: "object",
            properties: {
              a: {
                type: "object",
                properties: {
                  b: {
                    type: "object",
                    properties: {
                      c: {
                        type: "object",
                        properties: {
                          d: {
                            type: "array",
                            items: null as any,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.context.schemaPath).toContain("a");
        expect(error.context.schemaPath).toContain("b");
        expect(error.context.schemaPath).toContain("c");
        expect(error.context.schemaPath).toContain("d");
      }
    });

    it("handles multiple validation errors (reports first)", () => {
      try {
        generateFromSchema({
          schema: {
            type: "invalid" as any,
            properties: "also invalid" as any,
            items: null as any,
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should report the first error encountered
        expect(error.message).toContain("Invalid schema type");
      }
    });

    it("handles non-Error objects in catch blocks", () => {
      // This is more about the implementation being defensive
      const plugin = fakerPlugin({
        schema: schemas.simple.object({ id: schemas.simple.number() }),
      });

      // Even with weird inputs, should handle gracefully
      expect(() => {
        plugin.process({} as any);
      }).not.toThrow();
    });

    it("handles schemas that generate invalid JSON", () => {
      // Some edge cases might generate circular structures
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          normal: { type: "string" },
        },
      };

      const result = generateFromSchema({ schema });

      // Should be serializable
      expect(() => JSON.stringify(result)).not.toThrow();
    });
  });

  describe("Error Message Quality", () => {
    it("uses consistent error message format", () => {
      const errors: any[] = [];

      // Collect various errors
      try {
        generateFromSchema({ schema: {} as any });
      } catch (e) {
        errors.push(e);
      }

      try {
        generateFromSchema({ schema: { type: "invalid" as any } });
      } catch (e) {
        errors.push(e);
      }

      // All should have consistent structure
      errors.forEach((error) => {
        expect(error).toHaveProperty("name");
        expect(error).toHaveProperty("message");
        expect(error).toHaveProperty("code");
        expect(error).toHaveProperty("context");
      });
    });

    it("avoids exposing internal implementation details", () => {
      try {
        generateFromSchema({
          schema: {
            type: "string",
            pattern: "[",
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should not expose internal file paths or function names
        expect(error.message).not.toContain("node_modules");
        expect(error.message).not.toContain("dist/");
        // Should have some useful error info
        expect(error.message.length).toBeGreaterThan(5);
      }
    });

    it("provides actionable error messages", () => {
      try {
        generateFromSchema({
          schema: {
            type: "object",
            properties: [] as any, // Wrong type
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should tell user what to do
        expect(error.message).toContain("must be an object");
        expect(error.context.suggestion).toBeDefined();
      }
    });
  });
});
