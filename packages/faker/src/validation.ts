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
  MAX_OBJECT_PROPERTIES,
  MAX_SCHEMA_NODES,
  MAX_STRING_LENGTH,
} from "./constants.js";
import { createFakerInstance } from "./jsf-config.js";
import { collectSchemaChildren, type SchemaChild } from "./schema-children.js";

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

type SchemaEdge = SchemaChild;

type LocalRefResolver = (
  schema: JSONSchema7,
  reference: string,
) => JSONSchema7Definition | undefined;

interface WalkState {
  /** Distinct schema nodes visited. */
  visited: number;
  circular: boolean;
  edges: Map<JSONSchema7, SchemaEdge[]>;
  postOrder: JSONSchema7[];
  resolveRef: LocalRefResolver;
  deepArray?: Violation;
  arraySize?: Violation;
  objectSize?: Violation;
  stringLength?: Violation;
  memory?: Violation;
  composition?: Violation;
}

/**
 * Validate JSON Schema structure and enforce resource limits.
 *
 * Walks every distinct schema node and edge exactly once — `properties`,
 * `patternProperties`, `additionalProperties`, `propertyNames`, `items` (object
 * and tuple forms), `additionalItems`, `contains`, `allOf`/`anyOf`/`oneOf`,
 * `not`, `if`/`then`/`else`, `definitions`, `$defs` and the schema form of
 * `dependencies` — checking structure, faker methods, cycles, nesting depth,
 * array sizes and generation budgets. Local JSON Pointer and embedded `$id`
 * references become graph edges: active-path re-entry is a cycle, while a
 * completed target is a shared DAG node whose memoized estimate is charged at
 * every output site. Validation therefore stays O(nodes + edges).
 *
 * References outside the indexed schema and unresolvable references are left
 * for json-schema-faker to report.
 *
 * @param schema - JSON Schema to validate
 * @param path - Path label used in error messages
 * @throws {SchemaValidationError} When schema structure is invalid
 * @throws {ResourceLimitError} When schema exceeds safety limits
 */
