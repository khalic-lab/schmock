import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { generateFromSchema, schemaPlugin } from "./index";
import { validators } from "./test-utils";

describe("Real-World Scenarios", () => {
  describe("API Response Schemas", () => {
    it("generates REST API list responses", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          data: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                title: { type: "string", minLength: 1, maxLength: 200 },
                status: {
                  type: "string",
                  enum: ["draft", "published", "archived"],
                },
                author: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    name: { type: "string" },
                    email: { type: "string", format: "email" },
                  },
                  required: ["id", "name"],
                },
                createdAt: { type: "string", format: "date-time" },
                tags: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: 10,
                },
              },
              required: ["id", "title", "status", "author", "createdAt"],
            },
          },
          meta: {
            type: "object",
            properties: {
              page: { type: "integer", minimum: 1 },
              perPage: { type: "integer", minimum: 1, maximum: 100 },
              total: { type: "integer", minimum: 0 },
              totalPages: { type: "integer", minimum: 0 },
            },
            required: ["page", "perPage", "total", "totalPages"],
          },
        },
        required: ["data", "meta"],
      };

      const result = generateFromSchema({ schema });

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("meta");
      expect(Array.isArray(result.data)).toBe(true);

      // Verify structure
      if (result.data.length > 0) {
        const item = result.data[0];
        expect(validators.appearsToBeFromCategory([item.id], "uuid")).toBe(
          true,
        );
        expect(item.title.length).toBeGreaterThan(0);
        expect(["draft", "published", "archived"]).toContain(item.status);
        expect(
          validators.appearsToBeFromCategory([item.author.email], "email"),
        ).toBe(true);
      }

      // Meta should make sense
      expect(result.meta.page).toBeGreaterThanOrEqual(1);
      expect(result.meta.perPage).toBeGreaterThanOrEqual(1);
      expect(result.meta.total).toBeGreaterThanOrEqual(0);
    });

    it("generates GraphQL-style responses", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  username: { type: "string" },
                  profile: {
                    type: "object",
                    properties: {
                      firstName: { type: "string" },
                      lastName: { type: "string" },
                      avatar: { type: "string", format: "uri" },
                    },
                  },
                  posts: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        title: { type: "string" },
                        content: { type: "string" },
                        publishedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
          errors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                message: { type: "string" },
                path: { type: "array", items: { type: "string" } },
                extensions: { type: "object" },
              },
            },
          },
        },
      };

      const result = generateFromSchema({ schema });

      if (result.data?.user) {
        expect(result.data.user).toHaveProperty("id");
        expect(result.data.user).toHaveProperty("username");

        if (result.data.user.profile) {
          expect(typeof result.data.user.profile.firstName).toBe("string");
          expect(result.data.user.profile.firstName.length).toBeGreaterThan(0);
        }

        if (result.data.user.posts && result.data.user.posts.length > 0) {
          expect(result.data.user.posts[0]).toHaveProperty("title");
        }
      }
    });

    it("generates webhook payloads", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          event: {
            type: "string",
            enum: ["order.created", "order.updated", "order.cancelled"],
          },
          timestamp: { type: "string", format: "date-time" },
          data: {
            type: "object",
            properties: {
              orderId: { type: "string", format: "uuid" },
              customerId: { type: "string", format: "uuid" },
              amount: { type: "number", minimum: 0 },
              currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    productId: { type: "string" },
                    quantity: { type: "integer", minimum: 1 },
                    price: { type: "number", minimum: 0 },
                  },
                },
              },
            },
          },
          signature: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        required: ["event", "timestamp", "data", "signature"],
      };

      const result = generateFromSchema({ schema });

      expect(["order.created", "order.updated", "order.cancelled"]).toContain(
        result.event,
      );
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
      expect(result.signature).toMatch(/^[a-f0-9]{64}$/);
      expect(result.data.amount).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Database Model Schemas", () => {
    it("generates user model data", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          username: { type: "string", pattern: "^[a-zA-Z0-9_]{3,20}$" },
          email: { type: "string", format: "email" },
          passwordHash: {
            type: "string",
            pattern: "^\\$2[aby]\\$[0-9]{2}\\$.{53}$",
          },
          profile: {
            type: "object",
            properties: {
              firstName: { type: "string", maxLength: 50 },
              lastName: { type: "string", maxLength: 50 },
              bio: { type: "string", maxLength: 500 },
              dateOfBirth: { type: "string", format: "date" },
              phoneNumber: { type: "string", pattern: "^\\+?[1-9]\\d{1,14}$" },
            },
          },
          settings: {
            type: "object",
            properties: {
              theme: { type: "string", enum: ["light", "dark", "auto"] },
              language: { type: "string", enum: ["en", "es", "fr", "de"] },
              emailNotifications: { type: "boolean" },
              twoFactorEnabled: { type: "boolean" },
            },
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          lastLoginAt: {
            oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
          },
        },
        required: [
          "id",
          "username",
          "email",
          "passwordHash",
          "createdAt",
          "updatedAt",
        ],
      };

      const result = generateFromSchema({ schema });

      expect(result.id).toBeGreaterThanOrEqual(1);
      expect(result.username).toMatch(/^[a-zA-Z0-9_]{3,20}$/);
      expect(validators.appearsToBeFromCategory([result.email], "email")).toBe(
        true,
      );
      expect(result.passwordHash).toMatch(/^\$2[aby]\$[0-9]{2}\$.{53}$/);

      // Dates should be valid
      const created = new Date(result.createdAt);
      const updated = new Date(result.updatedAt);
      expect(created.getTime()).not.toBeNaN();
      expect(updated.getTime()).not.toBeNaN();
    });

    it("generates product catalog data", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          sku: { type: "string", pattern: "^[A-Z]{3}-[0-9]{6}$" },
          name: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 2000 },
          price: {
            type: "object",
            properties: {
              amount: { type: "number", minimum: 0, multipleOf: 0.01 },
              currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
            },
            required: ["amount", "currency"],
          },
          inventory: {
            type: "object",
            properties: {
              inStock: { type: "integer", minimum: 0 },
              reserved: { type: "integer", minimum: 0 },
              available: { type: "integer" },
            },
          },
          categories: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 5,
          },
          attributes: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      };

      const result = generateFromSchema({ schema });

      expect(result.sku).toMatch(/^[A-Z]{3}-[0-9]{6}$/);
      expect(result.name.length).toBeGreaterThan(0);
      expect(result.price.amount).toBeGreaterThanOrEqual(0);
      expect(["USD", "EUR", "GBP"]).toContain(result.price.currency);

      if (result.inventory) {
        expect(result.inventory.inStock).toBeGreaterThanOrEqual(0);
        expect(result.inventory.reserved).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("Configuration Schemas", () => {
    it("generates application config", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          app: {
            type: "object",
            properties: {
              name: { type: "string" },
              version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
              environment: {
                type: "string",
                enum: ["development", "staging", "production"],
              },
              debug: { type: "boolean" },
            },
            required: ["name", "version", "environment"],
          },
          server: {
            type: "object",
            properties: {
              host: { type: "string", format: "hostname" },
              port: { type: "integer", minimum: 1, maximum: 65535 },
              ssl: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                  cert: { type: "string" },
                  key: { type: "string" },
                },
              },
            },
          },
          database: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["postgres", "mysql", "mongodb"] },
              host: { type: "string" },
              port: { type: "integer" },
              name: { type: "string" },
              pool: {
                type: "object",
                properties: {
                  min: { type: "integer", minimum: 0 },
                  max: { type: "integer", minimum: 1 },
                },
              },
            },
          },
        },
      };

      const result = generateFromSchema({ schema });

      if (result.app) {
        expect(result.app.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(["development", "staging", "production"]).toContain(
          result.app.environment,
        );
      }

      if (result.server?.port) {
        expect(result.server.port).toBeGreaterThanOrEqual(1);
        expect(result.server.port).toBeLessThanOrEqual(65535);
      }
    });

    it("generates OpenAPI schema definitions", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          openapi: { type: "string", const: "3.0.0" },
          info: {
            type: "object",
            properties: {
              title: { type: "string" },
              version: { type: "string" },
              description: { type: "string" },
            },
            required: ["title", "version"],
          },
          servers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url: { type: "string", format: "uri" },
                description: { type: "string" },
              },
              required: ["url"],
            },
          },
          paths: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                get: { type: "object" },
                post: { type: "object" },
                put: { type: "object" },
                delete: { type: "object" },
              },
            },
          },
        },
        required: ["openapi", "info", "paths"],
      };

      const result = generateFromSchema({ schema });

      expect(result.openapi).toBe("3.0.0");
      expect(result.info).toHaveProperty("title");
      expect(result.info).toHaveProperty("version");
      expect(result.paths).toBeDefined();
    });
  });

  describe("Form Data Schemas", () => {
    it("generates user registration form data", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          username: {
            type: "string",
            minLength: 3,
            maxLength: 20,
            pattern: "^[a-zA-Z0-9_]+$",
          },
          email: {
            type: "string",
            format: "email",
          },
          password: {
            type: "string",
            minLength: 8,
            maxLength: 128,
          },
          confirmPassword: {
            type: "string",
            minLength: 8,
            maxLength: 128,
          },
          profile: {
            type: "object",
            properties: {
              firstName: { type: "string", maxLength: 50 },
              lastName: { type: "string", maxLength: 50 },
              dateOfBirth: { type: "string", format: "date" },
              country: { type: "string" },
              newsletter: { type: "boolean" },
            },
          },
          termsAccepted: { type: "boolean", const: true },
        },
        required: [
          "username",
          "email",
          "password",
          "confirmPassword",
          "termsAccepted",
        ],
      };

      const result = generateFromSchema({ schema });

      expect(result.username).toMatch(/^[a-zA-Z0-9_]+$/);
      expect(result.username.length).toBeGreaterThanOrEqual(3);
      expect(validators.appearsToBeFromCategory([result.email], "email")).toBe(
        true,
      );
      expect(result.password.length).toBeGreaterThanOrEqual(8);
      expect(result.termsAccepted).toBe(true);
    });

    it("generates complex survey responses", () => {
      const schema: JSONSchema7 = {
        type: "object",
        properties: {
          respondentId: { type: "string", format: "uuid" },
          submittedAt: { type: "string", format: "date-time" },
          responses: {
            type: "array",
            items: {
              type: "object",
              properties: {
                questionId: { type: "string" },
                type: {
                  type: "string",
                  enum: ["text", "choice", "scale", "multiselect"],
                },
                answer: {
                  oneOf: [
                    { type: "string" },
                    { type: "number" },
                    { type: "array", items: { type: "string" } },
                  ],
                },
              },
              required: ["questionId", "type", "answer"],
            },
          },
          metadata: {
            type: "object",
            properties: {
              duration: { type: "integer", minimum: 0 },
              device: { type: "string", enum: ["desktop", "mobile", "tablet"] },
              browser: { type: "string" },
            },
          },
        },
      };

      const result = generateFromSchema({ schema });

      expect(
        validators.appearsToBeFromCategory([result.respondentId], "uuid"),
      ).toBe(true);
      expect(new Date(result.submittedAt).getTime()).not.toBeNaN();

      if (result.responses && result.responses.length > 0) {
        result.responses.forEach((response) => {
          expect(["text", "choice", "scale", "multiselect"]).toContain(
            response.type,
          );
          expect(response).toHaveProperty("answer");
        });
      }
    });
  });

  describe("Integration with Schmock", () => {
    it("works with schmock route handlers", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            users: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  email: { type: "string", format: "email" },
                },
              },
            },
            _links: {
              type: "object",
              properties: {
                self: { type: "string", format: "uri" },
                next: { type: "string", format: "uri" },
                prev: { type: "string", format: "uri" },
              },
            },
          },
        },
        count: 10,
      });

      const context = {
        method: "GET",
        path: "/api/users",
        params: {},
        query: { page: "2", limit: "10" },
        state: {},
        headers: {},
        body: null,
        route: {},
      };

      const result = plugin.process(context);

      expect(result.response).toHaveProperty("users");
      expect(Array.isArray(result.response.users)).toBe(true);

      if (result.response.users.length > 0) {
        const user = result.response.users[0];
        expect(validators.appearsToBeFromCategory([user.id], "uuid")).toBe(
          true,
        );
        expect(validators.appearsToBeFromCategory([user.email], "email")).toBe(
          true,
        );
      }
    });

    it("integrates with template overrides", () => {
      const plugin = schemaPlugin({
        schema: {
          type: "object",
          properties: {
            orderId: { type: "string" },
            customerId: { type: "string" },
            total: { type: "number" },
            status: { type: "string" },
            createdAt: { type: "string" },
          },
        },
        overrides: {
          orderId: "{{params.orderId}}",
          customerId: "{{state.user.id}}",
          status: "pending",
          createdAt: "{{state.timestamp}}",
        },
      });

      const context = {
        method: "GET",
        path: "/api/orders/order-123",
        params: { orderId: "order-123" },
        query: {},
        state: {
          user: { id: "customer-456" },
          timestamp: "2024-01-01T12:00:00Z",
        },
        headers: {},
        body: null,
        route: {},
      };

      const result = plugin.process(context);

      expect(result.response.orderId).toBe("order-123");
      expect(result.response.customerId).toBe("customer-456");
      expect(result.response.status).toBe("pending");
      expect(result.response.createdAt).toBe("2024-01-01T12:00:00Z");
    });
  });
});
