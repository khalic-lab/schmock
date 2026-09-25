import type { Faker } from "@faker-js/faker";
import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import {
  DEFAULT_ARRAY_COUNT,
  MAX_ARRAY_SIZE,
  MAX_GENERATED_CHARS,
  MAX_GENERATED_NODES,
  MAX_NESTING_DEPTH,
  MAX_OBJECT_PROPERTIES,
  MAX_SCHEMA_NODES,
  MAX_STRING_LENGTH,
} from "./constants.js";
import { createFakerInstance } from "./jsf-config.js";
import { collectSchemaChildren, type SchemaChild } from "./schema-children.js";
import { isJSONSchema7, isRecord } from "./utils.js";

let validationFaker: Faker | undefined;

/**
 * Composition, `$defs` and `dependencies` describe the same value level, so
 * they deliberately do not count towards MAX_NESTING_DEPTH. This separate cap
 * keeps a pathologically chained composition from overflowing the stack.
 */
const MAX_COMPOSITION_FRAMES = 200;

/** JSONSchema7 extended with json-schema-faker's `faker` property. */
type FakerAwareSchema = JSONSchema7 & { faker?: unknown };

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
  /** Schema path of the node that breached the limit. */
  path: string;
}

/** What a walked sub-schema contributes to its parent. */
interface Estimate {
  /** Height of the generated value tree below this node (0 for a scalar). */
  height: number;
  /** Estimated number of JSON nodes this sub-schema generates. */
  nodes: number;
  /**
   * Characters this sub-schema is certain to generate: the `minLength` of
   * every string it emits, multiplied through array counts. A floor, never an
   * estimate of the typical size, so charging it cannot reject a schema whose
   * output would fit.
   */
  chars: number;
}

const LEAF: Estimate = { height: 0, nodes: 1, chars: 0 };

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
  arraySize?: Violation;
  objectSize?: Violation;
  stringLength?: Violation;
  composition?: Violation;
}

/**
 * Validate JSON Schema structure and enforce resource limits.
 *
 * Walks every distinct schema node and edge exactly once, through every
 * keyword in `SCHEMA_KEYWORDS` (schema-children.ts, in that table's order),
 * checking structure, faker methods, cycles, nesting depth,
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

  chargeGeneratingSchemas(schema, path, state);

  const normalizedCount = normalizeExplicitCount(explicitCount);
  const estimates = estimateSchemas(schema, state, normalizedCount);
  const root = estimates.get(schema) ?? LEAF;
  const { maxDepth, maxFrames } = analyzeGraphPaths(schema, state);

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
      path,
    };
  }

  for (const violation of [
    state.composition,
    state.arraySize,
    state.objectSize,
    state.stringLength,
  ]) {
    if (violation) {
      throw new ResourceLimitError(
        violation.resource,
        violation.limit,
        violation.actual,
        violation.path,
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

  if (root.chars > MAX_GENERATED_CHARS) {
    throw new ResourceLimitError(
      "generated_chars",
      MAX_GENERATED_CHARS,
      root.chars,
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

/**
 * Record per-node resource limits for every schema that can produce a value.
 *
 * The structural walk visits every subschema, including ones that never
 * generate: `not` and `if` only test the value, and a `$defs` entry is
 * generated only where a `$ref` reaches it. Charging their bounds rejected
 * schemas whose output is tiny, so this pass starts again from the root and
 * follows generating edges only — a definition reached through a `$ref` is
 * still charged, one nothing references is not.
 */
function chargeGeneratingSchemas(
  root: JSONSchema7,
  rootPath: string,
  state: WalkState,
): void {
  const charged = new Set<JSONSchema7>();
  const pending: Array<{ schema: JSONSchema7; path: string }> = [
    { schema: root, path: rootPath },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame || charged.has(frame.schema)) continue;
    charged.add(frame.schema);

    recordDeclaredArrayLimit(frame.schema, frame.path, state);
    recordObjectLimit(frame.schema, frame.path, state);
    recordStringLimit(frame.schema, frame.path, state);

    const edges = state.edges.get(frame.schema) ?? [];
    for (let index = edges.length - 1; index >= 0; index -= 1) {
      const edge = edges[index];
      if (edge.generates && !charged.has(edge.schema)) {
        pending.push({ schema: edge.schema, path: edge.path });
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
        generates: true,
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

/** How the root array is sized, which differs from every nested array. */
interface RootSizing {
  explicitCount: number | undefined;
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
        schema === root ? { explicitCount } : undefined,
      ),
    );
  }
  return estimates;
}