export function validateSchema(
  schema: JSONSchema7,
  path = "$",
  explicitCount?: number,
): void {
  if (!schema || typeof schema !== "object") {
    throw new SchemaValidationError(
      path,
      "Schema must be a valid JSON Schema object",
    );
  }

  const state: WalkState = {
    visited: 0,
    circular: false,
    edges: new Map(),
    postOrder: [],
    resolveRef: createLocalRefResolver(schema),
  };

  inspectSchemaGraph(schema, path, state);

  if (state.circular) {
    throw new SchemaValidationError(
      path,
      "Schema contains circular references which are not supported",
    );
  }

  const normalizedCount = normalizeExplicitCount(explicitCount);
  const estimates = estimateSchemas(schema, state, normalizedCount);
  const root = estimates.get(schema) ?? LEAF;
  const { maxDepth, maxFrames } = analyzeGraphPaths(
    schema,
    state,
    normalizedCount,
  );

  if (maxDepth > MAX_NESTING_DEPTH) {
    throw new ResourceLimitError(
      "schema_nesting_depth",
      MAX_NESTING_DEPTH,
      maxDepth,
    );
  }

  if (maxFrames > MAX_COMPOSITION_FRAMES) {
    state.composition ??= {
      resource: "schema_composition_depth",
      limit: MAX_COMPOSITION_FRAMES,
      actual: maxFrames,
    };
  }

  for (const [node, estimate] of estimates) {
    recordMemoryEstimate(
      node,
      estimate.height,
      state,
      node === schema ? normalizedCount : undefined,
    );
  }

  for (const violation of [
    state.composition,
    state.deepArray,
    state.arraySize,
    state.objectSize,
    state.stringLength,
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

  if (
    normalizedCount !== undefined &&
    isArrayLike(schema) &&
    normalizedCount > MAX_ARRAY_SIZE
  ) {
    throw new ResourceLimitError("array_size", MAX_ARRAY_SIZE, normalizedCount);
  }

  if (root.nodes > MAX_GENERATED_NODES) {
    throw new ResourceLimitError(
      "generated_nodes",
      MAX_GENERATED_NODES,
      root.nodes,
    );
  }
}

interface TraversalFrame {
  schema: JSONSchema7;
  path: string;
  typedChain: boolean;
  exiting: boolean;
}

function inspectSchemaGraph(
  root: JSONSchema7,
  rootPath: string,
  state: WalkState,
): void {
  const active = new Set<JSONSchema7>();
  const completed = new Set<JSONSchema7>();
  const stack: TraversalFrame[] = [
    { schema: root, path: rootPath, typedChain: true, exiting: false },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;

    if (frame.exiting) {
      active.delete(frame.schema);
      completed.add(frame.schema);
      state.postOrder.push(frame.schema);
      continue;
    }
    if (completed.has(frame.schema)) {
      if (frame.typedChain) validateNode(frame.schema, frame.path, true);
      continue;
    }
    if (active.has(frame.schema)) {
      state.circular = true;
      continue;
    }

    state.visited += 1;
    if (state.visited > MAX_SCHEMA_NODES) {
      throw new ResourceLimitError(
        "schema_nodes",
        MAX_SCHEMA_NODES,
        state.visited,
      );
    }

    validateNode(frame.schema, frame.path, frame.typedChain);
    recordDeclaredArrayLimit(frame.schema, state);
    recordObjectLimit(frame.schema, state);
    recordStringLimit(frame.schema, state);

    const edges = collectSchemaEdges(
      frame.schema,
      frame.path,
      state.resolveRef,
    );
    state.edges.set(frame.schema, edges);
    active.add(frame.schema);
    stack.push({ ...frame, exiting: true });
    for (let index = edges.length - 1; index >= 0; index -= 1) {
      const edge = edges[index];
      if (active.has(edge.schema)) {
        state.circular = true;
      } else if (!completed.has(edge.schema)) {
        stack.push({
          schema: edge.schema,
          path: edge.path,
          typedChain: frame.typedChain && edge.typedContinuation,
          exiting: false,
        });
      }
    }
  }
}

function collectSchemaEdges(
  schema: JSONSchema7,
  path: string,
  resolveRef: LocalRefResolver,
): SchemaEdge[] {
  const edges = collectContainedSchemaEdges(schema, path);
  for (const keyword of ["$ref", "$dynamicRef"] as const) {
    const reference = Reflect.get(schema, keyword);
    if (typeof reference !== "string") continue;
    const resolved = resolveRef(schema, reference);
    if (isJSONSchema7(resolved)) {
      edges.unshift({
        schema: resolved,
        path: `${path}.${keyword}`,
        depthCost: 0,
        frameCost: 1,
        typedContinuation: false,
      });
    }
  }
  return edges;
}

function collectContainedSchemaEdges(
  schema: JSONSchema7,
  path: string,
): SchemaEdge[] {
  return collectSchemaChildren(schema, path);
}

const INTERNAL_ROOT_ID = "schmock://local/root.json";

interface SchemaScope {
  baseUri: string;
  resourceRoot: JSONSchema7;
}

interface ReferenceIndex {
  resources: Map<string, JSONSchema7Definition>;
  scopes: Map<JSONSchema7, SchemaScope>;
  rootScope: SchemaScope;
}

interface IndexFrame {
  schema: JSONSchema7;
  inheritedScope: SchemaScope;
  path: string;
}

function createLocalRefResolver(root: JSONSchema7): LocalRefResolver {
  const index = createReferenceIndex(root);
  const cache = new Map<
    JSONSchema7,
    Map<string, JSONSchema7Definition | null>
  >();

  return (
    schema: JSONSchema7,
    reference: string,
  ): JSONSchema7Definition | undefined => {
    let schemaCache = cache.get(schema);
    if (!schemaCache) {
      schemaCache = new Map();
      cache.set(schema, schemaCache);
    }
    const cached = schemaCache.get(reference);
    if (cached !== undefined) return cached === null ? undefined : cached;

    const scope = index.scopes.get(schema) ?? index.rootScope;
    const resolved = resolveIndexedReference(reference, scope, index.resources);
    schemaCache.set(reference, resolved ?? null);
    return resolved;
  };
}

function createReferenceIndex(root: JSONSchema7): ReferenceIndex {
  const resources = new Map<string, JSONSchema7Definition>();
  const scopes = new Map<JSONSchema7, SchemaScope>();
  const rootScope: SchemaScope = {
    baseUri: INTERNAL_ROOT_ID,
    resourceRoot: root,
  };
  resources.set(INTERNAL_ROOT_ID, root);

  const pending: IndexFrame[] = [
    { schema: root, inheritedScope: rootScope, path: "$" },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame || scopes.has(frame.schema)) continue;

    const scope = indexSchemaIdentifiers(
      frame.schema,
      frame.inheritedScope,
      resources,
      frame.path,
    );
    scopes.set(frame.schema, scope);
    for (const edge of collectContainedSchemaEdges(frame.schema, frame.path)) {
      pending.push({
        schema: edge.schema,
        inheritedScope: scope,
        path: edge.path,
      });
    }
  }

  return {
    resources,
    scopes,
    rootScope: scopes.get(root) ?? rootScope,
  };
}

function indexSchemaIdentifiers(
  schema: JSONSchema7,
  inheritedScope: SchemaScope,
  resources: Map<string, JSONSchema7Definition>,
  path: string,
): SchemaScope {
  let scope = inheritedScope;
  if (typeof schema.$id === "string") {
    const identifier = resolveUri(schema.$id, inheritedScope.baseUri);
    if (identifier) {
      registerIdentifier(resources, identifier, schema, path);
      if (uriFragment(identifier) === "") {
        const documentUri = withoutUriFragment(identifier);
        registerIdentifier(resources, documentUri, schema, path);
        scope = { baseUri: documentUri, resourceRoot: schema };
      } else {
        scope = { ...inheritedScope, baseUri: identifier };
      }
    }
  }

  for (const keyword of ["$anchor", "$dynamicAnchor"] as const) {
    const anchor = Reflect.get(schema, keyword);
    if (typeof anchor === "string" && anchor.length > 0) {
      registerIdentifier(
        resources,
        `${withoutUriFragment(scope.baseUri)}#${anchor}`,
        schema,
        `${path}.${keyword}`,
      );
    }
  }
  return scope;
}

function registerIdentifier(
  resources: Map<string, JSONSchema7Definition>,
  identifier: string,
  schema: JSONSchema7,
  path: string,
): void {
  const owner = resources.get(identifier);
  if (owner !== undefined && owner !== schema) {
    throw new SchemaValidationError(
      path,
      `Duplicate canonical schema identifier: "${identifier}"`,
      "Give each embedded resource and anchor a unique canonical identifier",
    );
  }
  resources.set(identifier, schema);
}

function resolveIndexedReference(
  reference: string,
  scope: SchemaScope,
  resources: Map<string, JSONSchema7Definition>,
): JSONSchema7Definition | undefined {
  if (reference === "#") return scope.resourceRoot;
  if (reference.startsWith("#/")) {
    return resolveJsonPointer(scope.resourceRoot, reference.slice(1));
  }

  const identifier = resolveUri(reference, scope.baseUri);
  if (!identifier) return undefined;
  const exact = resources.get(identifier);
  if (exact !== undefined) return exact;

  const resource = resources.get(withoutUriFragment(identifier));
  if (resource === undefined) return undefined;
  const fragment = uriFragment(identifier);
  if (fragment === "") return resource;
  return fragment.startsWith("/")
    ? resolveJsonPointer(resource, fragment)
    : undefined;
}

function resolveUri(reference: string, baseUri: string): string | undefined {
  try {
    return new URL(reference, baseUri).href;
  } catch {
    return undefined;
  }
}

function withoutUriFragment(identifier: string): string {
  const url = new URL(identifier);
  url.hash = "";
  return url.href;
}

function uriFragment(identifier: string): string {
  return new URL(identifier).hash.slice(1);
}

function resolveJsonPointer(
  root: JSONSchema7Definition,
  encodedPointer: string,
): JSONSchema7Definition | undefined {
  let pointer: string;
  try {
    pointer = decodeURIComponent(encodedPointer);
  } catch {
    return undefined;
  }
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;

  let current: unknown = root;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = encodedSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = Reflect.get(current, segment);
  }
  return typeof current === "boolean" || isJSONSchema7(current)
    ? current
    : undefined;
}

