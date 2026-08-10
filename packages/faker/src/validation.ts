import type { Faker } from "@faker-js/faker";
import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import {
  DEEP_NESTING_THRESHOLD,
  DEFAULT_ARRAY_COUNT,
  LARGE_ARRAY_THRESHOLD,
  MAX_ARRAY_SIZE,
  MAX_GENERATED_NODES,
  MAX_NESTING_DEPTH,
  MAX_SCHEMA_NODES,
} from "./constants.js";
import { createFakerInstance } from "./jsf-config.js";

let validationFaker: Faker | undefined;

/**
 * Composition, `$defs` and `dependencies` describe the same value level, so
 * they deliberately do not count towards MAX_NESTING_DEPTH. This separate cap
 * keeps a pathologically chained composition from overflowing the stack.
 */
const MAX_COMPOSITION_FRAMES = 200;

/** JSONSchema7 extended with json-schema-faker's `faker` property. */
type FakerAwareSchema = JSONSchema7 & { faker?: unknown };

export function isJSONSchema7(value: unknown): value is JSONSchema7 {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type-aware check that tolerates the union form the OpenAPI normalizer emits
 * for nullable schemas (`type: ["array", "null"]`).
 */
export function hasType(schema: { type?: unknown }, type: string): boolean {
  return (
    schema.type === type ||
    (Array.isArray(schema.type) && schema.type.includes(type))
  );
}

/** A resource limit breach recorded during the walk, thrown once it finishes. */
interface Violation {
  resource: string;
  limit: number;
  actual: number;
}

/** What a walked sub-schema contributes to its parent. */
interface Estimate {
  /** Height of the generated value tree below this node (0 for a scalar). */
  height: number;
  /** Estimated number of JSON nodes this sub-schema generates. */
  nodes: number;
}

const LEAF: Estimate = { height: 0, nodes: 1 };

interface WalkState {
  /** Schema nodes visited; a node reached twice counts twice. */
  visited: number;
  /** Set on re-entry of a node already on the current descent path. */
  circular: boolean;
  /** Nodes on the current descent path, used for cycle detection. */
  descent: Set<JSONSchema7>;
  deepArray?: Violation;
  arraySize?: Violation;
  memory?: Violation;
  composition?: Violation;
}

/**
 * Validate JSON Schema structure and enforce resource limits.
 *
 * Walks every schema-bearing keyword exactly once — `properties`,
 * `patternProperties`, `additionalProperties`, `propertyNames`, `items` (object
 * and tuple forms), `additionalItems`, `contains`, `allOf`/`anyOf`/`oneOf`,
 * `not`, `if`/`then`/`else`, `definitions`, `$defs` and the schema form of
 * `dependencies` — checking structure, faker methods, cycles, nesting depth,
 * array sizes and the generation budgets on that single traversal, so
 * validation stays O(nodes).
 *
 * `$ref` is never resolved: a referenced sub-schema is validated where it is
 * declared, and an unresolvable reference is left for json-schema-faker to
 * report.
 *
 * @param schema - JSON Schema to validate
 * @param path - Path label used in error messages
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

  const state: WalkState = {
    visited: 0,
    circular: false,
    descent: new Set(),
  };

  // Structural and faker errors throw from inside the walk; whole-schema
  // limits are collected and reported afterwards, in the order they have
  // always been reported in.
  const root = walkSchema(schema, path, 0, 0, state, true);

  if (state.circular) {
    throw new SchemaValidationError(
      path,
      "Schema contains circular references which are not supported",
    );
  }

  if (schema.$ref === "#") {
    throw new SchemaValidationError(
      path,
      "Self-referencing schemas are not supported",
    );
  }

  if (root.height > MAX_NESTING_DEPTH) {
    throw new ResourceLimitError(
      "schema_nesting_depth",
      MAX_NESTING_DEPTH,
      root.height,
    );
  }

  for (const violation of [
    state.composition,
    state.deepArray,
    state.arraySize,
    state.memory,
  ]) {
    if (violation) {
      throw new ResourceLimitError(
        violation.resource,
        violation.limit,
        violation.actual,
      );
    }
  }

  if (root.nodes > MAX_GENERATED_NODES) {
    throw new ResourceLimitError(
      "generated_nodes",
      MAX_GENERATED_NODES,
      root.nodes,
    );
  }
}

/**
 * Walk one schema node: validate it, record any limit breach, then descend.
 *
 * @param depth - Distance from the root in generated-document levels
 * @param frames - Composition/definition frames crossed to reach this node
 * @param typedChain - True while the node is reachable from the root through
 *   nothing but `properties` of a `type: "object"` and `items` of a
 *   `type: "array"`. `{}` is a legal JSON Schema meaning "anything", so the
 *   "Schema cannot be empty" guard stays confined to that chain — the surface
 *   it has always covered. Rejecting `{}` in the newly-walked positions would
 *   fail real specs (a `oneOf` branch with an open-ended property, for one).
 */
function walkSchema(
  schema: JSONSchema7,
  path: string,
  depth: number,
  frames: number,
  state: WalkState,
  typedChain: boolean,
): Estimate {
  if (state.descent.has(schema)) {
    state.circular = true;
    return LEAF;
  }

  state.visited += 1;
  if (state.visited > MAX_SCHEMA_NODES) {
    throw new ResourceLimitError(
      "schema_nodes",
      MAX_SCHEMA_NODES,
      state.visited,
    );
  }

  validateNode(schema, path, typedChain);

  if (schema.$ref === "#") {
    state.circular = true;
  }

  // Past the advertised depth the schema is rejected anyway, so stop descending
  // rather than risk a stack overflow on a pathologically deep schema. The
  // height a breaching schema reports is therefore MAX_NESTING_DEPTH + 1 — a
  // floor on its real height, not a measurement of it.
  if (depth > MAX_NESTING_DEPTH) {
    return { height: 0, nodes: 1 };
  }

  if (frames > MAX_COMPOSITION_FRAMES) {
    state.composition ??= {
      resource: "schema_composition_depth",
      limit: MAX_COMPOSITION_FRAMES,
      actual: frames,
    };
    return { height: 0, nodes: 1 };
  }

  state.descent.add(schema);
  const estimate = descend(schema, path, depth, frames, state, typedChain);
  state.descent.delete(schema);

  return estimate;
}

/** Walk a `JSONSchema7Definition`, treating the boolean form as a leaf. */
function walkDefinition(
  definition: unknown,
  path: string,
  depth: number,
  frames: number,
  state: WalkState,
  typedChain: boolean,
): Estimate {
  if (!isJSONSchema7(definition)) {
    return LEAF;
  }
  return walkSchema(definition, path, depth, frames, state, typedChain);
}

function descend(
  schema: JSONSchema7,
  path: string,
  depth: number,
  frames: number,
  state: WalkState,
  typedChain: boolean,
): Estimate {
  const valueDepth = depth + 1;
  let height = 0;
  let nodes = 1;

  const walkValue = (
    definition: JSONSchema7Definition | undefined,
    childPath: string,
    childTypedChain = false,
  ): Estimate => {
    const child = walkDefinition(
      definition,
      childPath,
      valueDepth,
      frames,
      state,
      childTypedChain,
    );
    height = Math.max(height, child.height + 1);
    return child;
  };

  if (isArrayLike(schema)) {
    const itemChain = typedChain && schema.type === "array";
    const count = effectiveArrayCount(schema);
    recordArrayLimits(schema, count, depth, state);

    let itemNodes = 0;
    if (Array.isArray(schema.items)) {
      schema.items.forEach((item, index) => {
        itemNodes += walkValue(
          item,
          `${path}.items[${index}]`,
          itemChain,
        ).nodes;
      });
      const additional =
        schema.additionalItems === undefined
          ? LEAF
          : walkValue(schema.additionalItems, `${path}.additionalItems`);
      itemNodes += Math.max(0, count - schema.items.length) * additional.nodes;
    } else if (schema.items !== undefined) {
      itemNodes =
        count * walkValue(schema.items, `${path}.items`, itemChain).nodes;
    } else {
      itemNodes = count;
    }

    if (schema.contains !== undefined) {
      walkValue(schema.contains, `${path}.contains`);
    }

    nodes = capped(nodes + itemNodes);
  }

  if (schema.properties) {
    const propertyChain = typedChain && schema.type === "object";
    for (const [name, property] of Object.entries(schema.properties)) {
      nodes = capped(
        nodes +
          walkValue(property, `${path}.properties.${name}`, propertyChain)
            .nodes,
      );
    }
  }

  if (schema.patternProperties) {
    for (const [pattern, property] of Object.entries(
      schema.patternProperties,
    )) {
      nodes = capped(
        nodes +
          walkValue(property, `${path}.patternProperties.${pattern}`).nodes,
      );
    }
  }

  // Validated and counted for depth, but json-schema-faker decides how many
  // extra properties (if any) to emit, so they add no estimated nodes.
  if (schema.additionalProperties !== undefined) {
    walkValue(schema.additionalProperties, `${path}.additionalProperties`);
  }
  if (schema.propertyNames !== undefined) {
    walkDefinition(
      schema.propertyNames,
      `${path}.propertyNames`,
      valueDepth,
      frames,
      state,
      false,
    );
  }

  // Composition and definitions describe the same value level: they add
  // frames, not depth.
  const sibling = (definition: unknown, childPath: string): Estimate => {
    const child = walkDefinition(
      definition,
      childPath,
      depth,
      frames + 1,
      state,
      false,
    );
    height = Math.max(height, child.height);
    return child;
  };

  if (schema.allOf) {
    // allOf branches merge into one value, so each contributes its own
    // sub-tree minus its container node.
    schema.allOf.forEach((branch, index) => {
      nodes = capped(
        nodes + sibling(branch, `${path}.allOf[${index}]`).nodes - 1,
      );
    });
  }

  let alternative = 0;
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!branches) continue;
    branches.forEach((branch, index) => {
      const child = sibling(branch, `${path}.${keyword}[${index}]`);
      alternative = Math.max(alternative, child.nodes - 1);
    });
  }
  nodes = capped(nodes + alternative);

  if (schema.if !== undefined) {
    sibling(schema.if, `${path}.if`);
  }
  let conditional = 0;
  for (const keyword of ["then", "else"] as const) {
    const branch = schema[keyword];
    if (branch === undefined) continue;
    conditional = Math.max(
      conditional,
      sibling(branch, `${path}.${keyword}`).nodes - 1,
    );
  }
  nodes = capped(nodes + conditional);

  if (schema.not !== undefined) {
    sibling(schema.not, `${path}.not`);
  }

  for (const keyword of ["definitions", "$defs"] as const) {
    // `$defs` is a 2019-09 keyword absent from the Draft 7 type, so the bag is
    // read reflectively and narrowed by the guard rather than asserted.
    const definitions: unknown =
      keyword === "definitions"
        ? schema.definitions
        : Reflect.get(schema, "$defs");
    if (!isJSONSchema7(definitions)) continue;
    const entries: [string, unknown][] = Object.entries(definitions);
    for (const [name, definition] of entries) {
      // A definition is only generated where it is referenced, and `$ref` is
      // never resolved here, so definitions add depth coverage but no
      // estimated nodes.
      sibling(definition, `${path}.${keyword}.${name}`);
    }
  }

  if (schema.dependencies) {
    for (const [name, dependency] of Object.entries(schema.dependencies)) {
      // The string-array form lists required property names, not a schema.
      if (Array.isArray(dependency)) continue;
      sibling(dependency, `${path}.dependencies.${name}`);
    }
  }

  recordMemoryEstimate(schema, height, state);

  return { height, nodes };
}

