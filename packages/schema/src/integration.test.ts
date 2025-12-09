import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { generateFromSchema, schemaPlugin } from "./index";
import { generate, schemas, validators } from "./test-utils";

describe("Schema Generator Integration Tests", () => {
  describe("End-to-End Scenarios", () => {
    it("generates complete mock API response with relationships", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              username: { type: "string", pattern: "^[a-z0-9_]{3,20}$" },
              email: { type: "string", format: "email" },
              profile: {
                type: "object",
                properties: {
                  firstName: { type: "string" },
                  lastName: { type: "string" },
                  avatar: { type: "string", format: "uri" },
                  bio: { type: "string", maxLength: 500 },
                },
              },
              posts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    title: { type: "string", minLength: 1, maxLength: 200 },
                    content: { type: "string" },
                    tags: {
                      type: "array",
                      items: { type: "string" },
                      maxItems: 5,
                    },
                    publishedAt: { type: "string", format: "date-time" },
                    comments: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string", format: "uuid" },
                          author: { type: "string" },
                          text: { type: "string" },
                          createdAt: { type: "string", format: "date-time" },
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

      const result = generateFromSchema({ schema });

      // Verify complete structure
      expect(result.user).toBeDefined();
      expect(validators.appearsToBeFromCategory([result.user.id], "uuid")).toBe(
        true,
      );
      expect(result.user.username).toMatch(/^[a-z0-9_]{3,20}$/);
      expect(
        validators.appearsToBeFromCategory([result.user.email], "email"),
      ).toBe(true);

      expect(result.user.profile).toBeDefined();
      expect(typeof result.user.profile.firstName).toBe("string");
      expect(result.user.profile.firstName.length).toBeGreaterThan(0);

      if (result.user.posts && result.user.posts.length > 0) {
        const post = result.user.posts[0];
        expect(validators.appearsToBeFromCategory([post.id], "uuid")).toBe(
          true,
        );
        expect(post.title.length).toBeGreaterThan(0);
        expect(
          validators.appearsToBeFromCategory([post.publishedAt], "date"),
        ).toBe(true);
      }
    });

    it("generates consistent data across related fields", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            order: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                customerId: { type: "string", format: "uuid" },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      productId: { type: "string", format: "uuid" },
                      quantity: { type: "integer", minimum: 1 },
                      unitPrice: { type: "number", minimum: 0 },
                      totalPrice: { type: "number", minimum: 0 },
                    },
                  },
                },
                subtotal: { type: "number", minimum: 0 },
                tax: { type: "number", minimum: 0 },
                total: { type: "number", minimum: 0 },
                createdAt: { type: "string", format: "date-time" },
                updatedAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
        overrides: {
          "order.customerId": "{{params.customerId}}",
          "order.createdAt": "{{state.timestamp}}",
          "order.updatedAt": "{{state.timestamp}}",
        },
      });

      const context = {
        method: "GET",
        path: "/api/orders/123",
        params: { orderId: "123", customerId: "customer-456" },
        query: {},
        state: new Map(),
        routeState: { timestamp: "2024-01-01T10:00:00Z" },
        headers: {},
        body: null,
        route: {},
      };

      const result = plugin.process(context);

      expect(result.response.order.customerId).toBe("customer-456");
      expect(result.response.order.createdAt).toBe("2024-01-01T10:00:00Z");
      expect(result.response.order.updatedAt).toBe("2024-01-01T10:00:00Z");

      // All IDs should be valid UUIDs
      expect(
        validators.appearsToBeFromCategory([result.response.order.id], "uuid"),
      ).toBe(true);

      if (
        result.response.order.items &&
        result.response.order.items.length > 0
      ) {
        result.response.order.items.forEach((item) => {
          expect(
            validators.appearsToBeFromCategory([item.productId], "uuid"),
          ).toBe(true);
          expect(item.quantity).toBeGreaterThanOrEqual(1);
          expect(item.unitPrice).toBeGreaterThanOrEqual(0);
        });
      }
    });
  });

  describe("Cross-Package Integration", () => {
    it("works with complex nested schemas from multiple sources", () => {
      const addressSchema: JSONSchema7 = {
        type: "object",
        properties: {
          street: { type: "string" },
          city: { type: "string" },
          state: { type: "string", pattern: "^[A-Z]{2}$" },
          zipCode: { type: "string", pattern: "^\\d{5}(-\\d{4})?$" },
          country: { type: "string", enum: ["US", "CA", "MX"] },
        },
        required: ["street", "city", "state", "zipCode", "country"],
      };

      const customerSchema: JSONSchema7 = {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string" },
          billingAddress: addressSchema,
          shippingAddress: addressSchema,
          sameAsBilling: { type: "boolean" },
        },
      };

      const result = generateFromSchema({ schema: customerSchema });

      // Both addresses should be valid structures
      expect(result.billingAddress.street).toBeDefined();
      expect(typeof result.billingAddress.street).toBe("string");
      expect(result.billingAddress.state).toMatch(/^[A-Z]{2}$/);
      expect(result.billingAddress.zipCode).toMatch(/^\d{5}(-\d{4})?$/);

      expect(result.shippingAddress.street).toBeDefined();
      expect(typeof result.shippingAddress.street).toBe("string");
      expect(["US", "CA", "MX"]).toContain(result.shippingAddress.country);
    });

    it("handles schema composition with allOf, anyOf, oneOf", () => {
      const baseSchema: JSONSchema7 = {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "createdAt"],
      };

      const documentSchema: JSONSchema7 = {
        allOf: [
          baseSchema,
          {
            type: "object",
            properties: {
              title: { type: "string" },
              content: {
                anyOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      html: { type: "string" },
                      markdown: { type: "string" },
                    },
                  },
                ],
              },
              status: {
                oneOf: [
                  { const: "draft" },
                  { const: "published" },
                  { const: "archived" },
                ],
              },
            },
            required: ["title", "content", "status"],
          },
        ],
      };

      const results = generate.samples<any>(documentSchema, 10);

      results.forEach((result) => {
        // Should have base properties
        expect(validators.appearsToBeFromCategory([result.id], "uuid")).toBe(
          true,
        );
        expect(
          validators.appearsToBeFromCategory([result.createdAt], "date"),
        ).toBe(true);

        // Should have document properties
        expect(result).toHaveProperty("title");
        expect(result).toHaveProperty("content");
        expect(["draft", "published", "archived"]).toContain(result.status);
      });
    });
  });

  describe("State Management Integration", () => {
    it("maintains state across multiple generations", () => {
      const _callCount = 0;
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            requestNumber: { type: "integer" },
            sessionId: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
          },
        },
        overrides: {
          requestNumber: "{{state.requestCount}}",
          sessionId: "{{state.sessionId}}",
        },
      });

      const baseContext = {
        method: "GET",
        path: "/api/track",
        params: {},
        query: {},
        headers: {},
        body: null,
        route: {},
      };

      // Simulate multiple requests with evolving state
      const results = Array.from({ length: 5 }, (_, i) => {
        const context = {
          ...baseContext,
          state: new Map(),
          routeState: {
            requestCount: i + 1,
            sessionId: "session-123",
          },
        };
        return plugin.process(context).response;
      });

      // Request numbers should increment
      results.forEach((result, i) => {
        expect(result.requestNumber).toBe(i + 1);
        expect(result.sessionId).toBe("session-123");
      });
    });

    it("generates stateful mock data", () => {
      const cartSchema: JSONSchema7 = {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                productId: { type: "string", format: "uuid" },
                quantity: { type: "integer", minimum: 1 },
                addedAt: { type: "string", format: "date-time" },
              },
            },
          },
          lastModified: { type: "string", format: "date-time" },
        },
      };

      // Generate initial cart
      const cart1 = generateFromSchema({ schema: cartSchema });

      // Simulate adding items (would be done through state in real usage)
      const cart2 = generateFromSchema({
        schema: cartSchema,
        overrides: {
          id: cart1.id, // Keep same cart ID
          userId: cart1.userId, // Keep same user
          lastModified: new Date().toISOString(),
        },
      });

      expect(cart2.id).toBe(cart1.id);
      expect(cart2.userId).toBe(cart1.userId);
    });
  });

  describe("Performance at Scale", () => {
    it("generates large datasets efficiently", () => {
      const schema: JSONSchema7 = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            uuid: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            active: { type: "boolean" },
            score: { type: "number", minimum: 0, maximum: 100 },
            tags: {
              type: "array",
              items: { type: "string" },
              maxItems: 3,
            },
          },
        },
      };

      const startTime = Date.now();
      const result = generateFromSchema({ schema, count: 100 });
      const duration = Date.now() - startTime;

      expect(result).toHaveLength(100);
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second

      // Verify data quality at scale
      const emails = result.map((item) => item.email);
      const uniqueEmails = new Set(emails);
      expect(uniqueEmails.size / emails.length).toBeGreaterThan(0.9); // High uniqueness
    });

    it("handles concurrent plugin processing", async () => {
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

      // Simulate concurrent requests
      const promises = Array.from({ length: 20 }, () =>
        Promise.resolve(plugin.process(context)),
      );

      const results = await Promise.all(promises);

      // All should complete successfully
      expect(results).toHaveLength(20);

      // Each should generate unique data
      const emails = results.map((r) => r.response.email);
      const uniqueEmails = new Set(emails);
      expect(uniqueEmails.size).toBeGreaterThan(15); // Most should be unique
    });
  });

  describe("Error Recovery and Resilience", () => {
    it("recovers from validation errors gracefully", () => {
      // First, try invalid schema
      try {
        generateFromSchema({
          schema: {
            type: "object",
            properties: {
              bad: { type: "invalid" as any },
            },
          },
        });
      } catch (_e) {
        // Expected
      }

      // Should still work with valid schema
      const result = generateFromSchema({
        schema: schemas.simple.object({ id: schemas.simple.number() }),
      });

      expect(result).toHaveProperty("id");
    });

    it("handles partial template failures", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            field1: { type: "string" },
            field2: { type: "string" },
            field3: { type: "string" },
            field4: { type: "string" },
          },
        },
        overrides: {
          field1: "{{params.value1}}",
          field2: "{{state.missing.nested.value}}",
          field3: "static",
          field4: "{{query.value4}}",
        },
      });

      const result = plugin.process({
        method: "GET",
        path: "/test",
        params: { value1: "success" },
        query: { value4: "works" },
        state: new Map(),
        routeState: {},
        headers: {},
        body: null,
        route: {},
      });

      // Successful templates should work
      expect(result.response.field1).toBe("success");
      expect(result.response.field3).toBe("static");
      expect(result.response.field4).toBe("works");

      // Failed template returns original
      expect(result.response.field2).toBe("{{state.missing.nested.value}}");
    });
  });

  describe("Advanced Integration Patterns", () => {
    it("supports pagination patterns", () => {
      const paginatedSchema: JSONSchema7 = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                name: { type: "string" },
              },
            },
          },
          pagination: {
            type: "object",
            properties: {
              page: { type: "integer", minimum: 1 },
              pageSize: { type: "integer", minimum: 1, maximum: 100 },
              total: { type: "integer", minimum: 0 },
              hasNext: { type: "boolean" },
              hasPrev: { type: "boolean" },
            },
          },
        },
      };

      const plugin = schemaPlugin({
        schema: paginatedSchema,
        overrides: {
          "pagination.page": "{{query.page}}",
          "pagination.pageSize": "{{query.limit}}",
          "pagination.total": 150,
          "pagination.hasNext": "{{state.hasNext}}",
          "pagination.hasPrev": "{{state.hasPrev}}",
        },
      });

      const result = plugin.process({
        method: "GET",
        path: "/api/items",
        params: {},
        query: { page: "2", limit: "20" },
        state: new Map(),
        routeState: { hasNext: true, hasPrev: true },
        headers: {},
        body: null,
        route: {},
      });

      expect(result.response.pagination.page).toBe("2");
      expect(result.response.pagination.pageSize).toBe("20");
      expect(result.response.pagination.total).toBe(150);
      expect(result.response.pagination.hasNext).toBe(true);
    });

    it("supports versioned API responses", () => {
      const v1Schema: JSONSchema7 = {
        type: "object",
        properties: {
          version: { const: "1.0" },
          data: {
            type: "object",
            properties: {
              id: { type: "number" },
              name: { type: "string" },
            },
          },
        },
      };

      const v2Schema: JSONSchema7 = {
        type: "object",
        properties: {
          version: { const: "2.0" },
          data: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
              metadata: { type: "object" },
            },
          },
        },
      };

      const v1Result = generateFromSchema({ schema: v1Schema });
      const v2Result = generateFromSchema({ schema: v2Schema });

      expect(v1Result.version).toBe("1.0");
      expect(typeof v1Result.data.id).toBe("number");

      expect(v2Result.version).toBe("2.0");
      expect(
        validators.appearsToBeFromCategory([v2Result.data.id], "uuid"),
      ).toBe(true);
      expect(v2Result.data).toHaveProperty("metadata");
    });
  });

  describe("Schmock Handle Integration", () => {
    it("resolves state overrides when using schmock.handle() with global state", async () => {
      // This test verifies that state-driven template overrides work correctly
      // when the schema plugin is used through schmock.handle() with global state
      const { schmock } = await import("@schmock/core");

      const userState = {
        currentUser: {
          id: "user-123",
          name: "Test User",
        },
        settings: {
          theme: "dark",
        },
      };

      const mock = schmock({ state: userState });

      const responseSchema: JSONSchema7 = {
        type: "object",
        properties: {
          userId: { type: "string" },
          userName: { type: "string" },
          theme: { type: "string" },
          timestamp: { type: "string" },
        },
      };

      mock("GET /profile", null).pipe(
        schemaPlugin({
          schema: responseSchema,
          overrides: {
            userId: "{{state.currentUser.id}}",
            userName: "{{state.currentUser.name}}",
            theme: "{{state.settings.theme}}",
          },
        }),
      );

      const response = await mock.handle("GET", "/profile");

      expect(response.body.userId).toBe("user-123");
      expect(response.body.userName).toBe("Test User");
      expect(response.body.theme).toBe("dark");
    });
  });
});