function estimateSchemas(
  root: JSONSchema7,
  state: WalkState,
  explicitCount: number | undefined,
): Map<JSONSchema7, Estimate> {
  const estimates = new Map<JSONSchema7, Estimate>();
  for (const schema of state.postOrder) {
    estimates.set(
      schema,
      estimateSchema(
        schema,
        estimates,
        state.resolveRef,
        schema === root ? explicitCount : undefined,
      ),
    );
  }
  return estimates;
}

function estimateSchema(
  schema: JSONSchema7,
  estimates: Map<JSONSchema7, Estimate>,
  resolveRef: LocalRefResolver,
  explicitCount: number | undefined,
): Estimate {
  const reference =
    typeof schema.$ref === "string"
      ? schema.$ref
      : Reflect.get(schema, "$dynamicRef");
  if (typeof reference === "string") {
    return estimateDefinition(resolveRef(schema, reference), estimates);
  }

  let height = 0;
  let nodes = 1;
  const value = (definition: unknown): Estimate => {
    const child = estimateDefinition(definition, estimates);
    height = Math.max(height, child.height + 1);
    return child;
  };
  const sibling = (definition: unknown): Estimate => {
    const child = estimateDefinition(definition, estimates);
    height = Math.max(height, child.height);
    return child;
  };

  if (isArrayLike(schema)) {
    const count = explicitCount ?? effectiveArrayCount(schema);
    let itemNodes = 0;
    if (Array.isArray(schema.items)) {
      schema.items.forEach((item, index) => {
        const child = value(item);
        if (index < count) itemNodes = capped(itemNodes + child.nodes);
      });
      const additional =
        schema.additionalItems === undefined
          ? LEAF
          : value(schema.additionalItems);
      itemNodes = capped(
        itemNodes + Math.max(0, count - schema.items.length) * additional.nodes,
      );
    } else if (schema.items !== undefined) {
      itemNodes = capped(count * value(schema.items).nodes);
    } else {
      itemNodes = count;
    }
    if (schema.contains !== undefined) value(schema.contains);
    nodes = capped(nodes + itemNodes);
  }

  if (isObjectLike(schema)) {
    const propertyNames = new Set(Object.keys(schema.properties ?? {}));
    for (const property of Object.values(schema.properties ?? {})) {
      nodes = capped(nodes + value(property).nodes);
    }

    let generatedProperty = LEAF;
    for (const property of Object.values(schema.patternProperties ?? {})) {
      const estimate = value(property);
      nodes = capped(nodes + estimate.nodes);
      if (estimate.nodes > generatedProperty.nodes)
        generatedProperty = estimate;
    }
    if (schema.additionalProperties !== undefined) {
      const estimate = value(schema.additionalProperties);
      if (estimate.nodes > generatedProperty.nodes)
        generatedProperty = estimate;
    }
    if (schema.propertyNames !== undefined) value(schema.propertyNames);

    const requiredExtras = new Set(
      (schema.required ?? []).filter((name) => !propertyNames.has(name)),
    ).size;
    const minimumExtras = Math.max(
      0,
      (schema.minProperties ?? 0) - propertyNames.size,
    );
    const generatedExtras = Math.max(requiredExtras, minimumExtras);
    nodes = capped(nodes + generatedExtras * generatedProperty.nodes);
  }

  if (schema.allOf) {
    for (const branch of schema.allOf) {
      nodes = capped(nodes + Math.max(0, sibling(branch).nodes - 1));
    }
  }

  let alternative = 0;
  for (const keyword of ["anyOf", "oneOf"] as const) {
    for (const branch of schema[keyword] ?? []) {
      alternative = Math.max(alternative, sibling(branch).nodes - 1);
    }
  }
  nodes = capped(nodes + Math.max(0, alternative));

  if (schema.if !== undefined) sibling(schema.if);
  let conditional = 0;
  for (const keyword of ["then", "else"] as const) {
    if (schema[keyword] !== undefined) {
      conditional = Math.max(conditional, sibling(schema[keyword]).nodes - 1);
    }
  }
  nodes = capped(nodes + Math.max(0, conditional));
  if (schema.not !== undefined) sibling(schema.not);

  return { height, nodes };
}

