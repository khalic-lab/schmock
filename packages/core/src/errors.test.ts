import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  errorMessage,
  PluginError,
  ResourceLimitError,
  RouteDefinitionError,
  RouteNotFoundError,
  RouteParseError,
  SchemaGenerationError,
  SchemaValidationError,
  SchmockError,
  toError,
} from "./errors";

describe("errorMessage", () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("preserves a thrown string verbatim", () => {
    expect(errorMessage("boom-string")).toBe("boom-string");
  });

  it("preserves thrown primitives", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(false)).toBe("false");
    expect(errorMessage(Symbol("sym"))).toBe("Symbol(sym)");
    expect(errorMessage(10n)).toBe("10");
  });

  it("keeps 'Unknown error' for null and undefined", () => {
    expect(errorMessage(null)).toBe("Unknown error");
    expect(errorMessage(undefined)).toBe("Unknown error");
  });

  it("serializes a plain object throw", () => {
    expect(errorMessage({ code: "E_X", detail: 42 })).toBe(
      '{"code":"E_X","detail":42}',
    );
  });

  it("falls back for a circular object", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(errorMessage(circular)).toBe("Unknown error");
  });

  it("does not let a throwing toString escape", () => {
    const hostile = {
      toString() {
        throw new Error("nope");
      },
      get boom() {
        throw new Error("getter exploded");
      },
    };
    expect(() => errorMessage(hostile)).not.toThrow();
    expect(errorMessage(hostile)).toBe("Unknown error");
  });

  it("truncates a very long stringification", () => {
    const long = "x".repeat(5_000);
    const result = errorMessage(long);
    expect(result.length).toBeLessThanOrEqual(220);
    expect(result.endsWith("…")).toBe(true);
  });

  it.each([
    ["undefined", undefined, "Unknown error"],
    ["bigint", 10n, "10"],
    ["number", 42, "42"],
    ["object", { code: 1 }, '{"code":1}'],
  ] satisfies Array<[string, unknown, string]>)(
    "describes an Error whose message is a %s the way it describes a thrown one",
    (_label, message, expected) => {
      const error = new Error("replaced");
      Object.defineProperty(error, "message", { value: message });

      expect(errorMessage(error)).toBe(expected);
    },
  );

  it("survives an Error whose message getter throws", () => {
    const error = new Error("replaced");
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("no message");
      },
    });

    expect(errorMessage(error)).toBe("Unknown error");
  });
});

describe("errors from another realm", () => {
  const foreign = (): Error =>
    runInNewContext('new TypeError("boom from other realm")');

  it("describes one by its message", () => {
    expect(errorMessage(foreign())).toBe("boom from other realm");
  });

  it("returns one with a string message as is", () => {
    const error = foreign();
    expect(toError(error)).toBe(error);
  });

  it.runIf(typeof Reflect.get(Error, "isError") === "function")(
    "does not take an object that only forges the Error tag for one",
    () => {
      const forged = { message: "forged", [Symbol.toStringTag]: "Error" };
      expect(Object.prototype.toString.call(forged)).toBe("[object Error]");
      expect(errorMessage(forged)).toBe('{"message":"forged"}');
      expect(toError(forged)).not.toBe(forged);
    },
  );

  describe("on a runtime without Error.isError", () => {
    const withoutIsError = (run: () => void) => {
      const descriptor = Object.getOwnPropertyDescriptor(Error, "isError");
      Reflect.deleteProperty(Error, "isError");
      try {
        run();
      } finally {
        if (descriptor) Object.defineProperty(Error, "isError", descriptor);
      }
    };

    it("recognises one by its object tag", () => {
      withoutIsError(() => {
        const error = foreign();
        expect(errorMessage(error)).toBe("boom from other realm");
        expect(toError(error)).toBe(error);
      });
    });

    it("still describes a plain object as its JSON", () => {
      withoutIsError(() => {
        const thrown = { message: "plain" };
        expect(errorMessage(thrown)).toBe('{"message":"plain"}');
        expect(toError(thrown)).not.toBe(thrown);
      });
    });
  });
});