function estimateSchema(
  schema: JSONSchema7,
  estimates: Map<JSONSchema7, Estimate>,
  resolveRef: LocalRefResolver,
  root: RootSizing | undefined,
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
  // Only a schema that can be nothing but a string is certain to emit one.
  let chars =
    schema.type === "string" && typeof schema.minLength === "number"
      ? Math.max(0, schema.minLength)
      : 0;
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
    const count = root?.explicitCount ?? effectiveArrayCount(schema);
    // json-schema-faker fills a nested array to maxItems, but the root array
    // is resized per request (determineArrayCount) anywhere from minItems up,
    // so only minItems — or the explicit count — is certain there.
    const certainCount = root
      ? (root.explicitCount ?? schema.minItems ?? 0)
      : count;
    let itemNodes = 0;
    let itemChars = 0;
    if (Array.isArray(schema.items)) {
      schema.items.forEach((item, index) => {
        const child = value(item);
        if (index < count) itemNodes = capped(itemNodes + child.nodes);
        if (index < certainCount) itemChars = capped(itemChars + child.chars);
      });
      const additional =
        schema.additionalItems === undefined
          ? LEAF
          : value(schema.additionalItems);
      itemNodes = capped(
        itemNodes + Math.max(0, count - schema.items.length) * additional.nodes,
      );
      itemChars = capped(
        itemChars +
          Math.max(0, certainCount - schema.items.length) * additional.chars,
      );
    } else if (schema.items !== undefined) {
      const item = value(schema.items);
      itemNodes = capped(count * item.nodes);
      itemChars = capped(certainCount * item.chars);
    } else {
      itemNodes = count;
    }
    if (schema.contains !== undefined) value(schema.contains);
    nodes = capped(nodes + itemNodes);
    chars = capped(chars + itemChars);
  }

  if (isObjectLike(schema)) {
    const propertyNames = new Set(Object.keys(schema.properties ?? {}));
    for (const property of Object.values(schema.properties ?? {})) {
      const estimate = value(property);
      nodes = capped(nodes + estimate.nodes);
      chars = capped(chars + estimate.chars);
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
      const estimate = sibling(branch);
      nodes = capped(nodes + Math.max(0, estimate.nodes - 1));
      // A branch may constrain the same string this node does, so only the
      // largest floor is certain.
      chars = Math.max(chars, estimate.chars);
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

  // A value that may come out null carries none of its strings for certain.
  const nullable =
    hasType(schema, "null") || Reflect.get(schema, "schmockNullable") === true;
  return { height, nodes, chars: nullable ? 0 : chars };
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

  const validTypes: readonly unknown[] = [
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null",
  ];
  // The union form (`type: ["string", "null"]`, which the OpenAPI normalizer
  // emits for nullable schemas) is checked member by member, like the string
  // form, so a typo fails here instead of on every request.
  const declaredTypes: unknown[] = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  for (const type of declaredTypes) {
    if (!validTypes.includes(type)) {
      throw new SchemaValidationError(
        path,
        `Invalid schema type: ${JSON.stringify(type)}`,
        "Supported types are: object, array, string, number, integer, boolean, null",
      );
    }
  }

  // json-schema-faker understands a `chance` generator, but Schmock registers
  // no chance instance: the keyword either fails every request with a
  // misleading "both faker and chance" error or is silently ignored.
  if (Reflect.get(schema, "chance") !== undefined) {
    throw new SchemaValidationError(
      `${path}.chance`,
      "chance generators are not supported",
      'Use the faker keyword instead, for example "faker": "lorem.paragraph"',
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

  if (hasType(schema, "array")) {
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
      if (error instanceof ResourceLimitError) {
        throw withResourcePath(error, `${path}.faker`);
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

/**
 * Word, sentence and paragraph counts are not character counts, so each is
 * held to MAX_STRING_LENGTH divided by the shortest text faker can emit for
 * one unit, separator included. A count above the ceiling cannot fit in one
 * string, and every count that could fit stays below it:
 *   - a word is at least one letter and a separator ("a "): 2;
 *   - a sentence is at least three one-letter words and a full stop, plus a
 *     separator ("A b c. "): 7;
 *   - a paragraph is at least three such sentences plus a separator: 21.
 */
function countLimit(shortestUnit: number) {
  return {
    resource: "string_length",
    limit: Math.floor(MAX_STRING_LENGTH / shortestUnit),
  } as const;
}
const WORD_COUNT = countLimit(2);
const SENTENCE_COUNT = countLimit(7);
const PARAGRAPH_COUNT = countLimit(21);

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
      ...WORD_COUNT,
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
  "lorem.words": [{ argumentIndex: 0, direct: true, ...WORD_COUNT }],
  "lorem.sentence": [{ argumentIndex: 0, direct: true, ...WORD_COUNT }],
  "lorem.sentences": [{ argumentIndex: 0, direct: true, ...SENTENCE_COUNT }],
  "lorem.slug": [{ argumentIndex: 0, direct: true, ...WORD_COUNT }],
  "lorem.lines": [{ argumentIndex: 0, direct: true, ...SENTENCE_COUNT }],
  "lorem.paragraph": [{ argumentIndex: 0, direct: true, ...SENTENCE_COUNT }],
  "lorem.paragraphs": [{ argumentIndex: 0, direct: true, ...PARAGRAPH_COUNT }],
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
    if (rule.property && isRecord(argument)) {
      actual = Math.max(
        actual,
        maximumCardinality(Reflect.get(argument, rule.property)),
      );
    }
    if (actual > rule.limit) {
      throw new ResourceLimitError(rule.resource, rule.limit, actual);
    }
  }
  validateTemplateArguments(method, args);

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

function maximumCardinality(value: unknown): number {
  if (typeof value === "number") return value;
  if (!isRecord(value)) return 0;

  let maximum = 0;
  for (const key of ["min", "max"] as const) {
    const bound = Reflect.get(value, key);
    if (typeof bound === "number") maximum = Math.max(maximum, bound);
  }
  return maximum;
}

/**
 * Bound the faker helpers whose output size is set by a template or pattern
 * rather than by a count, which no entry in FAKER_ALLOCATION_POLICIES covers.
 */
function validateTemplateArguments(method: string, args: unknown[]): void {
  switch (method) {
    case "helpers.fake":
      validateFakeTemplates(args[0]);
      return;
    case "helpers.mustache":
      validateMustacheTemplate(args[0], args[1]);
      return;
    case "helpers.fromRegExp":
      if (typeof args[0] === "string") {
        // faker honours both bounds of `{n,m}`, so the upper one is charged.
        const { max } = regexLengthBounds(args[0]);
        if (max > MAX_STRING_LENGTH) {
          throw new ResourceLimitError("string_length", MAX_STRING_LENGTH, max);
        }
      }
      return;
    default:
      return;
  }
}

/**
 * `helpers.fake` evaluates each `{{module.method(args)}}` placeholder with
 * JSON-parsed arguments, so every placeholder is held to the same allocation
 * policy as the method called directly.
 */
function validateFakeTemplates(templates: unknown): void {
  const candidates = Array.isArray(templates) ? templates : [templates];
  for (const template of candidates) {
    if (typeof template !== "string") continue;
    for (const match of template.matchAll(/\{\{(.+?)\}\}/g)) {
      const expression = match[1];
      const open = expression.indexOf("(");
      const close = expression.lastIndexOf(")");
      if (open === -1 || close < open) continue;
      validateFakerAllocationArguments(
        expression.slice(0, open).trim(),
        parseFakeArguments(expression.slice(open + 1, close)),
      );
    }
  }
}

/** Parse placeholder arguments the way faker does: JSON first, else a string. */
function parseFakeArguments(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(`[${text}]`);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // faker falls back to passing the raw text as a single string argument.
  }
  return [text];
}

/** `helpers.mustache` repeats each value once per `{{key}}` occurrence. */
function validateMustacheTemplate(text: unknown, data: unknown): void {
  if (typeof text !== "string" || !isRecord(data)) return;
  let length = text.length;
  for (const [key, value] of Object.entries(data)) {
    const placeholder = `{{${key}}}`;
    const occurrences = text.split(placeholder).length - 1;
    if (occurrences === 0) continue;
    const replacement =
      typeof value === "string" ? value.length : String(value).length;
    length = capped(length + occurrences * (replacement - placeholder.length));
  }
  if (length > MAX_STRING_LENGTH) {
    throw new ResourceLimitError("string_length", MAX_STRING_LENGTH, length);
  }
}

interface LengthBounds {
  min: number;
  max: number;
}

interface RegexFrame extends LengthBounds {
  alternatives: LengthBounds[];
  zeroWidth: boolean;
}

const EMPTY: LengthBounds = { min: 0, max: 0 };
const SINGLE: LengthBounds = { min: 1, max: 1 };

/**
 * Length bounds of the strings a regular expression describes, from the
 * repetition it states explicitly. `min` is the shortest match; `max` charges
 * each quantifier's upper bound, and only the lower bound of an unbounded one
 * (`*`, `+`, `{n,}`), since generators cap open repetition themselves. Anchors
 * and lookarounds are zero-width and a backreference counts as empty, so `min`
 * never overstates what a generator must produce.
 */
function regexLengthBounds(pattern: string): LengthBounds {
  const frames: RegexFrame[] = [newRegexFrame(false)];
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    const frame = frames[frames.length - 1];
    if (char === "|") {
      frame.alternatives.push({ min: frame.min, max: frame.max });
      frame.min = 0;
      frame.max = 0;
      index += 1;
      continue;
    }
    if (char === "(") {
      const prefix = regexGroupPrefix(pattern, index);
      frames.push(newRegexFrame(prefix.zeroWidth));
      index += prefix.length;
      continue;
    }

    let atom: LengthBounds;
    if (char === ")") {
      const group = frames.length > 1 ? frames.pop() : undefined;
      atom = group ? closeRegexFrame(group) : SINGLE;
      index += 1;
    } else if (char === "[") {
      index = skipRegexClass(pattern, index);
      atom = SINGLE;
    } else if (char === "\\") {
      const escaped = readRegexEscape(pattern, index);
      index = escaped.next;
      atom = escaped.width;
    } else if (char === "^" || char === "$") {
      index += 1;
      atom = EMPTY;
    } else {
      index += 1;
      atom = SINGLE;
    }

    const quantifier = readRegexQuantifier(pattern, index);
    if (quantifier) {
      index = quantifier.next;
      atom = {
        min: multiplied(atom.min, quantifier.min),
        max: multiplied(atom.max, quantifier.max),
      };
    }
    const current = frames[frames.length - 1];
    current.min = capped(current.min + atom.min);
    current.max = capped(current.max + atom.max);
  }

  while (frames.length > 1) {
    const group = frames.pop();
    if (!group) break;
    const bounds = closeRegexFrame(group);
    const parent = frames[frames.length - 1];
    parent.min = capped(parent.min + bounds.min);
    parent.max = capped(parent.max + bounds.max);
  }
  return closeRegexFrame(frames[0]);
}

function newRegexFrame(zeroWidth: boolean): RegexFrame {
  return { min: 0, max: 0, alternatives: [], zeroWidth };
}

function closeRegexFrame(frame: RegexFrame): LengthBounds {
  if (frame.zeroWidth) return EMPTY;
  let min = frame.min;
  let max = frame.max;
  for (const alternative of frame.alternatives) {
    min = Math.min(min, alternative.min);
    max = Math.max(max, alternative.max);
  }
  return { min, max };
}

function regexGroupPrefix(
  pattern: string,
  index: number,
): { length: number; zeroWidth: boolean } {
  for (const lookaround of ["(?<=", "(?<!", "(?=", "(?!"]) {
    if (pattern.startsWith(lookaround, index)) {
      return { length: lookaround.length, zeroWidth: true };
    }
  }
  if (pattern.startsWith("(?<", index)) {
    const end = pattern.indexOf(">", index);
    return { length: end === -1 ? 3 : end - index + 1, zeroWidth: false };
  }
  if (pattern.startsWith("(?:", index)) return { length: 3, zeroWidth: false };
  return { length: 1, zeroWidth: false };
}

function skipRegexClass(pattern: string, index: number): number {
  let cursor = index + 1;
  while (cursor < pattern.length) {
    if (pattern[cursor] === "\\") {
      cursor += 2;
    } else if (pattern[cursor] === "]") {
      return cursor + 1;
    } else {
      cursor += 1;
    }
  }
  return pattern.length;
}

function readRegexEscape(
  pattern: string,
  index: number,
): { next: number; width: LengthBounds } {
  const escaped = pattern[index + 1];
  const skipTo = (terminator: string, fallback: number): number => {
    const end = pattern.indexOf(terminator, index + 2);
    return end === -1 ? fallback : end + 1;
  };
  switch (escaped) {
    case undefined:
      return { next: index + 1, width: SINGLE };
    case "b":
    case "B":
      return { next: index + 2, width: EMPTY };
    case "k":
      return pattern[index + 2] === "<"
        ? { next: skipTo(">", index + 2), width: EMPTY }
        : { next: index + 2, width: SINGLE };
    case "u":
      return pattern[index + 2] === "{"
        ? { next: skipTo("}", index + 2), width: SINGLE }
        : { next: index + 6, width: SINGLE };
    case "x":
      return { next: index + 4, width: SINGLE };
    case "c":
      return { next: index + 3, width: SINGLE };
    case "p":
    case "P":
      return pattern[index + 2] === "{"
        ? { next: skipTo("}", index + 2), width: SINGLE }
        : { next: index + 2, width: SINGLE };
    default:
      if (escaped >= "1" && escaped <= "9") {
        let next = index + 2;
        while (next < pattern.length && /\d/.test(pattern[next])) next += 1;
        return { next, width: EMPTY };
      }
      return { next: index + 2, width: SINGLE };
  }
}

function readRegexQuantifier(
  pattern: string,
  index: number,
): { min: number; max: number; next: number } | undefined {
  const char = pattern[index];
  let quantifier: { min: number; max: number; next: number } | undefined;
  if (char === "*") quantifier = { min: 0, max: 0, next: index + 1 };
  else if (char === "+") quantifier = { min: 1, max: 1, next: index + 1 };
  else if (char === "?") quantifier = { min: 0, max: 1, next: index + 1 };
  else if (char === "{") {
    const counted = /\{(\d+)(,(\d*))?\}/y;
    counted.lastIndex = index;
    const match = counted.exec(pattern);
    if (match) {
      const min = Number(match[1]);
      const max =
        match[2] === undefined || match[3] === "" ? min : Number(match[3]);
      quantifier = {
        min,
        max: Math.max(min, max),
        next: index + match[0].length,
      };
    }
  }
  // A trailing `?` makes the quantifier lazy without changing its bounds.
  if (quantifier && pattern[quantifier.next] === "?") quantifier.next += 1;
  return quantifier;
}

function multiplied(left: number, right: number): number {
  return left === 0 || right === 0 ? 0 : capped(left * right);
}

/** Re-throw a resource-limit breach at the schema path that caused it. */
function withResourcePath(
  error: ResourceLimitError,
  path: string,
): ResourceLimitError {
  const context = error.context;
  if (!isRecord(context)) return error;
  const { resource, limit, actual } = context;
  if (typeof resource !== "string" || typeof limit !== "number") return error;
  return new ResourceLimitError(
    resource,
    limit,
    typeof actual === "number" ? actual : undefined,
    path,
  );
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
function recordDeclaredArrayLimit(
  schema: JSONSchema7,
  path: string,
  state: WalkState,
): void {
  const declared = Math.max(schema.minItems ?? 0, schema.maxItems ?? 0);
  if (declared > MAX_ARRAY_SIZE) {
    state.arraySize ??= {
      resource: "array_max_items",
      limit: MAX_ARRAY_SIZE,
      actual: declared,
      path,
    };
  }
}

function recordObjectLimit(
  schema: JSONSchema7,
  path: string,
  state: WalkState,
): void {
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
      path,
    };
  }
}

function recordStringLimit(
  schema: JSONSchema7,
  path: string,
  state: WalkState,
): void {
  if (canGenerateString(schema)) {
    for (const declared of [schema.minLength, schema.maxLength]) {
      if (declared !== undefined) recordStringViolation(declared, path, state);
    }
    // json-schema-faker honours a pattern's explicit repetition floor
    // (`a{70000}`) and caps its upper bounds, so the shortest match is what a
    // pattern forces it to generate.
    if (typeof schema.pattern === "string" && isValidRegex(schema.pattern)) {
      recordStringViolation(regexLengthBounds(schema.pattern).min, path, state);
    }
  }

  for (const fixed of [
    schema.const,
    schema.default,
    schema.enum,
    Reflect.get(schema, "template"),
  ]) {
    recordStringViolation(largestStringLength(fixed), path, state);
  }
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
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

function recordStringViolation(
  actual: number,
  path: string,
  state: WalkState,
): void {
  if (
    actual > MAX_STRING_LENGTH &&
    (!state.stringLength || actual > state.stringLength.actual)
  ) {
    state.stringLength = {
      resource: "string_length",
      limit: MAX_STRING_LENGTH,
      actual,
      path,
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
    // `in` walks the prototype chain, so without this guard `person.toString`
    // or `helpers.hasOwnProperty` would resolve to Object.prototype and pass.
    // Faker's own methods live on its module classes, never on
    // Object.prototype, and none of its public API starts with `_`.
    const inherited =
      Object.hasOwn(Object.prototype, part) || part.startsWith("_");
    if (
      current &&
      typeof current === "object" &&
      !inherited &&
      part in current
    ) {
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
