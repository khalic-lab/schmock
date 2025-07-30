/// <reference path="../../../types/schmock.d.ts" />

import { faker } from "@faker-js/faker";
import type { JSONSchema7 } from "json-schema";
import jsf from "json-schema-faker";

// Configure json-schema-faker with faker.js
jsf.extend("faker", () => faker);

// Configure json-schema-faker options
jsf.option({
  requiredOnly: false,
  alwaysFakeOptionals: true,
  useDefaultValue: true,
  ignoreMissingRefs: true,
  failOnInvalidTypes: false,
  failOnInvalidFormat: false,
});

// Resource limits for safety
const MAX_ARRAY_SIZE = 10000;
const MAX_NESTING_DEPTH = 10;

interface SchemaRouteExtension {
  schema?: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
}

interface SchemaGenerationContext {
  schema: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
  params?: Record<string, string>;
  state?: any;
  query?: Record<string, string>;
}

export function schemaPlugin(): Schmock.Plugin {
  return {
    name: "schema",
    version: "0.1.0",

    generate(context: Schmock.PluginContext) {
      const route = context.route as any;

      // Only handle routes with schema but no response function
      if (!route.schema || route.response) {
        return; // Let other plugins or response function handle it
      }

      try {
        return generateFromSchema({
          schema: route.schema,
          count: route.count,
          overrides: route.overrides,
          params: context.params,
          state: context.state,
        });
      } catch (error) {
        throw new Error(
          `Schema generation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    transform(data: any, context: Schmock.PluginContext) {
      const route = context.route as any;

      // If route has both schema and response function, provide generateFromSchema helper
      if (route.schema && route.response) {
        // This is handled by enhancing the context, but we can't modify context here
        // This will be handled by the builder integration
      }

      return data;
    },
  };
}

export function generateFromSchema(options: SchemaGenerationContext): any {
  const { schema, count, overrides, params, state, query } = options;

  // Validate schema
  validateSchema(schema);

  let generated: any;

  // Handle array schemas with count
  if (schema.type === "array" && schema.items) {
    const itemCount = determineArrayCount(schema, count);

    // Check for resource limits
    if (itemCount > MAX_ARRAY_SIZE) {
      throw new Error(
        `Array size ${itemCount} exceeds maximum allowed size of ${MAX_ARRAY_SIZE}`,
      );
    }

    const itemSchema = Array.isArray(schema.items)
      ? schema.items[0]
      : schema.items;

    if (!itemSchema) {
      throw new Error("Array schema must have valid items definition");
    }

    generated = [];
    for (let i = 0; i < itemCount; i++) {
      let item = jsf.generate(
        enhanceSchemaWithSmartMapping(itemSchema as JSONSchema7),
      );
      item = applyOverrides(item, overrides, params, state, query);
      generated.push(item);
    }
  } else {
    // Handle object schemas
    const enhancedSchema = enhanceSchemaWithSmartMapping(schema);
    generated = jsf.generate(enhancedSchema);
    generated = applyOverrides(generated, overrides, params, state, query);
  }

  return generated;
}

function validateSchema(schema: JSONSchema7): void {
  if (!schema || typeof schema !== "object") {
    throw new Error("Schema must be a valid JSON Schema object");
  }

  if (Object.keys(schema).length === 0) {
    throw new Error("Schema cannot be empty");
  }

  // Check for invalid schema types
  if (schema.type && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type as string)) {
    throw new Error(`Invalid schema type: ${schema.type}`);
  }

  // Check for circular references (basic check)
  if (hasCircularReference(schema)) {
    throw new Error("Schema contains circular references which are not supported");
  }

  // Check nesting depth
  if (calculateNestingDepth(schema) > MAX_NESTING_DEPTH) {
    throw new Error(`Schema nesting depth exceeds maximum allowed depth of ${MAX_NESTING_DEPTH}`);
  }
}

function hasCircularReference(schema: JSONSchema7, visited = new Set()): boolean {
  if (visited.has(schema)) {
    return true;
  }

  visited.add(schema);

  if (schema.$ref === "#") {
    return true;
  }

  if (schema.type === "object" && schema.properties) {
    for (const prop of Object.values(schema.properties)) {
      if (typeof prop === "object" && prop !== null) {
        if (hasCircularReference(prop as JSONSchema7, new Set(visited))) {
          return true;
        }
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const item of items) {
      if (typeof item === "object" && item !== null) {
        if (hasCircularReference(item as JSONSchema7, new Set(visited))) {
          return true;
        }
      }
    }
  }

  return false;
}

function calculateNestingDepth(schema: JSONSchema7, depth = 0): number {
  if (depth > MAX_NESTING_DEPTH) {
    return depth;
  }

  let maxDepth = depth;

  if (schema.type === "object" && schema.properties) {
    for (const prop of Object.values(schema.properties)) {
      if (typeof prop === "object" && prop !== null) {
        maxDepth = Math.max(maxDepth, calculateNestingDepth(prop as JSONSchema7, depth + 1));
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const item of items) {
      if (typeof item === "object" && item !== null) {
        maxDepth = Math.max(maxDepth, calculateNestingDepth(item as JSONSchema7, depth + 1));
      }
    }
  }

  return maxDepth;
}

function determineArrayCount(
  schema: JSONSchema7,
  explicitCount?: number,
): number {
  if (explicitCount !== undefined) {
    // Handle negative or invalid counts
    if (explicitCount < 0) {
      return 0;
    }
    return explicitCount;
  }

  if (schema.minItems !== undefined && schema.maxItems !== undefined) {
    return (
      Math.floor(Math.random() * (schema.maxItems - schema.minItems + 1)) +
      schema.minItems
    );
  }

  if (schema.minItems !== undefined) {
    return Math.max(schema.minItems, 3);
  }

  if (schema.maxItems !== undefined) {
    return Math.min(schema.maxItems, 3);
  }

  return 3; // Default count
}

function applyOverrides(
  data: any,
  overrides?: Record<string, any>,
  params?: Record<string, string>,
  state?: any,
  query?: Record<string, string>,
): any {
  if (!overrides) return data;

  const result = { ...data };

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string" && value.includes("{{")) {
      // Template processing
      result[key] = processTemplate(value, { params, state, query });
    } else {
      result[key] = value;
    }
  }

  return result;
}

function processTemplate(
  template: string,
  context: {
    params?: Record<string, string>;
    state?: any;
    query?: Record<string, string>;
  },
): any {
  // Simple template processing for {{ params.id }}, {{ state.user.id }}, etc.
  const processed = template.replace(
    /\{\{\s*([^}]+)\s*\}\}/g,
    (match, expression) => {
      const parts = expression.trim().split(".");
      let result: any = context;

      for (const part of parts) {
        if (result && typeof result === "object") {
          result = result[part];
        } else {
          return match; // Return original if can't resolve
        }
      }

      return result !== undefined ? String(result) : match;
    },
  );

  // Try to convert to number if it's a numeric string
  if (/^\d+$/.test(processed)) {
    return Number.parseInt(processed, 10);
  }

  return processed;
}

function enhanceSchemaWithSmartMapping(schema: JSONSchema7): JSONSchema7 {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const enhanced = { ...schema };

  // Handle object properties
  if (enhanced.type === "object" && enhanced.properties) {
    enhanced.properties = { ...enhanced.properties };

    for (const [fieldName, fieldSchema] of Object.entries(
      enhanced.properties,
    )) {
      if (typeof fieldSchema === "object" && fieldSchema !== null) {
        enhanced.properties[fieldName] = enhanceFieldSchema(
          fieldName,
          fieldSchema as JSONSchema7,
        );
      }
    }
  }

  return enhanced;
}

function enhanceFieldSchema(
  fieldName: string,
  fieldSchema: JSONSchema7,
): JSONSchema7 {
  const enhanced = { ...fieldSchema };

  // If already has faker extension, don't override
  if ((enhanced as any).faker) {
    return enhanced;
  }

  // Apply smart field name mapping
  const lowerFieldName = fieldName.toLowerCase();

  // Email fields
  if (lowerFieldName.includes("email")) {
    enhanced.format = "email";
    (enhanced as any).faker = "internet.email";
  }
  // Name fields
  else if (lowerFieldName === "firstname" || lowerFieldName === "first_name") {
    (enhanced as any).faker = "person.firstName";
  } else if (lowerFieldName === "lastname" || lowerFieldName === "last_name") {
    (enhanced as any).faker = "person.lastName";
  } else if (lowerFieldName === "name" || lowerFieldName === "fullname") {
    (enhanced as any).faker = "person.fullName";
  }
  // Phone fields
  else if (lowerFieldName.includes("phone")) {
    (enhanced as any).faker = "phone.number";
  }
  // Address fields
  else if (lowerFieldName === "street" || lowerFieldName === "address") {
    (enhanced as any).faker = "location.streetAddress";
  } else if (lowerFieldName === "city") {
    (enhanced as any).faker = "location.city";
  } else if (lowerFieldName === "zipcode" || lowerFieldName === "zip") {
    (enhanced as any).faker = "location.zipCode";
  }
  // UUID fields
  else if (
    lowerFieldName === "uuid" ||
    (lowerFieldName === "id" && enhanced.format === "uuid")
  ) {
    (enhanced as any).faker = "string.uuid";
  }
  // Date fields
  else if (
    lowerFieldName.includes("createdat") ||
    lowerFieldName.includes("created_at")
  ) {
    enhanced.format = "date-time";
    (enhanced as any).faker = "date.recent";
  }
  // Company fields
  else if (lowerFieldName.includes("company")) {
    (enhanced as any).faker = "company.name";
  } else if (lowerFieldName === "position" || lowerFieldName === "jobtitle") {
    (enhanced as any).faker = "person.jobTitle";
  }
  // Price/money fields
  else if (lowerFieldName === "price" || lowerFieldName === "amount") {
    (enhanced as any).faker = "commerce.price";
  }

  return enhanced;
}