function estimateDefinition(
  definition: unknown,
  estimates: Map<JSONSchema7, Estimate>,
): Estimate {
  return isJSONSchema7(definition) ? (estimates.get(definition) ?? LEAF) : LEAF;
}

function analyzeGraphPaths(
  root: JSONSchema7,
  state: WalkState,
  explicitCount: number | undefined,
): { maxDepth: number; maxFrames: number } {
  const depths = new Map<JSONSchema7, number>([[root, 0]]);
  const frames = new Map<JSONSchema7, number>([[root, 0]]);
  let maxDepth = 0;
  let maxFrames = 0;

  for (let index = state.postOrder.length - 1; index >= 0; index -= 1) {
    const schema = state.postOrder[index];
    const depth = depths.get(schema);
    const frameCount = frames.get(schema);
    if (depth === undefined || frameCount === undefined) continue;

    maxDepth = Math.max(maxDepth, depth);
    maxFrames = Math.max(maxFrames, frameCount);
    const count =
      schema === root && explicitCount !== undefined
        ? explicitCount
        : effectiveArrayCount(schema);
    if (
      isArrayLike(schema) &&
      depth >= DEEP_NESTING_THRESHOLD &&
      count >= LARGE_ARRAY_THRESHOLD
    ) {
      state.deepArray ??= {
        resource: "deep_nesting_memory_risk",
        limit: DEEP_NESTING_THRESHOLD * LARGE_ARRAY_THRESHOLD,
        actual: depth * count,
      };
    }

    for (const edge of state.edges.get(schema) ?? []) {
      const childDepth = depth + edge.depthCost;
      const childFrames = frameCount + edge.frameCost;
      if (childDepth > (depths.get(edge.schema) ?? -1)) {
        depths.set(edge.schema, childDepth);
      }
      if (childFrames > (frames.get(edge.schema) ?? -1)) {
        frames.set(edge.schema, childFrames);
      }
    }
  }

  return { maxDepth, maxFrames };
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
      validateFakerConfig(schema.faker);
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

function validateFakerConfig(config: unknown): void {
  if (typeof config === "string") {
    validateFakerMethod(config);
    return;
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new SchemaValidationError(
      "$.faker",
      "Faker must be a method string or an object with exactly one own method key",
      'Use "person.fullName" or { "number.int": [{ "min": 1, "max": 2 }] }',
    );
  }

  const ownKeys = Reflect.ownKeys(config);
  const enumerableKeys = Object.keys(config);
  if (
    ownKeys.length !== 1 ||
    enumerableKeys.length !== 1 ||
    typeof ownKeys[0] !== "string" ||
    ownKeys[0] !== enumerableKeys[0]
  ) {
    throw new SchemaValidationError(
      "$.faker",
      "Object-form faker must contain exactly one own method key",
      'Use { "number.int": [{ "min": 1, "max": 2 }] }',
    );
  }

  const method = enumerableKeys[0];
  const descriptor = Object.getOwnPropertyDescriptor(config, method);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value)
  ) {
    throw new SchemaValidationError(
      "$.faker",
      `Arguments for faker method "${method}" must be an array`,
      'Wrap options in an array, for example [{ "min": 1, "max": 2 }]',
    );
  }
  validateFakerMethod(method);
  validateFakerAllocationArguments(method, descriptor.value);
}