/** Per-node structural validation. */
function validateNode(
  schema: FakerAwareSchema,
  path: string,
  typedChain: boolean,
): void {
  if (typedChain && Object.keys(schema).length === 0) {
    throw new SchemaValidationError(path, "Schema cannot be empty");
  }

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

  // Malformed properties (must be an object, not a string)
  if (
    schema.properties !== undefined &&
    (typeof schema.properties !== "object" || Array.isArray(schema.properties))
  ) {
    throw new SchemaValidationError(
      `${path}.properties`,
      "Properties must be an object mapping property names to schemas",
      'Use { "propertyName": { "type": "string" } } format',
    );
  }

  if (schema.type === "array") {
    if (schema.items === null || schema.items === undefined) {
      throw new SchemaValidationError(
        `${path}.items`,
        "Array schema must have valid items definition",
        "Define items as a schema object or array of schemas",
      );
    }

    if (Array.isArray(schema.items) && schema.items.length === 0) {
      throw new SchemaValidationError(
        `${path}.items`,
        "Array items cannot be empty array",
        "Provide at least one item schema",
      );
    }
  }

  // The `faker` extension is honored by json-schema-faker at every depth, so
  // it is validated at every depth.
  if ("faker" in schema && schema.faker !== undefined) {
    try {
      validateFakerMethod(String(schema.faker));
    } catch (error: unknown) {
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
        throw new SchemaValidationError(`${path}.faker`, issue, suggestion);
      }
      if (error instanceof Error) throw error;
      throw new Error(String(error));
    }
  }
}

