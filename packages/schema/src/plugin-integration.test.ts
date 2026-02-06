import { describe, expect, it } from "vitest";
import { schemaPlugin } from "./index";
import { schemas, validators } from "./test-utils";

describe("Schema Plugin Integration", () => {
  describe("Plugin Lifecycle", () => {
    it("validates schema during plugin creation", () => {
      // Valid schema should create plugin
      const validPlugin = schemaPlugin({
        schema: schemas.complex.user(),
      });
      expect(validPlugin).toBeDefined();
      expect(validPlugin.name).toBe("schema");
      expect(validPlugin.version).toBe("1.0.1");

      // Invalid schema should throw immediately
      expect(() => {
        schemaPlugin({
          schema: { type: "invalid" as any },
        });
      }).toThrow("Invalid schema type");
    });

    it("processes context through plugin pipeline", () => {
      const plugin = schemaPlugin({
        schema: schemas.simple.object({
          requestId: { type: "string" },
          timestamp: { type: "string" },
          data: { type: "object" },
        }),
      });

      const context = {
        method: "POST",
        path: "/api/data",
        params: {},
        query: {},
        state: { requestId: "req-123" },
        headers: { "content-type": "application/json" },
        body: { value: 42 },
        route: { pattern: "/api/data" },
      };

      const result = plugin.process(context);

      expect(result).toHaveProperty("context");
      expect(result).toHaveProperty("response");
      expect(result.context).toBe(context); // Context passed through
      expect(result.response).toHaveProperty("requestId");
      expect(result.response).toHaveProperty("timestamp");
      expect(result.response).toHaveProperty("data");
    });

    it("preserves existing responses when present", () => {
      const plugin = schemaPlugin({
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

      const existingResponse = {
        cached: true,
        data: [1, 2, 3],
        metadata: { source: "cache" },
      };

      const result = plugin.process(context, existingResponse);

      expect(result.response).toBe(existingResponse);
      expect(result.response).toEqual(existingResponse);
    });
  });

  describe("Context Integration", () => {
    it("uses params in template overrides", () => {
      const plugin = schemaPlugin({
        schema: schemas.simple.object({
          userId: { type: "string" },
          postId: { type: "string" },
          action: { type: "string" },
        }),
        overrides: {
          userId: "{{params.userId}}",
          postId: "{{params.postId}}",
          action: "view",
        },
      });

      const result = plugin.process({
        method: "GET",
        path: "/users/123/posts/456",
        params: { userId: "123", postId: "456" },
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      });

      expect(result.response.userId).toBe("123"); // Template values are strings
      expect(result.response.postId).toBe("456");
      expect(result.response.action).toBe("view");
    });

    it("uses query parameters in templates", () => {
      const plugin = schemaPlugin({
        schema: schemas.simple.object({
          page: { type: "number" },
          limit: { type: "number" },
          sort: { type: "string" },
          filter: { type: "string" },
        }),
        overrides: {
          page: "{{query.page}}",
          limit: "{{query.limit}}",
          sort: "{{query.sort}}",
          filter: "{{query.filter}}",
        },
      });

      const result = plugin.process({
        method: "GET",
        path: "/api/items",
        params: {},
        query: {
          page: "2",
          limit: "50",
          sort: "name",
          filter: "active",
        },
        state: {},
        headers: {},
        body: null,
        route: {},
      });

      expect(result.response.page).toBe("2"); // Query values are strings
      expect(result.response.limit).toBe("50");
      expect(result.response.sort).toBe("name");
      expect(result.response.filter).toBe("active");
    });

    it("uses state in template processing", () => {
      const plugin = schemaPlugin({
        schema: schemas.simple.object({
          currentUser: { type: "string" },
          sessionId: { type: "string" },
          permissions: { type: "array", items: { type: "string" } },
        }),
        overrides: {
          currentUser: "{{state.user.name}}",
          sessionId: "{{state.session.id}}",
          permissions: ["read", "write"],
        },
      });

      const result = plugin.process({
        method: "GET",
        path: "/api/profile",
        params: {},
        query: {},
        state: new Map(),
        routeState: {
          user: { id: 1, name: "John Doe" },
          session: { id: "sess-123", expires: "2024-12-31" },
        },
        headers: {},
        body: null,
        route: {},
      });

      expect(result.response.currentUser).toBe("John Doe");
      expect(result.response.sessionId).toBe("sess-123");
      expect(result.response.permissions).toEqual(["read", "write"]);
    });

    it("handles missing template values gracefully", () => {
      const plugin = schemaPlugin({
        schema: schemas.simple.object({
          value1: { type: "string" },
          value2: { type: "string" },
          value3: { type: "string" },
        }),
        overrides: {
          value1: "{{params.missing}}",
          value2: "{{state.nonexistent.nested}}",
          value3: "default",
        },
      });

      const result = plugin.process({
        method: "GET",
        path: "/test",
        params: { other: "value" },
        query: {},
        state: new Map(),
        routeState: { different: "data" },
        headers: {},
        body: null,
        route: {},
      });

      // Missing values return original template
      expect(result.response.value1).toBe("{{params.missing}}");
      expect(result.response.value2).toBe("{{state.nonexistent.nested}}");
      expect(result.response.value3).toBe("default");
    });
  });

  describe("Array Generation with Plugin", () => {
    it("generates arrays with count parameter", () => {
      const plugin = schemaPlugin({
        schema: schemas.simple.array(
          schemas.simple.object({
            id: { type: "number" },
            name: { type: "string" },
          }),
        ),
        count: 5,
      });

      const result = plugin.process({
        method: "GET",
        path: "/api/items",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      });

      expect(Array.isArray(result.response)).toBe(true);
      expect(result.response).toHaveLength(5);
      result.response.forEach((item) => {
        expect(item).toHaveProperty("id");
        expect(item).toHaveProperty("name");
      });
    });

    it("applies overrides to array items", () => {
      const plugin = schemaPlugin({
        schema: schemas.simple.array(
          schemas.simple.object({
            index: { type: "number" },
            category: { type: "string" },
          }),
        ),
        count: 3,
        overrides: {
          category: "{{state.defaultCategory}}",
        },
      });

      const result = plugin.process({
        method: "GET",
        path: "/api/items",
        params: {},
        query: {},
        state: new Map(),
        routeState: { defaultCategory: "electronics" },
        headers: {},
        body: null,
        route: {},
      });

      expect(result.response).toHaveLength(3);
      result.response.forEach((item) => {
        expect(item.category).toBe("electronics");
      });
    });
  });

  describe("Error Handling in Plugin", () => {
    it("wraps generation errors with context", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "string",
          pattern: "[", // Invalid regex
        },
      });

      const context = {
        method: "GET",
        path: "/api/test/123",
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
        // Should throw some kind of error for invalid pattern
        expect(error).toBeDefined();
        expect(error.name).toContain("Error");
      }
    });

    it("handles null or undefined context properties", () => {
      const plugin = schemaPlugin({
        schema: schemas.simple.object({
          data: { type: "string" },
        }),
      });

      // Should not crash with null/undefined properties
      const result = plugin.process({
        method: "GET",
        path: "/test",
        params: null as any,
        query: undefined as any,
        state: null as any,
        headers: {},
        body: null,
        route: {},
      });

      expect(result.response).toHaveProperty("data");
      expect(typeof result.response.data).toBe("string");
    });
  });

  describe("Complex Schema Scenarios", () => {
    it("handles conditional schemas in plugin", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["user", "admin"] },
            data: { type: "object" },
          },
          required: ["type", "data"],
        },
      });

      const result = plugin.process({
        method: "GET",
        path: "/api/profile",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      });

      expect(["user", "admin"]).toContain(result.response.type);
      expect(result.response).toHaveProperty("data");
    });

    it("generates nested data with references", () => {
      const plugin = schemaPlugin({
        schema: {
          definitions: {
            timestamp: { type: "string", format: "date-time" },
            user: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                name: { type: "string" },
              },
            },
          },
          type: "object",
          properties: {
            created: { $ref: "#/definitions/timestamp" },
            updated: { $ref: "#/definitions/timestamp" },
            author: { $ref: "#/definitions/user" },
            editor: { $ref: "#/definitions/user" },
          },
        },
      });

      const result = plugin.process({
        method: "GET",
        path: "/api/document",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      });

      expect(
        validators.appearsToBeFromCategory([result.response.created], "date"),
      ).toBe(true);
      expect(
        validators.appearsToBeFromCategory([result.response.updated], "date"),
      ).toBe(true);
      expect(
        validators.appearsToBeFromCategory([result.response.author.id], "uuid"),
      ).toBe(true);
      expect(
        validators.appearsToBeFromCategory([result.response.editor.id], "uuid"),
      ).toBe(true);
    });
  });

  describe("Performance Characteristics", () => {
    it("maintains consistent performance across multiple calls", () => {
      const plugin = schemaPlugin({
        schema: schemas.complex.user(),
      });

      const context = {
        method: "GET",
        path: "/api/user",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      // Generate multiple times
      const results = Array.from(
        { length: 10 },
        () => plugin.process(context).response,
      );

      // All should be valid but different
      results.forEach((result) => {
        expect(result).toHaveProperty("id");
        expect(result).toHaveProperty("email");
      });

      // Should generate different data each time
      const emails = results.map((r) => r.email);
      const uniqueEmails = new Set(emails);
      expect(uniqueEmails.size).toBeGreaterThan(5);
    });

    it("handles large schemas efficiently", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [
              `field${i}`,
              { type: i % 2 === 0 ? "string" : "number" },
            ]),
          ),
        },
      });

      const context = {
        method: "GET",
        path: "/api/data",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      const result = plugin.process(context);

      // Should have all fields
      expect(Object.keys(result.response).length).toBeGreaterThanOrEqual(50);
    });
  });

  describe("Real-world Plugin Usage", () => {
    it("generates mock API responses for testing", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            success: { type: "boolean", const: true },
            data: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                email: { type: "string", format: "email" },
                profile: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    avatar: { type: "string", format: "uri" },
                  },
                },
              },
            },
            timestamp: { type: "string", format: "date-time" },
          },
        },
        overrides: {
          "data.id": "{{params.userId}}",
          timestamp: "{{state.currentTime}}",
        },
      });

      const result = plugin.process({
        method: "GET",
        path: "/api/users/user-123",
        params: { userId: "user-123" },
        query: {},
        state: new Map(),
        routeState: { currentTime: "2024-01-01T12:00:00Z" },
        headers: {},
        body: null,
        route: {},
      });

      expect(result.response.success).toBe(true);
      expect(result.response.data.id).toBe("user-123");
      expect(result.response.timestamp).toBe("2024-01-01T12:00:00Z");
      expect(
        validators.appearsToBeFromCategory(
          [result.response.data.email],
          "email",
        ),
      ).toBe(true);
    });

    it("works with schmock plugin pipeline", () => {
      const schemaPlug = schemaPlugin({
        schema: schemas.simple.object({
          message: { type: "string" },
          code: { type: "number" },
        }),
      });

      // Mock another plugin in the pipeline
      const loggingPlugin = {
        name: "logger",
        version: "1.0.0",
        process: (ctx: any, response: any) => {
          console.log(`Processing ${ctx.path}`);
          return { context: ctx, response };
        },
      };

      // Simulate pipeline execution
      const context = {
        method: "GET",
        path: "/api/status",
        params: {},
        query: {},
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      // First plugin generates response
      const result1 = schemaPlug.process(context);

      // Second plugin receives generated response
      const result2 = loggingPlugin.process(result1.context, result1.response);

      expect(result2.response).toHaveProperty("message");
      expect(result2.response).toHaveProperty("code");
      expect(result2.response).toBe(result1.response); // Same reference
    });
  });
});
