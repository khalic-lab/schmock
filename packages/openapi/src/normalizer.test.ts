import { describe, expect, it } from "vitest";
import { normalizeSchema } from "./normalizer";

describe("normalizeSchema", () => {
  describe("nullable", () => {
    it("converts nullable: true to oneOf with null type", () => {
      const result = normalizeSchema(
        { type: "string", nullable: true },
        "response",
      );
      expect(result).toEqual({
        oneOf: [{ type: "string" }, { type: "null" }],
      });
    });

    it("removes nullable: false without adding null type", () => {
      const result = normalizeSchema(
        { type: "string", nullable: false },
        "response",
      );
      expect(result).toEqual({ type: "string" });
    });
  });

  describe("readOnly / writeOnly", () => {
    it("strips readOnly fields from request schemas", () => {
      const result = normalizeSchema(
        {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "integer", readOnly: true },
            name: { type: "string" },
          },
        },
        "request",
      );
      expect(result.properties).not.toHaveProperty("id");
      expect(result.properties).toHaveProperty("name");
      expect(result.required).toEqual(["name"]);
    });

    it("keeps readOnly fields in response schemas", () => {
      const result = normalizeSchema(
        {
          type: "object",
          properties: {
            id: { type: "integer", readOnly: true },
            name: { type: "string" },
          },
        },
        "response",
      );
      expect(result.properties).toHaveProperty("id");
      expect(result.properties).toHaveProperty("name");
    });

    it("strips writeOnly fields from response schemas", () => {
      const result = normalizeSchema(
        {
          type: "object",
          properties: {
            password: { type: "string", writeOnly: true },
            name: { type: "string" },
          },
        },
        "response",
      );
      expect(result.properties).not.toHaveProperty("password");
      expect(result.properties).toHaveProperty("name");
    });

    it("keeps writeOnly fields in request schemas", () => {
      const result = normalizeSchema(
        {
          type: "object",
          properties: {
            password: { type: "string", writeOnly: true },
            name: { type: "string" },
          },
        },
        "request",
      );
      expect(result.properties).toHaveProperty("password");
    });
  });

  describe("example → default", () => {
    it("copies example to default when default is not set", () => {
      const result = normalizeSchema(
        { type: "string", example: "hello" },
        "response",
      );
      expect(result.default).toBe("hello");
      expect(result).not.toHaveProperty("example");
    });

    it("preserves existing default when example is present", () => {
      const result = normalizeSchema(
        { type: "string", example: "hello", default: "world" },
        "response",
      );
      expect(result.default).toBe("world");
    });
  });

  describe("exclusiveMinimum/exclusiveMaximum boolean → number", () => {
    it("converts exclusiveMinimum: true to number format", () => {
      const result = normalizeSchema(
        { type: "number", minimum: 0, exclusiveMinimum: true },
        "response",
      );
      expect(result.exclusiveMinimum).toBe(0);
      expect(result).not.toHaveProperty("minimum");
    });

    it("removes exclusiveMinimum: false", () => {
      const result = normalizeSchema(
        { type: "number", minimum: 0, exclusiveMinimum: false },
        "response",
      );
      expect(result.minimum).toBe(0);
      expect(result).not.toHaveProperty("exclusiveMinimum");
    });

    it("converts exclusiveMaximum: true to number format", () => {
      const result = normalizeSchema(
        { type: "number", maximum: 100, exclusiveMaximum: true },
        "response",
      );
      expect(result.exclusiveMaximum).toBe(100);
      expect(result).not.toHaveProperty("maximum");
    });
  });

  describe("x-* extensions", () => {
    it("strips all x- prefixed properties", () => {
      const result = normalizeSchema(
        {
          type: "string",
          "x-custom": "value",
          "x-another": 42,
        },
        "response",
      );
      expect(result).not.toHaveProperty("x-custom");
      expect(result).not.toHaveProperty("x-another");
      expect(result.type).toBe("string");
    });
  });

  describe("deep recursion", () => {
    it("normalizes nested properties → items → oneOf", () => {
      const result = normalizeSchema(
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                oneOf: [
                  { type: "string", nullable: true },
                  { type: "integer", example: 42 },
                ],
              },
            },
          },
        },
        "response",
      );

      const itemsSchema = result.properties?.items;
      expect(itemsSchema).toBeDefined();
      const arraySchema = itemsSchema as Record<string, unknown>;
      const itemSchema = arraySchema.items as Record<string, unknown>;
      const branches = itemSchema.oneOf as Record<string, unknown>[];
      expect(branches).toHaveLength(2);
      // First branch: nullable string → oneOf
      expect(branches[0]).toHaveProperty("oneOf");
      // Second branch: example → default
      expect(branches[1]).toHaveProperty("default", 42);
    });
  });

  describe("passthrough", () => {
    it("preserves standard JSON Schema 7 features", () => {
      const input = {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          age: { type: "integer", minimum: 0, maximum: 150 },
          role: { type: "string", enum: ["admin", "user"] },
          email: { type: "string", pattern: "^[^@]+@[^@]+$" },
        },
        required: ["name"],
      };
      const result = normalizeSchema(input, "response");
      expect(result.properties?.name).toMatchObject({
        type: "string",
        minLength: 1,
        maxLength: 100,
      });
      expect(result.properties?.age).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: 150,
      });
      expect(result.required).toEqual(["name"]);
    });
  });

  describe("discriminator", () => {
    it("adds required and enum constraints for discriminator", () => {
      const result = normalizeSchema(
        {
          discriminator: {
            propertyName: "petType",
            mapping: {
              dog: "#/components/schemas/Dog",
              cat: "#/components/schemas/Cat",
            },
          },
          oneOf: [
            {
              type: "object",
              properties: {
                petType: { type: "string" },
                bark: { type: "boolean" },
              },
            },
            {
              type: "object",
              properties: {
                petType: { type: "string" },
                purr: { type: "boolean" },
              },
            },
          ],
        },
        "response",
      );

      expect(result).not.toHaveProperty("discriminator");
      const branches = result.oneOf as Record<string, unknown>[];
      expect(branches).toHaveLength(2);

      // Each branch should have petType as required
      for (const branch of branches) {
        expect(branch.required).toContain("petType");
      }
    });
  });
});
