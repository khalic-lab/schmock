import { en, Faker } from "@faker-js/faker";
import type { Plugin, PluginContext } from "@schmock/core";
import {
  ResourceLimitError,
  SchemaGenerationError,
  SchemaValidationError,
} from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import jsf from "json-schema-faker";

function isJSONSchema7(value: unknown): value is JSONSchema7 {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSONSchema7 extended with json-schema-faker's `faker` property */
interface FakerSchema extends JSONSchema7 {
  faker?: string;
}

/**
 * Create isolated faker instance to avoid race conditions
 * Each generation gets its own faker instance to ensure thread-safety
 * @returns Fresh Faker instance with English locale
 */
function createFakerInstance(seed?: number) {
  const faker = new Faker({ locale: [en] });
  if (seed !== undefined) {
    faker.seed(seed);
  }
  return faker;
}

let jsfConfigured = false;
let currentSeed: number | undefined;

/**
 * Create a seeded PRNG using the mulberry32 algorithm.
 * Returns a function that produces deterministic values in [0, 1).
 */
function createSeededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getJsf(seed?: number) {
  const seedChanged = seed !== currentSeed;
  if (!jsfConfigured || seedChanged) {
    currentSeed = seed;
    jsf.extend("faker", () => createFakerInstance(seed));
    jsf.option({
      requiredOnly: false,
      alwaysFakeOptionals: true,
      useDefaultValue: true,
      ignoreMissingRefs: true,
      failOnInvalidTypes: false,
      failOnInvalidFormat: false,
    });
    jsfConfigured = true;
  }
  // Always reset PRNG for deterministic output per call
  if (seed !== undefined) {
    jsf.option({ random: createSeededRandom(seed) });
    jsf.extend("faker", () => createFakerInstance(seed));
  }
  return jsf;
}

// Resource limits for safety
const MAX_ARRAY_SIZE = 10000;
const MAX_NESTING_DEPTH = 10; // Reasonable limit for schema nesting
const DEFAULT_ARRAY_COUNT = 3; // Default items to generate when not specified
const DEEP_NESTING_THRESHOLD = 3; // Depth at which to check for memory risks
const LARGE_ARRAY_THRESHOLD = 100; // Array size considered "large"

export interface SchemaGenerationContext {
  schema: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
  params?: Record<string, string>;
  state?: any;
  query?: Record<string, string>;
  seed?: number;
}

export interface FakerPluginOptions {
  schema: JSONSchema7;
  count?: number;
  overrides?: Record<string, any>;
  seed?: number;
}

export function fakerPlugin(options: FakerPluginOptions): Plugin {
  // Validate schema immediately when plugin is created
  validateSchema(options.schema);

  return {
    name: "faker",
    version: "1.0.1",

    process(context: PluginContext, response?: any) {
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
          seed: options.seed,
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
  const { schema, count, overrides, params, state, query, seed } = options;

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

    const rawItemSchema = Array.isArray(schema.items)
      ? schema.items[0]
      : schema.items;

    if (!rawItemSchema || typeof rawItemSchema === "boolean") {
      throw new SchemaValidationError(
        "$.items",
        "Array schema must have valid items definition",
      );
    }

    const itemSchema = rawItemSchema;

    generated = [];
    for (let i = 0; i < itemCount; i++) {
      let item = getJsf(seed).generate(
        enhanceSchemaWithSmartMapping(itemSchema),
      );
      item = applyOverrides(item, overrides, params, state, query);
      generated.push(item);
    }
  } else {
    // Handle object schemas
    const enhancedSchema = enhanceSchemaWithSmartMapping(schema);
    generated = getJsf(seed).generate(enhancedSchema);
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
  ): boolean {
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
            if (findArraysInDeepNesting(item, currentDepth + 1)) {
              return true;
            }
          }
        }
      }

      return true;
    }

    if (schemaType === "object" && node.properties) {
      for (const prop of Object.values(node.properties)) {
        if (isJSONSchema7(prop)) {
          if (findArraysInDeepNesting(prop, currentDepth + 1)) {
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

  const result = structuredClone(data);

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

  return processed;
}

/**
 * Validate that faker method string references a valid Faker.js API
 * Checks format (namespace.method) and validates against known namespaces
 * @param fakerMethod - Faker method string (e.g., "person.fullName")
 * @throws {SchemaValidationError} When faker method format or namespace is invalid
 */
function validateFakerMethod(fakerMethod: string): void {
  // Check if faker method follows valid format (namespace.method)
  const parts = fakerMethod.split(".");
  if (parts.length < 2) {
    throw new SchemaValidationError(
      "$.faker",
      `Invalid faker method format: "${fakerMethod}"`,
      "Use format like 'person.firstName' or 'internet.email'",
    );
  }

  // Validate by resolving the method path on a real faker instance
  const faker = createFakerInstance();
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
      if (isJSONSchema7(fieldSchema)) {
        enhanced.properties[fieldName] = enhanceFieldSchema(
          fieldName,
          fieldSchema,
        );
      }
    }
  }

  return enhanced;
}

function enhanceFieldSchema(
  fieldName: string,
  fieldSchema: JSONSchema7,
): FakerSchema {
  const enhanced: FakerSchema = { ...fieldSchema };

  // If already has faker extension, validate it and don't override
  if (enhanced.faker) {
    validateFakerMethod(enhanced.faker);
    return enhanced;
  }

  // Apply smart field name mapping
  const lowerFieldName = fieldName.toLowerCase();

  // Email fields
  if (lowerFieldName.includes("email")) {
    enhanced.format = "email";
    enhanced.faker = "internet.email";
  }
  // Name fields
  else if (lowerFieldName === "firstname" || lowerFieldName === "first_name") {
    enhanced.faker = "person.firstName";
  } else if (lowerFieldName === "lastname" || lowerFieldName === "last_name") {
    enhanced.faker = "person.lastName";
  } else if (lowerFieldName === "name" || lowerFieldName === "fullname") {
    enhanced.faker = "person.fullName";
  }
  // Phone fields
  else if (lowerFieldName.includes("phone") || lowerFieldName === "mobile") {
    enhanced.faker = "phone.number";
  }
  // Address fields
  else if (lowerFieldName === "street" || lowerFieldName === "address") {
    enhanced.faker = "location.streetAddress";
  } else if (lowerFieldName === "city") {
    enhanced.faker = "location.city";
  } else if (lowerFieldName === "zipcode" || lowerFieldName === "zip") {
    enhanced.faker = "location.zipCode";
  }
  // UUID fields
  else if (
    lowerFieldName === "uuid" ||
    (lowerFieldName === "id" && enhanced.format === "uuid")
  ) {
    enhanced.faker = "string.uuid";
  }
  // Date fields
  else if (
    lowerFieldName.includes("createdat") ||
    lowerFieldName.includes("created_at") ||
    lowerFieldName.includes("updatedat") ||
    lowerFieldName.includes("updated_at")
  ) {
    enhanced.format = "date-time";
    enhanced.faker = "date.recent";
  }
  // Company fields
  else if (lowerFieldName.includes("company")) {
    enhanced.faker = "company.name";
  } else if (lowerFieldName === "position" || lowerFieldName === "jobtitle") {
    enhanced.faker = "person.jobTitle";
  }
  // Price/money fields
  else if (lowerFieldName === "price" || lowerFieldName === "amount") {
    enhanced.faker = "commerce.price";
  }

  return enhanced;
}
