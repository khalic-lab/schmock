import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";
import { enhanceSchemaWithSmartMapping } from "./schema-enhancement";

describe("enhanceSchemaWithSmartMapping", () => {
  it("does NOT mutate the original schema", () => {
    const original: JSONSchema7 = {
      type: "object",
      properties: {
        email: { type: "string" },
        firstName: { type: "string" },
        createdAt: { type: "string" },
      },
    };

    // Deep snapshot before enhancement
    const snapshot = JSON.parse(JSON.stringify(original));

    enhanceSchemaWithSmartMapping(original);

    // Original should be unchanged
    expect(original).toEqual(snapshot);
  });

  it("enhancement of object with properties adds faker methods to appropriate fields", () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        email: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        phone: { type: "string" },
        uuid: { type: "string" },
      },
    };

    const enhanced = enhanceSchemaWithSmartMapping(schema) as Record<
      string,
      unknown
    >;
    const props = enhanced.properties as Record<
      string,
      JSONSchema7 & { faker?: string }
    >;

    // Well-known fields should receive faker methods
    expect(props.email.faker).toBeDefined();
    expect(props.firstName.faker).toBeDefined();
    expect(props.lastName.faker).toBeDefined();
    expect(props.phone.faker).toBeDefined();
    expect(props.uuid.faker).toBeDefined();

    // Verify they are plausible faker method strings (namespace.method format)
    for (const field of ["email", "firstName", "lastName", "phone", "uuid"]) {
      const fakerMethod = props[field].faker as string;
      expect(fakerMethod).toContain(".");
      expect(fakerMethod.split(".").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("enhancement recurses into allOf branches", () => {
    const schema: JSONSchema7 = {
      allOf: [
        {
          type: "object",
          properties: {
            email: { type: "string" },
          },
        },
        {
          type: "object",
          properties: {
            phone: { type: "string" },
          },
        },
      ],
    };

    const enhanced = enhanceSchemaWithSmartMapping(schema);
    const allOf = enhanced.allOf as Array<
      JSONSchema7 & { properties: Record<string, { faker?: string }> }
    >;

    expect(allOf).toHaveLength(2);
    expect(allOf[0].properties.email.faker).toBeDefined();
    expect(allOf[1].properties.phone.faker).toBeDefined();
  });

  it("enhancement recurses into anyOf branches", () => {
    const schema: JSONSchema7 = {
      anyOf: [
        {
          type: "object",
          properties: {
            email: { type: "string" },
          },
        },
      ],
    };

    const enhanced = enhanceSchemaWithSmartMapping(schema);
    const anyOf = enhanced.anyOf as Array<
      JSONSchema7 & { properties: Record<string, { faker?: string }> }
    >;

    expect(anyOf).toHaveLength(1);
    expect(anyOf[0].properties.email.faker).toBeDefined();
  });

  it("enhancement recurses into oneOf branches", () => {
    const schema: JSONSchema7 = {
      oneOf: [
        {
          type: "object",
          properties: {
            firstName: { type: "string" },
          },
        },
      ],
    };

    const enhanced = enhanceSchemaWithSmartMapping(schema);
    const oneOf = enhanced.oneOf as Array<
      JSONSchema7 & { properties: Record<string, { faker?: string }> }
    >;

    expect(oneOf).toHaveLength(1);
    expect(oneOf[0].properties.firstName.faker).toBeDefined();
  });

  it("enhancement recurses into array items", () => {
    const schema: JSONSchema7 = {
      type: "array",
      items: {
        type: "object",
        properties: {
          email: { type: "string" },
          createdAt: { type: "string" },
        },
      },
    };

    const enhanced = enhanceSchemaWithSmartMapping(schema);
    const items = enhanced.items as JSONSchema7 & {
      properties: Record<string, { faker?: string }>;
    };

    expect(items.properties.email.faker).toBeDefined();
    expect(items.properties.createdAt.faker).toBeDefined();
  });

  it("fields with existing faker property are not overridden", () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        email: {
          type: "string",
          faker: "lorem.word",
        } as JSONSchema7 & { faker: string },
      },
    };

    const enhanced = enhanceSchemaWithSmartMapping(schema);
    const props = enhanced.properties as Record<
      string,
      JSONSchema7 & { faker?: string }
    >;

    // Should keep the explicit faker method, not replace with email generator
    expect(props.email.faker).toBe("lorem.word");
  });

  it("handles schema without properties gracefully", () => {
    const schema: JSONSchema7 = { type: "string" };
    const enhanced = enhanceSchemaWithSmartMapping(schema);
    expect(enhanced).toEqual({ type: "string" });
  });

  it("handles null/undefined schema gracefully", () => {
    expect(enhanceSchemaWithSmartMapping(null as unknown as JSONSchema7)).toBe(
      null,
    );
    expect(
      enhanceSchemaWithSmartMapping(undefined as unknown as JSONSchema7),
    ).toBe(undefined);
  });

  it("enhancement recurses into array items when items is a tuple (array)", () => {
    const schema: JSONSchema7 = {
      type: "array",
      items: [
        {
          type: "object",
          properties: {
            email: { type: "string" },
          },
        },
        {
          type: "object",
          properties: {
            phone: { type: "string" },
          },
        },
      ],
    };

    const enhanced = enhanceSchemaWithSmartMapping(schema);
    const items = enhanced.items as Array<
      JSONSchema7 & { properties: Record<string, { faker?: string }> }
    >;

    expect(Array.isArray(items)).toBe(true);
    expect(items[0].properties.email.faker).toBeDefined();
    expect(items[1].properties.phone.faker).toBeDefined();
  });
});
