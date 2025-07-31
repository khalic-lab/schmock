import { describe, expect, it } from "vitest";
import {
  PluginError,
  ResourceLimitError,
  ResponseGenerationError,
  RouteDefinitionError,
  RouteNotFoundError,
  RouteParseError,
  SchemaGenerationError,
  SchemaValidationError,
  SchmockError,
} from "./errors";

describe("error classes", () => {
  describe("SchmockError", () => {
    it("creates base error with code and context", () => {
      const error = new SchmockError("test message", "TEST_CODE", { data: "test" });
      
      expect(error.message).toBe("test message");
      expect(error.code).toBe("TEST_CODE");
      expect(error.context).toEqual({ data: "test" });
      expect(error.name).toBe("SchmockError");
      expect(error).toBeInstanceOf(Error);
    });

    it("creates error without context", () => {
      const error = new SchmockError("test message", "TEST_CODE");
      
      expect(error.context).toBeUndefined();
    });

    it("captures stack trace", () => {
      const error = new SchmockError("test", "TEST");
      
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("SchmockError");
    });
  });

  describe("RouteNotFoundError", () => {
    it("formats message with method and path", () => {
      const error = new RouteNotFoundError("GET", "/users/123");
      
      expect(error.message).toBe("Route not found: GET /users/123");
      expect(error.code).toBe("ROUTE_NOT_FOUND");
      expect(error.context).toEqual({ method: "GET", path: "/users/123" });
      expect(error.name).toBe("RouteNotFoundError");
    });
  });

  describe("RouteParseError", () => {
    it("includes route key and reason in message", () => {
      const error = new RouteParseError("INVALID /test", "Missing method");
      
      expect(error.message).toBe('Invalid route key format: "INVALID /test". Missing method');
      expect(error.code).toBe("ROUTE_PARSE_ERROR");
      expect(error.context).toEqual({ 
        routeKey: "INVALID /test", 
        reason: "Missing method" 
      });
    });
  });

  describe("ResponseGenerationError", () => {
    it("wraps original error", () => {
      const originalError = new Error("Original failure");
      const error = new ResponseGenerationError("GET /users", originalError);
      
      expect(error.message).toBe("Failed to generate response for route GET /users: Original failure");
      expect(error.code).toBe("RESPONSE_GENERATION_ERROR");
      expect(error.context).toEqual({ 
        route: "GET /users", 
        originalError 
      });
    });
  });

  describe("PluginError", () => {
    it("includes plugin name and wraps error", () => {
      const originalError = new Error("Plugin failed");
      const error = new PluginError("test-plugin", originalError);
      
      expect(error.message).toBe('Plugin "test-plugin" failed: Plugin failed');
      expect(error.code).toBe("PLUGIN_ERROR");
      expect(error.context).toEqual({ 
        pluginName: "test-plugin", 
        originalError 
      });
    });
  });

  describe("RouteDefinitionError", () => {
    it("includes route key and reason", () => {
      const error = new RouteDefinitionError("GET /test", "Missing response function");
      
      expect(error.message).toBe('Invalid route definition for "GET /test": Missing response function');
      expect(error.code).toBe("ROUTE_DEFINITION_ERROR");
      expect(error.context).toEqual({ 
        routeKey: "GET /test", 
        reason: "Missing response function" 
      });
    });
  });

  describe("SchemaValidationError", () => {
    it("includes path and issue", () => {
      const error = new SchemaValidationError("users.name", "Required field missing");
      
      expect(error.message).toBe("Schema validation failed at users.name: Required field missing");
      expect(error.code).toBe("SCHEMA_VALIDATION_ERROR");
      expect(error.context).toEqual({ 
        schemaPath: "users.name", 
        issue: "Required field missing",
        suggestion: undefined
      });
    });

    it("includes suggestion when provided", () => {
      const error = new SchemaValidationError(
        "users.age", 
        "Invalid type", 
        "Use number instead of string"
      );
      
      expect(error.message).toBe("Schema validation failed at users.age: Invalid type. Use number instead of string");
      expect(error.context?.suggestion).toBe("Use number instead of string");
    });
  });

  describe("SchemaGenerationError", () => {
    it("wraps schema generation failure", () => {
      const originalError = new Error("Invalid schema");
      const schema = { type: "object" };
      const error = new SchemaGenerationError("GET /users", originalError, schema);
      
      expect(error.message).toBe("Schema generation failed for route GET /users: Invalid schema");
      expect(error.code).toBe("SCHEMA_GENERATION_ERROR");
      expect(error.context).toEqual({ 
        route: "GET /users", 
        originalError,
        schema
      });
    });

    it("works without schema context", () => {
      const originalError = new Error("Invalid schema");
      const error = new SchemaGenerationError("GET /users", originalError);
      
      expect(error.context?.schema).toBeUndefined();
    });
  });

  describe("ResourceLimitError", () => {
    it("includes resource and limit", () => {
      const error = new ResourceLimitError("memory", 1024);
      
      expect(error.message).toBe("Resource limit exceeded for memory: limit=1024");
      expect(error.code).toBe("RESOURCE_LIMIT_ERROR");
      expect(error.context).toEqual({ 
        resource: "memory", 
        limit: 1024,
        actual: undefined
      });
    });

    it("includes actual value when provided", () => {
      const error = new ResourceLimitError("connections", 100, 150);
      
      expect(error.message).toBe("Resource limit exceeded for connections: limit=100, actual=150");
      expect(error.context?.actual).toBe(150);
    });
  });

  describe("error inheritance", () => {
    it("all custom errors inherit from SchmockError", () => {
      const errors = [
        new RouteNotFoundError("GET", "/test"),
        new RouteParseError("invalid", "reason"),
        new ResponseGenerationError("route", new Error("test")),
        new PluginError("plugin", new Error("test")),
        new RouteDefinitionError("route", "reason"),
        new SchemaValidationError("path", "issue"),
        new SchemaGenerationError("route", new Error("test")),
        new ResourceLimitError("resource", 100),
      ];

      for (const error of errors) {
        expect(error).toBeInstanceOf(SchmockError);
        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBeDefined();
        expect(error.name).toBeDefined();
      }
    });
  });
});