interface AllocationRule {
  argumentIndex: number;
  direct: boolean;
  property?: "count" | "length";
  resource: "array_size" | "string_length";
  limit: number;
}

const STRING_LIMIT = {
  resource: "string_length",
  limit: MAX_STRING_LENGTH,
} as const;
const ARRAY_LIMIT = {
  resource: "array_size",
  limit: MAX_ARRAY_SIZE,
} as const;

/** Faker 10.5 methods whose arguments directly control allocation size. */
const FAKER_ALLOCATION_POLICIES: Readonly<
  Record<string, readonly AllocationRule[]>
> = {
  "string.fromCharacters": [
    { argumentIndex: 1, direct: true, ...STRING_LIMIT },
  ],
  "string.alpha": [
    {
      argumentIndex: 0,
      direct: true,
      property: "length",
      ...STRING_LIMIT,
    },
  ],
  "string.alphanumeric": [
    {
      argumentIndex: 0,
      direct: true,
      property: "length",
      ...STRING_LIMIT,
    },
  ],
  "string.binary": [
    {
      argumentIndex: 0,
      direct: false,
      property: "length",
      ...STRING_LIMIT,
    },
  ],
  "string.octal": [
    {
      argumentIndex: 0,
      direct: false,
      property: "length",
      ...STRING_LIMIT,
    },
  ],
  "string.hexadecimal": [
    {
      argumentIndex: 0,
      direct: false,
      property: "length",
      ...STRING_LIMIT,
    },
  ],
  "string.numeric": [
    {
      argumentIndex: 0,
      direct: true,
      property: "length",
      ...STRING_LIMIT,
    },
  ],
  "string.sample": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "string.nanoid": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "string.symbol": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "word.sample": [
    {
      argumentIndex: 0,
      direct: true,
      property: "length",
      ...STRING_LIMIT,
    },
  ],
  "word.words": [
    {
      argumentIndex: 0,
      direct: true,
      property: "count",
      ...STRING_LIMIT,
    },
  ],
  "lorem.word": [
    {
      argumentIndex: 0,
      direct: true,
      property: "length",
      ...STRING_LIMIT,
    },
  ],
  "lorem.words": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "lorem.sentence": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "lorem.sentences": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "lorem.slug": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "lorem.lines": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "lorem.paragraph": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "lorem.paragraphs": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "lorem.text": [{ argumentIndex: 0, direct: true, ...STRING_LIMIT }],
  "internet.password": [
    {
      argumentIndex: 0,
      direct: false,
      property: "length",
      ...STRING_LIMIT,
    },
  ],
  "helpers.uniqueArray": [{ argumentIndex: 1, direct: true, ...ARRAY_LIMIT }],
  "helpers.arrayElements": [{ argumentIndex: 1, direct: true, ...ARRAY_LIMIT }],
  "helpers.multiple": [
    {
      argumentIndex: 1,
      direct: false,
      property: "count",
      ...ARRAY_LIMIT,
    },
  ],
  "date.betweens": [
    {
      argumentIndex: 0,
      direct: false,
      property: "count",
      ...ARRAY_LIMIT,
    },
  ],
};