function isArrayLike(schema: JSONSchema7): boolean {
  return (
    hasType(schema, "array") ||
    schema.items !== undefined ||
    schema.minItems !== undefined ||
    schema.maxItems !== undefined
  );
}

/**
 * How many items json-schema-faker will emit for an array. With
 * `optionalsProbability: 1.0` it fills up to `maxItems`, falls back to
 * `minItems`, and otherwise emits DEFAULT_ARRAY_COUNT.
 */
function effectiveArrayCount(schema: JSONSchema7): number {
  const { minItems, maxItems } = schema;
  if (minItems !== undefined && maxItems !== undefined) {
    return Math.max(minItems, maxItems);
  }
  if (maxItems !== undefined) return maxItems;
  if (minItems !== undefined) return minItems;
  return DEFAULT_ARRAY_COUNT;
}

/**
 * Record array-size breaches. `minItems` counts as much as `maxItems`: it is
 * a floor json-schema-faker has to reach, so a large one is exactly as
 * expensive.
 */
function recordArrayLimits(
  schema: JSONSchema7,
  count: number,
  depth: number,
  state: WalkState,
): void {
  const declared = Math.max(schema.minItems ?? 0, schema.maxItems ?? 0);
  if (declared > MAX_ARRAY_SIZE) {
    state.arraySize ??= {
      resource: "array_max_items",
      limit: MAX_ARRAY_SIZE,
      actual: declared,
    };
  }

  if (depth >= DEEP_NESTING_THRESHOLD && count >= LARGE_ARRAY_THRESHOLD) {
    state.deepArray ??= {
      resource: "deep_nesting_memory_risk",
      limit: DEEP_NESTING_THRESHOLD * LARGE_ARRAY_THRESHOLD,
      actual: depth * count,
    };
  }
}

/** Deep sub-trees combined with large arrays are a memory risk. */
function recordMemoryEstimate(
  schema: JSONSchema7,
  height: number,
  state: WalkState,
): void {
  if (!isArrayLike(schema)) return;

  const count = effectiveArrayCount(schema);
  if (height > DEEP_NESTING_THRESHOLD && count > LARGE_ARRAY_THRESHOLD) {
    state.memory ??= {
      resource: "memory_estimation",
      limit: DEEP_NESTING_THRESHOLD * LARGE_ARRAY_THRESHOLD,
      actual: height * count,
    };
  }
}

/** Keep node estimates finite and comparable on pathological schemas. */
function capped(value: number): number {
  return Math.min(value, Number.MAX_SAFE_INTEGER);
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
  let current: unknown = faker;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = Reflect.get(current, part);
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
