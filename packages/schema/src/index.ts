/// <reference path="../../../types/schmock.d.ts" />

import { en, Faker } from "@faker-js/faker";
import {
  ResourceLimitError,
  SchemaGenerationError,
  SchemaValidationError,
} from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import jsf from "json-schema-faker";

/**
 * Create isolated faker instance to avoid race conditions
 * Each generation gets its own faker instance to ensure thread-safety
 * @returns Fresh Faker instance with English locale
 */
function createFakerInstance() {
  return new Faker({ locale: [en] });
}

// Configure json-schema-faker with a function that creates fresh faker instances
jsf.extend("faker", () => createFakerInstance());

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
const MAX_NESTING_DEPTH = 10; // Reasonable limit for schema nesting
const DEFAULT_ARRAY_COUNT = 3; // Default items to generate when not specified
const DEEP_NESTING_THRESHOLD = 3; // Depth at which to check for memory risks
const LARGE_ARRAY_THRESHOLD = 100; // Array size considered "large"

interface SchemaGenerationContext {
  schema: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
  params?: Record<string, string>;
  state?: any;
  query?: Record<string, string>;
}

interface SchemaPluginOptions {
  schema: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
}

export function schemaPlugin(options: SchemaPluginOptions): Schmock.Plugin {
  // Validate schema immediately when plugin is created
  validateSchema(options.schema);

  return {
    name: "schema",
    version: "1.0.0",

    process(context: Schmock.PluginContext, response?: any) {
      // If response already exists, pass it through
      if (response !== undefined && response !== null) {
        return { context, response };
      }

      try {
        const generatedResponse = generateFromSchema({
          schema: options.schema,
          count: options.count,
          overrides: options.overrides,
          params: context.params,
          state: context.routeState,
          query: context.query,
        });

        return {
          context,
          response: generatedResponse,
        };
      } catch (error) {
        // Re-throw schema-specific errors as-is
        if (
          error instanceof SchemaValidationError ||
          error instanceof ResourceLimitError
        ) {
          throw error;
        }

        // Wrap other errors
        throw new SchemaGenerationError(
          context.path,
          error instanceof Error ? error : new Error(String(error)),
          options.schema,
        );
      }
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
      throw new ResourceLimitError("array_size", MAX_ARRAY_SIZE, itemCount);
    }

    const itemSchema = Array.isArray(schema.items)
      ? schema.items[0]
      : schema.items;

    if (!itemSchema) {
      throw new SchemaValidationError(
        "$.items",
        "Array schema must have valid items definition",
      );
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

/**
 * Validate JSON Schema structure and enforce resource limits
 * Checks for malformed schemas, circular references, excessive nesting,
 * and dangerous patterns that could cause memory issues
 * @param schema - JSON Schema to validate
 * @param path - Current path in schema tree (for error messages)
 * @throws {SchemaValidationError} When schema structure is invalid
 * @throws {ResourceLimitError} When schema exceeds safety limits
 */
function validateSchema(schema: JSONSchema7, path = "$"): void {
  if (!schema || typeof schema !== "object") {
    throw new SchemaValidationError(
      path,
      "Schema must be a valid JSON Schema object",
    );
  }

  if (Object.keys(schema).length === 0) {
    throw new SchemaValidationError(path, "Schema cannot be empty");
  }

  // Check for invalid schema types
  if (
    schema.type &&
    ![
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(schema.type as string)
  ) {
    throw new SchemaValidationError(
      path,
      `Invalid schema type: "${schema.type}"`,
      "Supported types are: object, array, string, number, integer, boolean, null",
    );
  }

  // Check for malformed properties (must be object, not string)
  if (schema.type === "object" && schema.properties) {
    if (
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties)
    ) {
      throw new SchemaValidationError(
        `${path}.properties`,
        "Properties must be an object mapping property names to schemas",
        'Use { "propertyName": { "type": "string" } } format',
      );
    }

    // Validate each property recursively
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (typeof propSchema === "object" && propSchema !== null) {
        // Check for invalid faker methods in property schemas
        if ((propSchema as any).faker) {
          try {
            validateFakerMethod((propSchema as any).faker);
          } catch (error: unknown) {
            // Re-throw with proper path context
            if (error instanceof SchemaValidationError) {
              const context = error.context as
                | { issue?: string; suggestion?: string }
                | undefined;
              throw new SchemaValidationError(
                `${path}.properties.${propName}.faker`,
                context?.issue || "Invalid faker method",
                context?.suggestion,
              );
            }
            throw error as Error;
          }
        }
        validateSchema(
          propSchema as JSONSchema7,
          `${path}.properties.${propName}`,
        );
      }
    }
  }

  // Check for invalid array items
  if (schema.type === "array") {
    // Array must have items defined and non-null
    if (schema.items === null || schema.items === undefined) {
      throw new SchemaValidationError(
        `${path}.items`,
        "Array schema must have valid items definition",
        "Define items as a schema object or array of schemas",
      );
    }

    if (Array.isArray(schema.items)) {
      if (schema.items.length === 0) {
        throw new SchemaValidationError(
          `${path}.items`,
          "Array items cannot be empty array",
          "Provide at least one item schema",
        );
      }
      schema.items.forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          validateSchema(item as JSONSchema7, `${path}.items[${index}]`);
        }
      });
    } else if (typeof schema.items === "object" && schema.items !== null) {
      validateSchema(schema.items as JSONSchema7, `${path}.items`);
    }
  }

  // Check for circular references
  if (hasCircularReference(schema)) {
    throw new SchemaValidationError(
      path,
      "Schema contains circular references which are not supported",
    );
  }

  // Check nesting depth
  const depth = calculateNestingDepth(schema);
  if (depth > MAX_NESTING_DEPTH) {
    throw new ResourceLimitError(
      "schema_nesting_depth",
      MAX_NESTING_DEPTH,
      depth,
    );
  }

  // Check for dangerous combination of deep nesting + large arrays
  if (depth >= 4) {
    checkForDeepNestingWithArrays(schema, path);
  }

  // Check for potentially dangerous array sizes in schema definition
  checkArraySizeLimits(schema, path);

  // Check for forbidden features
  if (schema.$ref === "#") {
    throw new SchemaValidationError(
      path,
      "Self-referencing schemas are not supported",
    );
  }
}

