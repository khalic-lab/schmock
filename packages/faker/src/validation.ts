import type { Faker } from "@faker-js/faker";
import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import {
  DEEP_NESTING_THRESHOLD,
  DEFAULT_ARRAY_COUNT,
  LARGE_ARRAY_THRESHOLD,
  MAX_ARRAY_SIZE,
  MAX_NESTING_DEPTH,
} from "./constants.js";
import { createFakerInstance } from "./jsf-config.js";

let validationFaker: Faker | undefined;

export function isJSONSchema7(value: unknown): value is JSONSchema7 {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
export function validateSchema(schema: JSONSchema7, path = "$"): void {
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
  const validTypes = [
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null",
  ];
  if (
    schema.type &&
    typeof schema.type === "string" &&
    !validTypes.includes(schema.type)
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
        const fakerProp =
          "faker" in propSchema ? String(propSchema.faker) : undefined;
        if (fakerProp) {
          try {
            validateFakerMethod(fakerProp);
          } catch (error: unknown) {
            // Re-throw with proper path context
            if (error instanceof SchemaValidationError) {
              const ctx = error.context;
              let issue = "Invalid faker method";
              let suggestion: string | undefined;
              if (ctx && typeof ctx === "object") {
                if ("issue" in ctx && typeof ctx.issue === "string")
                  issue = ctx.issue;
                if ("suggestion" in ctx && typeof ctx.suggestion === "string")
                  suggestion = ctx.suggestion;
              }
              throw new SchemaValidationError(
                `${path}.properties.${propName}.faker`,
                issue,
                suggestion,
              );
            }
            if (error instanceof Error) throw error;
            throw new Error(String(error));
          }
        }
        validateSchema(propSchema, `${path}.properties.${propName}`);
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
          validateSchema(item, `${path}.items[${index}]`);
        }
      });
    } else if (typeof schema.items === "object" && schema.items !== null) {
      validateSchema(schema.items, `${path}.items`);
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
  if (depth >= DEEP_NESTING_THRESHOLD) {
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
      if (isJSONSchema7(prop)) {
        if (hasCircularReference(prop, currentPath)) {
          return true;
        }
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const item of items) {
      if (isJSONSchema7(item)) {
        if (hasCircularReference(item, currentPath)) {
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
      if (isJSONSchema7(prop)) {
        maxDepth = Math.max(maxDepth, calculateNestingDepth(prop, depth + 1));
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const item of items) {
      if (isJSONSchema7(item)) {
        maxDepth = Math.max(maxDepth, calculateNestingDepth(item, depth + 1));
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
    node: JSONSchema7,
    currentDepth: number,
  ): void {
    const schemaType = node.type;
    const isArray = Array.isArray(schemaType)
      ? schemaType.includes("array")
      : schemaType === "array";

    if (isArray) {
      const maxItems = node.maxItems || DEFAULT_ARRAY_COUNT;
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
      if (node.items) {
        const items = Array.isArray(node.items) ? node.items : [node.items];
        for (const item of items) {
          if (isJSONSchema7(item)) {
            findArraysInDeepNesting(item, currentDepth + 1);
          }
        }
      }
      return;
    }

    if (schemaType === "object" && node.properties) {
      for (const prop of Object.values(node.properties)) {
        if (isJSONSchema7(prop)) {
          findArraysInDeepNesting(prop, currentDepth + 1);
        }
      }
    }
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
      if (isJSONSchema7(propSchema)) {
        checkArraySizeLimits(propSchema, `${path}.properties.${propName}`);
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    if (Array.isArray(schema.items)) {
      schema.items.forEach((item, index) => {
        if (isJSONSchema7(item)) {
          checkArraySizeLimits(item, `${path}.items[${index}]`);
        }
      });
    } else if (isJSONSchema7(schema.items)) {
      checkArraySizeLimits(schema.items, `${path}.items`);
    }
  }
}

/**
 * Validate that faker method string references a valid Faker.js API
 * Checks format (namespace.method) and validates against known namespaces
 * @param fakerMethod - Faker method string (e.g., "person.fullName")
 * @throws {SchemaValidationError} When faker method format or namespace is invalid
 */
export function validateFakerMethod(fakerMethod: string): void {
  // Check if faker method follows valid format (namespace.method)
  const parts = fakerMethod.split(".");
  if (parts.length < 2) {
    throw new SchemaValidationError(
      "$.faker",
      `Invalid faker method format: "${fakerMethod}"`,
      "Use format like 'person.firstName' or 'internet.email'",
    );
  }

  // Validate by resolving the method path on a cached faker instance
  if (!validationFaker) {
    validationFaker = createFakerInstance();
  }
  const faker = validationFaker;
  let current: any = faker;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = current[part];
    } else {
      throw new SchemaValidationError(
        "$.faker",
        `Invalid faker method: "${fakerMethod}"`,
        "Check faker.js documentation for valid methods",
      );
    }
  }
  if (typeof current !== "function") {
    throw new SchemaValidationError(
      "$.faker",
      `Invalid faker method: "${fakerMethod}" is not a function`,
      "Check faker.js documentation for valid methods",
    );
  }
}