function validateFakerAllocationArguments(
  method: string,
  args: unknown[],
): void {
  for (const rule of FAKER_ALLOCATION_POLICIES[method] ?? []) {
    const argument = args[rule.argumentIndex];
    let actual = rule.direct ? maximumCardinality(argument) : 0;
    if (rule.property && isRecordValue(argument)) {
      actual = Math.max(
        actual,
        maximumCardinality(Reflect.get(argument, rule.property)),
      );
    }
    if (actual > rule.limit) {
      throw new ResourceLimitError(rule.resource, rule.limit, actual);
    }
  }

  const pending = [...args];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
      throw new ResourceLimitError(
        "string_length",
        MAX_STRING_LENGTH,
        value.length,
      );
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      continue;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const nested of value) pending.push(nested);
      continue;
    }
    for (const nested of Object.values(value)) pending.push(nested);
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maximumCardinality(value: unknown): number {
  if (typeof value === "number") return value;
  if (!isRecordValue(value)) return 0;

  let maximum = 0;
  for (const key of ["min", "max"] as const) {
    const bound = Reflect.get(value, key);
    if (typeof bound === "number") maximum = Math.max(maximum, bound);
  }
  return maximum;
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

function normalizeExplicitCount(count: number | undefined): number | undefined {
  if (count === undefined || Number.isNaN(count)) return undefined;
  return Math.floor(Math.max(0, count));
}

/**
 * Record array-size breaches. `minItems` counts as much as `maxItems`: it is
 * a floor json-schema-faker has to reach, so a large one is exactly as
 * expensive.
 */
function recordDeclaredArrayLimit(schema: JSONSchema7, state: WalkState): void {
  const declared = Math.max(schema.minItems ?? 0, schema.maxItems ?? 0);
  if (declared > MAX_ARRAY_SIZE) {
    state.arraySize ??= {
      resource: "array_max_items",
      limit: MAX_ARRAY_SIZE,
      actual: declared,
    };
  }
}

function recordObjectLimit(schema: JSONSchema7, state: WalkState): void {
  if (!isObjectLike(schema)) return;

  const properties = new Set(Object.keys(schema.properties ?? {}));
  const requiredExtras = new Set(
    (schema.required ?? []).filter((name) => !properties.has(name)),
  ).size;
  const actual = Math.max(
    schema.minProperties ?? 0,
    properties.size + requiredExtras,
  );
  if (actual > MAX_OBJECT_PROPERTIES) {
    state.objectSize ??= {
      resource: "object_properties",
      limit: MAX_OBJECT_PROPERTIES,
      actual,
    };
  }
}

function recordStringLimit(schema: JSONSchema7, state: WalkState): void {
  if (canGenerateString(schema)) {
    for (const declared of [schema.minLength, schema.maxLength]) {
      if (declared !== undefined) recordStringViolation(declared, state);
    }
  }

  for (const fixed of [
    schema.const,
    schema.default,
    schema.enum,
    Reflect.get(schema, "template"),
  ]) {
    recordStringViolation(largestStringLength(fixed), state);
  }
}

function canGenerateString(schema: JSONSchema7): boolean {
  if (schema.type !== undefined) return hasType(schema, "string");
  if (schema.const !== undefined) return typeof schema.const === "string";
  if (schema.enum !== undefined) {
    return schema.enum.some((value) => typeof value === "string");
  }
  if (schema.default !== undefined) return typeof schema.default === "string";
  return true;
}

function recordStringViolation(actual: number, state: WalkState): void {
  if (
    actual > MAX_STRING_LENGTH &&
    (!state.stringLength || actual > state.stringLength.actual)
  ) {
    state.stringLength = {
      resource: "string_length",
      limit: MAX_STRING_LENGTH,
      actual,
    };
  }
}

function largestStringLength(value: unknown): number {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let largest = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      largest = Math.max(largest, current.length);
      continue;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    pending.push(...Object.values(current));
  }
  return largest;
}

function isObjectLike(schema: JSONSchema7): boolean {
  if (schema.type !== undefined) return hasType(schema, "object");
  return (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined ||
    schema.patternProperties !== undefined ||
    schema.minProperties !== undefined ||
    schema.maxProperties !== undefined
  );
}

/** Deep sub-trees combined with large arrays are a memory risk. */
function recordMemoryEstimate(
  schema: JSONSchema7,
  height: number,
  state: WalkState,
  explicitCount?: number,
): void {
  if (!isArrayLike(schema)) return;

  const count = explicitCount ?? effectiveArrayCount(schema);
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