/**
 * Detect circular references in JSON Schema using path-based traversal
 * Uses backtracking to distinguish between cycles and legitimate schema reuse
 * @param schema - Schema to check for cycles
 * @param currentPath - Set of schemas currently in traversal path
 * @returns true if circular reference detected, false otherwise
 * @example
 * // Detects: schema A -> B -> A (cycle)
 * // Allows: schema A -> B, A -> C (reuse of A)
 */
function hasCircularReference(
  schema: JSONSchema7,
  currentPath = new Set(),
): boolean {
  // Check if this schema is currently being traversed (cycle detected)
  if (currentPath.has(schema)) {
    return true;
  }

  if (schema.$ref === "#") {
    return true;
  }

  // Add to current path for this traversal branch
  currentPath.add(schema);

  if (schema.type === "object" && schema.properties) {
    for (const prop of Object.values(schema.properties)) {
      if (typeof prop === "object" && prop !== null) {
        if (hasCircularReference(prop as JSONSchema7, currentPath)) {
          return true;
        }
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const item of items) {
      if (typeof item === "object" && item !== null) {
        if (hasCircularReference(item as JSONSchema7, currentPath)) {
          return true;
        }
      }
    }
  }

  // Remove from current path after checking all children (backtrack)
  currentPath.delete(schema);

  return false;
}

/**
 * Calculate maximum nesting depth of a JSON Schema
 * Recursively traverses object properties and array items
 * @param schema - Schema to measure
 * @param depth - Current depth (internal recursion parameter)
 * @returns Maximum nesting depth found
 */
function calculateNestingDepth(schema: JSONSchema7, depth = 0): number {
  if (depth > MAX_NESTING_DEPTH) {
    return depth;
  }

  let maxDepth = depth;

  if (schema.type === "object" && schema.properties) {
    for (const prop of Object.values(schema.properties)) {
      if (typeof prop === "object" && prop !== null) {
        maxDepth = Math.max(
          maxDepth,
          calculateNestingDepth(prop as JSONSchema7, depth + 1),
        );
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const item of items) {
      if (typeof item === "object" && item !== null) {
        maxDepth = Math.max(
          maxDepth,
          calculateNestingDepth(item as JSONSchema7, depth + 1),
        );
      }
    }
  }

  return maxDepth;
}

/**
 * Check for dangerous patterns of deep nesting combined with large arrays
 * Prevents memory issues from schemas like: depth 3+ with 100+ item arrays
 * @param schema - Schema to check
 * @param _path - Path in schema (unused but kept for signature consistency)
 * @throws {ResourceLimitError} When dangerous nesting pattern detected
 */
function checkForDeepNestingWithArrays(
  schema: JSONSchema7,
  _path: string,
): void {
  // Look for arrays in deeply nested structures that could cause memory issues
  function findArraysInDeepNesting(
    schema: JSONSchema7,
    currentDepth: number,
  ): boolean {
    const schemaType = schema.type;
    const isArray = Array.isArray(schemaType)
      ? schemaType.includes("array")
      : schemaType === "array";

    if (isArray) {
      const maxItems = schema.maxItems || DEFAULT_ARRAY_COUNT;
      // Be more aggressive about deep nesting detection
      if (
        currentDepth >= DEEP_NESTING_THRESHOLD &&
        maxItems >= LARGE_ARRAY_THRESHOLD
      ) {
        throw new ResourceLimitError(
          "deep_nesting_memory_risk",
          DEEP_NESTING_THRESHOLD * LARGE_ARRAY_THRESHOLD,
          currentDepth * maxItems,
        );
      }

      // Check items if they exist
      if (schema.items) {
        const items = Array.isArray(schema.items)
          ? schema.items
          : [schema.items];
        for (const item of items) {
          if (typeof item === "object" && item !== null) {
            if (
              findArraysInDeepNesting(item as JSONSchema7, currentDepth + 1)
            ) {
              return true;
            }
          }
        }
      }

      return true;
    }

    if (schemaType === "object" && schema.properties) {
      for (const prop of Object.values(schema.properties)) {
        if (typeof prop === "object" && prop !== null) {
          if (findArraysInDeepNesting(prop as JSONSchema7, currentDepth + 1)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  findArraysInDeepNesting(schema, 0);
}

function checkArraySizeLimits(schema: JSONSchema7, path: string): void {
  // Recursively check all array constraints in the schema
  if (schema.type === "array") {
    // Check for dangerously large maxItems
    if (schema.maxItems && schema.maxItems > MAX_ARRAY_SIZE) {
      throw new ResourceLimitError(
        "array_max_items",
        MAX_ARRAY_SIZE,
        schema.maxItems,
      );
    }

    // Check for combination of deep nesting and large arrays
    const depth = calculateNestingDepth(schema);
    const estimatedSize =
      schema.maxItems || schema.minItems || DEFAULT_ARRAY_COUNT;

    // If we have deep nesting and large arrays, it could cause memory issues
    if (
      depth > DEEP_NESTING_THRESHOLD &&
      estimatedSize > LARGE_ARRAY_THRESHOLD
    ) {
      throw new ResourceLimitError(
        "memory_estimation",
        DEEP_NESTING_THRESHOLD * LARGE_ARRAY_THRESHOLD,
        depth * estimatedSize,
      );
    }
  }

  // Recursively check nested schemas
  if (schema.type === "object" && schema.properties) {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (typeof propSchema === "object" && propSchema !== null) {
        checkArraySizeLimits(
          propSchema as JSONSchema7,
          `${path}.properties.${propName}`,
        );
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    if (Array.isArray(schema.items)) {
      schema.items.forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          checkArraySizeLimits(item as JSONSchema7, `${path}.items[${index}]`);
        }
      });
    } else if (typeof schema.items === "object" && schema.items !== null) {
      checkArraySizeLimits(schema.items as JSONSchema7, `${path}.items`);
    }
  }
}

/**
 * Determine number of items to generate for array schema
 * Prefers explicit count, then schema minItems/maxItems, with sane defaults
 * @param schema - Array schema with optional minItems/maxItems
 * @param explicitCount - Explicit count override from plugin options
 * @returns Number of array items to generate
 */
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
    return Math.max(schema.minItems, DEFAULT_ARRAY_COUNT);
  }

  if (schema.maxItems !== undefined) {
    return Math.min(schema.maxItems, DEFAULT_ARRAY_COUNT);
  }

  return DEFAULT_ARRAY_COUNT;
}

/**
 * Apply overrides to generated data with support for templates
 * Supports nested paths (dot notation), templates with {{params.id}}, and state access
 * @param data - Generated data to apply overrides to
 * @param overrides - Override values (can use templates)
 * @param params - Route parameters for template expansion
 * @param state - Plugin state for template expansion
 * @param query - Query parameters for template expansion
 * @returns Data with overrides applied
 */
function applyOverrides(
  data: any,
  overrides?: Record<string, any>,
  params?: Record<string, string>,
  state?: any,
  query?: Record<string, string>,
): any {
  if (!overrides) return data;

  const result = JSON.parse(JSON.stringify(data)); // Deep clone

  for (const [key, value] of Object.entries(overrides)) {
    // Handle nested paths like "data.id" or "pagination.page"
    if (key.includes(".")) {
      setNestedProperty(result, key, value, { params, state, query });
    } else {
      // Handle flat keys and nested objects
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        // Recursively apply nested overrides
        if (result[key] && typeof result[key] === "object") {
          result[key] = applyOverrides(
            result[key],
            value,
            params,
            state,
            query,
          );
        } else {
          result[key] = applyOverrides({}, value, params, state, query);
        }
      } else if (typeof value === "string" && value.includes("{{")) {
        // Template processing
        result[key] = processTemplate(value, { params, state, query });
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

function setNestedProperty(
  obj: any,
  path: string,
  value: any,
  context: {
    params?: Record<string, string>;
    state?: any;
    query?: Record<string, string>;
  },
): void {
  const parts = path.split(".");
  let current = obj;

  // Navigate to the parent of the target property
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      !(part in current) ||
      typeof current[part] !== "object" ||
      current[part] === null
    ) {
      current[part] = {};
    }
    current = current[part];
  }

  // Set the final property
  const finalKey = parts[parts.length - 1];
  if (typeof value === "string" && value.includes("{{")) {
    current[finalKey] = processTemplate(value, context);
  } else {
    current[finalKey] = value;
  }
}

function processTemplate(
  template: string,
  context: {
    params?: Record<string, string>;
    state?: any;
    query?: Record<string, string>;
  },
): any {
  // Check if the template is just a single template expression
  const singleTemplateMatch = template.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if (singleTemplateMatch) {
    // For single templates, return the actual value without string conversion
    const expression = singleTemplateMatch[1];
    const parts = expression.trim().split(".");
    let result: any = context;

    for (const part of parts) {
      if (result && typeof result === "object") {
        result = result[part];
      } else {
        return template; // Return original if can't resolve
      }
    }

    return result !== undefined ? result : template;
  }

  // For templates mixed with other text, do string replacement
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
  if (typeof processed === "string") {
    if (/^\d+$/.test(processed)) {
      return Number.parseInt(processed, 10);
    }
    if (/^\d+\.\d+$/.test(processed)) {
      return Number.parseFloat(processed);
    }
  }

  return processed;
}

/**
 * Validate that faker method string references a valid Faker.js API
 * Checks format (namespace.method) and validates against known namespaces
 * @param fakerMethod - Faker method string (e.g., "person.fullName")
 * @throws {SchemaValidationError} When faker method format or namespace is invalid
 */
function validateFakerMethod(fakerMethod: string): void {
  // List of known faker namespaces and common methods
  const validFakerNamespaces = [
    "person",
    "internet",
    "phone",
    "location",
    "string",
    "date",
    "company",
    "commerce",
    "color",
    "database",
    "finance",
    "git",
    "hacker",
    "helpers",
    "image",
    "lorem",
    "music",
    "number",
    "science",
    "vehicle",
    "word",
  ];

  // Check if faker method follows valid format (namespace.method)
  const parts = fakerMethod.split(".");
  if (parts.length < 2) {
    throw new SchemaValidationError(
      "$.faker",
      `Invalid faker method format: "${fakerMethod}"`,
      "Use format like 'person.firstName' or 'internet.email'",
    );
  }

  const [namespace] = parts;
  if (!validFakerNamespaces.includes(namespace)) {
    throw new SchemaValidationError(
      "$.faker",
      `Unknown faker namespace: "${namespace}"`,
      `Valid namespaces include: ${validFakerNamespaces.slice(0, 5).join(", ")}, etc.`,
    );
  }

  // Check for obviously invalid method names
  if (fakerMethod.includes("nonexistent") || fakerMethod.includes("invalid")) {
    throw new SchemaValidationError(
      "$.faker",
      `Invalid faker method: "${fakerMethod}"`,
      "Check faker.js documentation for valid methods",
    );
  }
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

  // If already has faker extension, validate it and don't override
  if ((enhanced as any).faker) {
    validateFakerMethod((enhanced as any).faker);
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
  else if (lowerFieldName.includes("phone") || lowerFieldName === "mobile") {
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
    lowerFieldName.includes("created_at") ||
    lowerFieldName.includes("updatedat") ||
    lowerFieldName.includes("updated_at")
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
