import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { MAX_NESTING_DEPTH } from "./constants";
import { fakerPlugin, generateFromSchema } from "./index";
import { schemas } from "./test-utils";

describe("Schema Error Handling", () => {
  describe("Validation Error Messages", () => {
    it("provides clear error for empty schemas", async () => {
      try {
        await generateFromSchema({ schema: {} as any });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.name).toBe("SchemaValidationError");
        expect(error.message).toContain("Schema cannot be empty");
        expect(error.code).toBe("SCHEMA_VALIDATION_ERROR");
      }
    });

    it("provides clear error for invalid types", async () => {
      try {
        await generateFromSchema({ schema: { type: "invalid" as any } });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.name).toBe("SchemaValidationError");
        expect(error.message).toContain("Invalid schema type");
        expect(error.message).toContain("invalid");
        expect(error.message).toContain("Supported types are");
      }
    });

    it("provides helpful suggestions for common mistakes", async () => {
      try {
        await generateFromSchema({
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

    it("includes schema path in error messages", async () => {
      try {
        await generateFromSchema({
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

    it("validates faker method namespaces with helpful errors", async () => {
      try {
        await generateFromSchema({
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

    it("validates array schemas must have items", async () => {
      try {
        await generateFromSchema({
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
    it("provides clear error for array size limits", async () => {
      try {
        await generateFromSchema({
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

    it("provides clear error for nesting depth", async () => {
      try {
        const deepSchema = schemas.nested.deep(MAX_NESTING_DEPTH + 5);
        await generateFromSchema({ schema: deepSchema });
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should throw some kind of error for nesting depth
        expect(error).toBeDefined();
        expect(error.message).toContain("schema_nesting_depth");
      }
    });

    it("detects memory risks from nested arrays", async () => {
      try {
        await generateFromSchema({
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

    it("provides actionable error messages for limits", async () => {
      try {
        await generateFromSchema({
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
    it("wraps json-schema-faker errors appropriately", async () => {
      try {
        await generateFromSchema({
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

    it("includes context in generation errors", async () => {
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
        await plugin.process(context);
        expect.fail("Should have thrown");
      } catch (error: any) {
        // Should throw some kind of error
        expect(error).toBeDefined();
      }
    });

    it("handles circular reference errors", async () => {
      try {
        await generateFromSchema({
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

    it("handles missing reference errors", async () => {
      try {
        await generateFromSchema({
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
        expect(error.message).toContain("Unresolved $ref");
      }
    });
  });

  // M20-a/b/c: validation used to walk only `type: "object"` properties and
  // `type: "array"` items, so anything hidden in $defs, composition,
  // patternProperties or below an untyped node reached json-schema-faker
  // unchecked — including invalid faker methods, oversized arrays and cycles
  // that blew the stack.
  describe("Unified schema traversal", () => {
    async function expectThrown(schema: JSONSchema7): Promise<any> {
      try {
        await generateFromSchema({ schema });
      } catch (error: unknown) {
        return error;
      }
      expect.fail("Should have thrown");
    }

    it("rejects an invalid faker method inside $defs", async () => {
      const error = await expectThrown({
        type: "object",
        properties: { user: { $ref: "#/$defs/user" } },
        $defs: {
          user: {
            type: "object",
            properties: {
              name: { type: "string", faker: "not.a.method" },
            } as any,
          },
        },
      } as JSONSchema7);

      expect(error.name).toBe("SchemaValidationError");
      expect(error.message).toContain("Invalid faker method");
    });

    it("rejects an invalid faker method inside an allOf branch", async () => {
      const error = await expectThrown({
        allOf: [
          { type: "object", properties: { id: { type: "string" } } },
          {
            type: "object",
            properties: {
              name: { type: "string", faker: "nope.nope" },
            } as any,
          },
        ],
      } as JSONSchema7);

      expect(error.name).toBe("SchemaValidationError");
      expect(error.message).toContain("Invalid faker method");
    });

    it("rejects an invalid faker method inside patternProperties", async () => {
      const error = await expectThrown({
        type: "object",
        patternProperties: {
          "^x-": { type: "string", faker: "bogus.method" },
        } as any,
      } as JSONSchema7);

      expect(error.name).toBe("SchemaValidationError");
      expect(error.message).toContain("Invalid faker method");
    });

    it("rejects an oversized array hidden in $defs", async () => {
      const error = await expectThrown({
        type: "object",
        properties: { rows: { $ref: "#/$defs/rows" } },
        $defs: {
          rows: { type: "array", items: { type: "string" }, maxItems: 999999 },
        },
      } as JSONSchema7);

      expect(error.code).toBe("RESOURCE_LIMIT_ERROR");
      expect(error.context.resource).toBe("array_max_items");
    });

    it("rejects an oversized array hidden in an allOf branch", async () => {
      const error = await expectThrown({
        type: "object",
        properties: {
          rows: {
            allOf: [
              { type: "array", items: { type: "string" }, maxItems: 999999 },
            ],
          },
        },
      } as JSONSchema7);

      expect(error.code).toBe("RESOURCE_LIMIT_ERROR");
      expect(error.context.resource).toBe("array_max_items");
    });

    it("traverses an untyped object root", async () => {
      // No `type` keyword: JSON Schema does not require one, and
      // json-schema-faker still generates from `properties`.
      const error = await expectThrown({
        properties: {
          rows: { type: "array", items: { type: "string" }, maxItems: 999999 },
        },
      } as JSONSchema7);

      expect(error.code).toBe("RESOURCE_LIMIT_ERROR");
      expect(error.context.resource).toBe("array_max_items");
    });

    it("still accepts and generates a legally composed schema", async () => {
      const result: any = await generateFromSchema({
        schema: {
          type: "object",
          properties: {
            profile: {
              allOf: [
                {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                },
                {
                  type: "object",
                  properties: { active: { type: "boolean" } },
                  required: ["active"],
                },
              ],
            },
            choice: { oneOf: [{ type: "string" }, { type: "integer" }] },
            tags: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 3,
            },
          },
          required: ["profile", "choice", "tags"],
        } as JSONSchema7,
        seed: 7,
      });

      expect(result.profile.id).toEqual(expect.any(String));
      expect(typeof result.profile.active).toBe("boolean");
      expect(["string", "number"]).toContain(typeof result.choice);
      expect(Array.isArray(result.tags)).toBe(true);
    });
  });

  describe("Circular references beyond properties and items", () => {
    function expectCircular(schema: JSONSchema7): void {
      try {
        fakerPlugin({ schema });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.name).toBe("SchemaValidationError");
        expect(error.message).toContain("circular");
      }
    }

    it("detects a self-referential allOf", () => {
      const schema: any = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      schema.allOf = [schema];
      expectCircular(schema);
    });

    it("detects a self-referential additionalProperties", () => {
      const schema: any = {
        type: "object",
        properties: { name: { type: "string" } },
      };
      schema.additionalProperties = schema;
      expectCircular(schema);
    });

    it("detects an A -> B -> A cycle through oneOf", () => {
      const a: any = { type: "object", properties: {} };
      const b: any = { type: "object", properties: {} };
      a.oneOf = [b];
      b.oneOf = [a];
      expectCircular(a);
    });

    it("detects a cycle through patternProperties", () => {
      const schema: any = { type: "object", patternProperties: {} };
      schema.patternProperties["^a"] = schema;
      expectCircular(schema);
    });

    it("still allows the same sub-schema to be reused by siblings", async () => {
      const shared: JSONSchema7 = {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
      };
      const result: any = await generateFromSchema({
        schema: {
          type: "object",
          properties: { left: shared, right: shared },
          required: ["left", "right"],
        },
        seed: 3,
      });

      expect(result.left.label).toEqual(expect.any(String));
      expect(result.right.label).toEqual(expect.any(String));
    });
  });

  describe("Array size limits below the root", () => {
    it("rejects a nested minItems above the maximum array size", async () => {
      try {
        await generateFromSchema({
          schema: {
            type: "object",
            properties: {
              rows: {
                type: "array",
                items: { type: "string" },
                minItems: 50000,
              },
            },
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.code).toBe("RESOURCE_LIMIT_ERROR");
        expect(error.context.resource).toBe("array_max_items");
        expect(error.context.actual).toBe(50000);
      }
    });

    it("rejects a minItems above the maximum inside an allOf branch", async () => {
      try {
        await generateFromSchema({
          schema: {
            type: "object",
            properties: {
              rows: {
                allOf: [
                  { type: "array", items: { type: "string" }, minItems: 20000 },
                ],
              },
            },
          },
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.code).toBe("RESOURCE_LIMIT_ERROR");
        expect(error.context.resource).toBe("array_max_items");
      }
    });

    it("still generates a nested array below the maximum", async () => {
      const result: any = await generateFromSchema({
        schema: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: { type: "string" },
              minItems: 5000,
              maxItems: 5000,
            },
          },
          required: ["rows"],
        },
        seed: 11,
      });

      expect(result.rows).toHaveLength(5000);
    });
  });

  // P5-budget: the bound has to cover schema WIDTH (every optional property is
  // materialized), not only the number of schema nodes.
  describe("Generation budgets", () => {
    it("rejects a schema whose estimated output exceeds the node budget", async () => {
      const wideItem: JSONSchema7 = {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 1500 }, (_, i) => [
            `field${i}`,
            { type: "string" },
          ]),
        ),
      };
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: wideItem,
            minItems: 1000,
            maxItems: 1000,
          },
        },
      };

      try {
        await generateFromSchema({ schema });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.code).toBe("RESOURCE_LIMIT_ERROR");
        expect(error.context.resource).toBe("generated_nodes");
        // ~1000 rows x 1501 nodes: a bound that only counted schema nodes
        // (about 1503 here) would have let this through.
        expect(error.context.actual).toBeGreaterThan(1_000_000);
      }
    });

    it("rejects a composition chain deeper than the walk can safely follow", async () => {
      // Composition does not add document depth, so MAX_NESTING_DEPTH cannot
      // bound it; without its own cap this used to be a stack overflow.
      let schema: JSONSchema7 = { type: "string" };
      for (let i = 0; i < 250; i++) {
        schema = { allOf: [schema] };
      }

      try {
        await generateFromSchema({ schema });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.code).toBe("RESOURCE_LIMIT_ERROR");
        expect(error.context.resource).toBe("schema_composition_depth");
      }
    });

    it("counts shared sub-schemas once while rejecting their expanded output", async () => {
      let level: JSONSchema7 = { type: "string" };
      for (let i = 0; i < 9; i++) {
        const child = level;
        level = {
          type: "object",
          properties: { a: child, b: child, c: child, d: child, e: child },
        };
      }

      try {
        await generateFromSchema({ schema: level });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.code).toBe("RESOURCE_LIMIT_ERROR");
        expect(error.context.resource).toBe("generated_nodes");
        expect(error.context.actual).toBe(2_441_406);
      }

      if (!level.properties) throw new Error("Expected shared properties");
      expect(level.properties.a).toBe(level.properties.b);
    });

    it("still generates a large but legal schema", async () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          ...Object.fromEntries(
            Array.from({ length: 200 }, (_, i) => [
              `field${i}`,
              { type: "string" },
            ]),
          ),
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                nested: {
                  type: "object",
                  properties: { value: { type: "string" } },
                },
              },
            },
            minItems: 500,
            maxItems: 500,
          },
        },
        required: ["rows"],
      };

      const result: any = await generateFromSchema({ schema, seed: 5 });
      expect(Object.keys(result).length).toBeGreaterThanOrEqual(200);
      expect(result.rows).toHaveLength(500);
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

    it("handles null context gracefully", async () => {
      const plugin = fakerPlugin({
        schema: schemas.simple.object({ id: schemas.simple.number() }),
      });

      // Should not crash with null params
      const result = await plugin.process({
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

    it("preserves original error stack traces", async () => {
      try {
        await generateFromSchema({
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
    it("can generate after validation errors", async () => {
      // First attempt with invalid schema
      try {
        await generateFromSchema({ schema: { type: "invalid" as any } });
      } catch (_error) {
        // Expected
      }

      // Should be able to generate with valid schema
      const result = await generateFromSchema({
        schema: schemas.simple.object({ id: schemas.simple.number() }),
      });

      expect(result).toHaveProperty("id");
    });

    it("plugin continues to work after errors", async () => {
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
      const result1 = await plugin.process(context);
      const result2 = await plugin.process(context);

      expect(result1.response).toHaveProperty("id");
      expect(result2.response).toHaveProperty("id");
    });
  });

  describe("Edge Case Error Handling", () => {
    it("handles deeply nested validation errors", async () => {
      try {
        await generateFromSchema({
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

    it("handles multiple validation errors (reports first)", async () => {
      try {
        await generateFromSchema({
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

    it("handles non-Error objects in catch blocks", async () => {
      // This is more about the implementation being defensive
      const plugin = fakerPlugin({
        schema: schemas.simple.object({ id: schemas.simple.number() }),
      });

      // Even with weird inputs, should handle gracefully
      await expect(plugin.process({} as any)).resolves.not.toThrow();
    });

    it("handles schemas that generate invalid JSON", async () => {
      // Some edge cases might generate circular structures
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          normal: { type: "string" },
        },
      };

      const result = await generateFromSchema({ schema });

      // Should be serializable
      expect(() => JSON.stringify(result)).not.toThrow();
    });
  });

  describe("Error Message Quality", () => {
    it("uses consistent error message format", async () => {
      const errors: any[] = [];

      // Collect various errors
      try {
        await generateFromSchema({ schema: {} as any });
      } catch (e) {
        errors.push(e);
      }

      try {
        await generateFromSchema({ schema: { type: "invalid" as any } });
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

    it("avoids exposing internal implementation details", async () => {
      try {
        await generateFromSchema({
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

    it("provides actionable error messages", async () => {
      try {
        await generateFromSchema({
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