describe("toError", () => {
  it("returns an Error with a string message as is", () => {
    const error = new SchmockError("boom", "E_BOOM");
    expect(toError(error)).toBe(error);
  });

  it.each([
    ["string", "boom", "boom"],
    ["object", { reason: "quota" }, '{"reason":"quota"}'],
    ["null", null, "Unknown error"],
  ] satisfies Array<[string, unknown, string]>)(
    "wraps a thrown %s, keeping it as the cause",
    (_label, value, message) => {
      const error = toError(value);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(message);
      expect(error.cause).toBe(value);
    },
  );

  it("wraps an Error whose message is not a string, keeping it as the cause", () => {
    const original = new Error("replaced");
    Object.defineProperty(original, "message", { value: undefined });

    const error = toError(original);

    expect(error).not.toBe(original);
    expect(error.message).toBe("Unknown error");
    expect(error.cause).toBe(original);
  });
});

describe("error classes", () => {
  describe("SchmockError", () => {
    it("creates base error with code and context", () => {
      const error = new SchmockError("test message", "TEST_CODE", {
        data: "test",
      });

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

      expect(error.message).toBe(
        'Invalid route key format: "INVALID /test". Missing method',
      );
      expect(error.code).toBe("ROUTE_PARSE_ERROR");
      expect(error.context).toEqual({
        routeKey: "INVALID /test",
        reason: "Missing method",
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
        originalError,
      });
    });
  });

  describe("RouteDefinitionError", () => {
    it("includes route key and reason", () => {
      const error = new RouteDefinitionError(
        "GET /test",
        "Missing response function",
      );

      expect(error.message).toBe(
        'Invalid route definition for "GET /test": Missing response function',
      );
      expect(error.code).toBe("ROUTE_DEFINITION_ERROR");
      expect(error.context).toEqual({
        routeKey: "GET /test",
        reason: "Missing response function",
      });
    });
  });

  describe("SchemaValidationError", () => {
    it("includes path and issue", () => {
      const error = new SchemaValidationError(
        "users.name",
        "Required field missing",
      );

      expect(error.message).toBe(
        "Schema validation failed at users.name: Required field missing",
      );
      expect(error.code).toBe("SCHEMA_VALIDATION_ERROR");
      expect(error.context).toEqual({
        schemaPath: "users.name",
        issue: "Required field missing",
        suggestion: undefined,
      });
    });

    it("includes suggestion when provided", () => {
      const error = new SchemaValidationError(
        "users.age",
        "Invalid type",
        "Use number instead of string",
      );

      expect(error.message).toBe(
        "Schema validation failed at users.age: Invalid type. Use number instead of string",
      );
      expect(error.context?.suggestion).toBe("Use number instead of string");
    });
  });

  describe("SchemaGenerationError", () => {
    it("wraps schema generation failure", () => {
      const originalError = new Error("Invalid schema");
      const schema = { type: "object" };
      const error = new SchemaGenerationError(
        "GET /users",
        originalError,
        schema,
      );

      expect(error.message).toBe(
        "Schema generation failed for route GET /users: Invalid schema",
      );
      expect(error.code).toBe("SCHEMA_GENERATION_ERROR");
      expect(error.context).toEqual({
        route: "GET /users",
        originalError,
        schema,
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

      expect(error.message).toBe(
        "Resource limit exceeded for memory: limit=1024",
      );
      expect(error.code).toBe("RESOURCE_LIMIT_ERROR");
      expect(error.context).toEqual({
        resource: "memory",
        limit: 1024,
        actual: undefined,
      });
    });

    it("includes actual value when provided", () => {
      const error = new ResourceLimitError("connections", 100, 150);

      expect(error.message).toBe(
        "Resource limit exceeded for connections: limit=100, actual=150",
      );
      expect(error.context?.actual).toBe(150);
    });
  });

  describe("error inheritance", () => {
    it("all custom errors inherit from SchmockError", () => {
      const errors = [
        new RouteNotFoundError("GET", "/test"),
        new RouteParseError("invalid", "reason"),
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
