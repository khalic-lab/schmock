import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import { toError } from "@schmock/core/adapter";
import type { JSONSchema7 } from "json-schema";
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
import { fakerLengthFloor, validateFakerConfig } from "./faker-allocation.js";
import { createReferenceViews } from "./jsf-references.js";
import { findUnhonouredNot } from "./not-support.js";
import { createLocalRefResolver, type LocalRefResolver } from "./ref-index.js";
import { regexLengthBounds } from "./regex-bounds.js";
import { findRootArray } from "./root-array.js";
import { capped } from "./saturating.js";
import {
  collectSchemaChildren,
  misshapenKeyword,
  type SchemaChild,
} from "./schema-children.js";
import { compilePattern, isJSONSchema7, isRecord } from "./utils.js";

// schema-enhancement.ts validates its mapped methods through this module.
export { validateFakerMethod } from "./faker-allocation.js";

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
   * Characters this sub-schema is certain to generate: the certain length of
   * every string it emits (`certainStringLength`), multiplied through array
   * counts. A floor, never an estimate of the typical size, so charging it
   * cannot reject a schema whose output would fit. The one exception is a
   * pattern that a composition nested more than one level below it
   * contradicts (`patternLengthFloor`), which can be over-charged.
   */
  chars: number;
}

const LEAF: Estimate = { height: 0, nodes: 1, chars: 0 };

type SchemaEdge = SchemaChild;

/** A structural problem found on a generating path, thrown once it finishes. */
interface GeneratingIssue {
  path: string;
  issue: string;
}

interface WalkState {
  /** Distinct schema nodes visited. */
  visited: number;
  circular: boolean;
  edges: Map<JSONSchema7, SchemaEdge[]>;
  postOrder: JSONSchema7[];
  refs: LocalRefResolver;
  /** The merged view generation reads for a node holding a reference. */
  views: (schema: JSONSchema7) => JSONSchema7;
  /** A generating `$dynamicRef` that resolves to nothing. */
  unresolvedReference?: GeneratingIssue;
  /** A generating `not` json-schema-faker would not honour. */
  unhonouredNot?: GeneratingIssue;
  arraySize?: Violation;
  objectSize?: Violation;
  stringLength?: Violation;
  /** A pattern whose longest generated match alone passes the budget. */
  patternGrowth?: Violation;
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
 * for json-schema-faker to report. Generation inlines the anchors,
 * `$dynamicRef`s and `$id`s the index resolves (jsf-references.ts), since
 * json-schema-faker follows none of them itself. A generating `$dynamicRef`
 * the index cannot resolve is rejected: json-schema-faker would generate an
 * arbitrary value in its place.
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

  const refs = createLocalRefResolver(schema);
  const state: WalkState = {
    visited: 0,
    circular: false,
    edges: new Map(),
    postOrder: [],
    refs,
    views: createReferenceViews(refs),
  };

  inspectSchemaGraph(schema, path, state);

  if (state.circular) {
    throw new SchemaValidationError(
      path,
      "Schema contains circular references which are not supported",
    );
  }

  chargeGeneratingSchemas(schema, path, state);
  state.unhonouredNot = findUnhonouredNot(
    schema,
    path,
    (node) => state.edges.get(node) ?? [],
    state.views,
  );

  if (state.unresolvedReference) {
    throw new SchemaValidationError(
      state.unresolvedReference.path,
      state.unresolvedReference.issue,
      'Give the target schema a matching "$dynamicAnchor", or reference it with a JSON Pointer such as "#/$defs/Name"',
    );
  }

  if (state.unhonouredNot) {
    throw new SchemaValidationError(
      state.unhonouredNot.path,
      state.unhonouredNot.issue,
      "Write the exclusion as not.type, not.const, not.enum or not.required, or bound the schema itself so it cannot produce what not rejects",
    );
  }

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
    state.patternGrowth,
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
    normalizedCount > MAX_ARRAY_SIZE &&
    countedArray(schema, state.refs) !== undefined
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

    const edges = collectSchemaEdges(frame.schema, frame.path, state.refs);
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
 * Upper bounds that a merge imposes on a subschema's own size keywords.
 * json-schema-faker merges an `if` with its parent and `then`, and the merged
 * maximum wins over a larger minimum, so `if: {minItems: 20000}` beside
 * `maxItems: 5` generates five items.
 */
interface MergedCaps {
  maxItems?: number;
  maxLength?: number;
  maxProperties?: number;
}

const NO_CAPS: MergedCaps = {};

/** The smallest of each maximum the given schemas declare. */
function mergedCaps(...schemas: unknown[]): MergedCaps {
  const caps: MergedCaps = {};
  for (const schema of schemas) {
    if (!isJSONSchema7(schema)) continue;
    for (const keyword of ["maxItems", "maxLength", "maxProperties"] as const) {
      const bound = schema[keyword];
      if (typeof bound !== "number") continue;
      caps[keyword] = Math.min(caps[keyword] ?? bound, bound);
    }
  }
  return caps;
}

/** A declared size, held to a merged maximum when there is one. */
function cappedBy(declared: number, cap: number | undefined): number {
  return cap === undefined ? declared : Math.min(declared, cap);
}

/**
 * Record per-node resource limits for every schema that can produce a value.
 *
 * The structural walk visits every subschema, including ones that never
 * generate: `not` only tests the value, json-schema-faker ignores an `if`
 * that has no sibling `then`, and a `$defs` entry is generated only where a
 * `$ref` reaches it. Charging their bounds rejected schemas whose output is
 * tiny, so this pass starts again from the root and follows generating edges
 * only — a definition reached through a `$ref` is still charged, one nothing
 * references is not.
 *
 * An `if` beside a `then` does generate: json-schema-faker merges it with its
 * parent and `then`. Its own size keywords are held to the maximums those two
 * declare (`MergedCaps`); every schema below it is charged as written.
 */
function chargeGeneratingSchemas(
  root: JSONSchema7,
  rootPath: string,
  state: WalkState,
): void {
  const charged = new Set<JSONSchema7>();
  const pending: Array<{
    schema: JSONSchema7;
    path: string;
    caps: MergedCaps;
  }> = [{ schema: root, path: rootPath, caps: NO_CAPS }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame || charged.has(frame.schema)) continue;
    // A capped charge is weaker than a plain one, so it does not stand in for
    // the plain charge a `$ref` to the same schema would still need.
    if (frame.caps === NO_CAPS) charged.add(frame.schema);

    recordUnresolvedDynamicReference(frame.schema, frame.path, state);
    recordDeclaredArrayLimit(frame.schema, frame.path, state, frame.caps);
    recordObjectLimit(frame.schema, frame.path, state, frame.caps);
    recordStringLimit(frame.schema, frame.path, state, frame.caps);

    const edges = state.edges.get(frame.schema) ?? [];
    for (let index = edges.length - 1; index >= 0; index -= 1) {
      const edge = edges[index];
      if (edge.generates && !charged.has(edge.schema)) {
        pending.push({
          schema: edge.schema,
          path: edge.path,
          caps:
            edge.keyword === "if"
              ? mergedCaps(frame.schema, frame.schema.then)
              : NO_CAPS,
        });
      }
    }
  }
}

/**
 * Record the first `$dynamicRef` on a generating path that the index cannot
 * resolve. Generation inlines one it resolves, but json-schema-faker ignores
 * the keyword itself and would generate an arbitrary value in its place. An
 * unresolvable `$ref` is left for json-schema-faker to report instead: it
 * fails the request rather than generate something else.
 */
function recordUnresolvedDynamicReference(
  schema: JSONSchema7,
  path: string,
  state: WalkState,
): void {
  if (state.unresolvedReference) return;
  const reference: unknown = Reflect.get(schema, "$dynamicRef");
  if (reference === undefined) return;
  if (
    typeof reference === "string" &&
    state.refs.resolve(schema, reference) !== undefined
  ) {
    return;
  }
  state.unresolvedReference = {
    path: `${path}.$dynamicRef`,
    issue: `$dynamicRef ${JSON.stringify(reference)} resolves to no schema in this document`,
  };
}

function collectSchemaEdges(
  schema: JSONSchema7,
  path: string,
  refs: LocalRefResolver,
): SchemaEdge[] {
  const edges = collectContainedSchemaEdges(schema, path);
  for (const keyword of ["$ref", "$dynamicRef"] as const) {
    const reference = Reflect.get(schema, keyword);
    if (typeof reference !== "string") continue;
    const resolved = refs.resolve(schema, reference);
    if (isJSONSchema7(resolved)) {
      edges.unshift({
        schema: resolved,
        keyword,
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
  // Generation sizes the array a root `$ref`, wrapper-only `allOf` or null
  // union stands for as the root array, `count` included, so it is charged
  // as one too, and so is every node on the way to it: a `$ref` holder there
  // is charged as the view it merges.
  const chain = new Set<JSONSchema7>();
  const sized = countedArray(root, state.refs, chain);
  for (const schema of state.postOrder) {
    estimates.set(
      schema,
      estimateSchema(
        schema,
        estimates,
        state,
        sized !== undefined && chain.has(schema)
          ? { explicitCount }
          : undefined,
      ),
    );
  }
  return estimates;
}

/**
 * Keywords that add nothing to the generated value: json-schema-faker does
 * not generate a string's decoded `contentSchema`, and `propertyNames` only
 * shapes keys, which the property counts already charge.
 */
const NON_VALUE_KEYWORDS: readonly string[] = [
  "contentSchema",
  "propertyNames",
];

const ARRAY_KEYWORDS: readonly string[] = [
  "items",
  "additionalItems",
  "prefixItems",
  "contains",
  "containsAll",
];

const OBJECT_KEYWORDS: readonly string[] = [
  "properties",
  "patternProperties",
  "additionalProperties",
];

const SAME_VALUE_KEYWORDS: readonly string[] = [
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
];

function estimateSchema(
  schema: JSONSchema7,
  estimates: Map<JSONSchema7, Estimate>,
  state: WalkState,
  root: RootSizing | undefined,
): Estimate {
  const reference =
    typeof schema.$ref === "string"
      ? schema.$ref
      : Reflect.get(schema, "$dynamicRef");
  if (typeof reference === "string") {
    // Generation merges the target under the holder's own keywords, so the
    // holder is charged as that merged view. A reference the index cannot
    // resolve leaves the node as it is, and json-schema-faker fails on it.
    const view = state.views(schema);
    return view === schema
      ? LEAF
      : estimateSchema(view, estimates, state, root);
  }

  let height = 0;
  let nodes = 1;
  // Only a schema that can be nothing but a string is certain to emit one.
  let chars = schema.type === "string" ? certainStringLength(schema) : 0;
  /** Keywords the rules below account for; the rest are charged in full. */
  const handled = new Set<string>([
    ...NON_VALUE_KEYWORDS,
    ...SAME_VALUE_KEYWORDS,
  ]);
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
    for (const keyword of ARRAY_KEYWORDS) handled.add(keyword);
    const count = root?.explicitCount ?? effectiveArrayCount(schema);
    // json-schema-faker fills a nested array to maxItems, but the root array
    // is resized per request (determineArrayCount) anywhere from minItems up,
    // so only minItems — or the explicit count — is certain there.
    const certainCount = root
      ? (root.explicitCount ?? schema.minItems ?? 0)
      : count;
    // A Draft-7 tuple becomes json-schema-faker's `prefixItems`, replacing a
    // native one (see `jsfTraversalView`), and its `additionalItems` fills
    // the tail; otherwise a native `prefixItems` leads and `items` fills it.
    const nativePrefix: unknown = Reflect.get(schema, "prefixItems");
    const tuple = Array.isArray(schema.items);
    const positional: unknown[] = Array.isArray(schema.items)
      ? schema.items
      : Array.isArray(nativePrefix)
        ? nativePrefix
        : [];
    let itemNodes = 0;
    let itemChars = 0;
    positional.forEach((item, index) => {
      const child = value(item);
      if (index < count) itemNodes = capped(itemNodes + child.nodes);
      if (index < certainCount) itemChars = capped(itemChars + child.chars);
    });
    const tail = tuple ? schema.additionalItems : schema.items;
    const rest = tail === undefined ? LEAF : value(tail);
    itemNodes = capped(
      itemNodes + Math.max(0, count - positional.length) * rest.nodes,
    );
    itemChars = capped(
      itemChars + Math.max(0, certainCount - positional.length) * rest.chars,
    );

    // json-schema-faker materializes every `containsAll` entry and every
    // `contains` draw, whatever the count. They take the place of items, so
    // charging them on top overstates the array a little and never
    // understates it.
    if (schema.contains !== undefined) {
      itemNodes = capped(
        itemNodes + containsDraws(schema) * value(schema.contains).nodes,
      );
    }
    const containsAll: unknown = Reflect.get(schema, "containsAll");
    if (Array.isArray(containsAll)) {
      for (const entry of containsAll) {
        itemNodes = capped(itemNodes + value(entry).nodes);
      }
    }
    nodes = capped(nodes + itemNodes);
    chars = capped(chars + itemChars);
  }

  if (isObjectLike(schema)) {
    for (const keyword of OBJECT_KEYWORDS) handled.add(keyword);
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

  // validateNode has already rejected a composition keyword that is not a list.
  for (const branch of schema.allOf ?? []) {
    const estimate = sibling(branch);
    nodes = capped(nodes + Math.max(0, estimate.nodes - 1));
    // A branch may constrain the same string this node does, so only the
    // largest floor is certain.
    chars = Math.max(chars, estimate.chars);
  }

  let alternative = 0;
  for (const keyword of ["anyOf", "oneOf"] as const) {
    for (const branch of schema[keyword] ?? []) {
      alternative = Math.max(alternative, sibling(branch).nodes - 1);
    }
  }
  nodes = capped(nodes + Math.max(0, alternative));

  // json-schema-faker merges `if` into the `then` branch and ignores it
  // otherwise, so `then` carries both. Nodes only: the merged maximums can cut
  // an `if` string short, so its characters are not certain.
  const condition = schema.if === undefined ? LEAF : sibling(schema.if);
  let conditional = 0;
  if (schema.then !== undefined) {
    conditional = sibling(schema.then).nodes - 1 + (condition.nodes - 1);
  }
  if (schema.else !== undefined) {
    conditional = Math.max(conditional, sibling(schema.else).nodes - 1);
  }
  nodes = capped(nodes + Math.max(0, conditional));
  if (schema.not !== undefined) sibling(schema.not);

  // Every other generating child (`dependentSchemas`, a schema-valued
  // `dependencies`, an array or object keyword the declared type leaves out
  // above) is charged in full, so a keyword added to SCHEMA_KEYWORDS counts
  // against the node budget before anyone writes a rule for it.
  // A merged view was never walked, so its edges are read off it here.
  const edges =
    state.edges.get(schema) ?? collectContainedSchemaEdges(schema, "$");
  for (const edge of edges) {
    if (!edge.generates || handled.has(edge.keyword)) continue;
    const nested = edge.depthCost === 1;
    const estimate = nested ? value(edge.schema) : sibling(edge.schema);
    // An untyped `contains` still makes json-schema-faker run its draws.
    const copies = edge.keyword === "contains" ? containsDraws(schema) : 1;
    nodes = capped(nodes + copies * estimate.nodes - (nested ? 0 : 1));
  }

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

/**
 * The fewest characters json-schema-faker emits for a string schema: the
 * largest of its `minLength`, the shortest match of the `pattern` it generates
 * from, and the length its faker method is told to produce.
 */
function certainStringLength(schema: FakerAwareSchema): number {
  // A NaN `minLength` is no floor; left in, it would turn the whole
  // estimate into NaN, which no limit comparison catches.
  const minLength =
    typeof schema.minLength === "number" && !Number.isNaN(schema.minLength)
      ? Math.max(0, schema.minLength)
      : 0;
  return Math.max(
    minLength,
    patternLengthFloor(schema),
    fakerLengthFloor(schema.faker),
  );
}

/** Keywords json-schema-faker generates from in place of a `pattern`. */
const PATTERN_OVERRIDES: readonly string[] = [
  "faker",
  "format",
  "enum",
  "const",
  "default",
];

/**
 * The subschemas json-schema-faker merges into a string schema before it
 * generates: every `allOf` entry, the `anyOf` or `oneOf` entry it picks, and
 * the `then` or `else` it applies (with the `if` beside a `then`).
 */
function mergedStringBranches(schema: JSONSchema7): JSONSchema7[] {
  const branches: unknown[] = [];
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const entries = schema[keyword];
    if (Array.isArray(entries)) branches.push(...entries);
  }
  if (schema.then !== undefined) branches.push(schema.if, schema.then);
  branches.push(schema.else);
  return branches.filter(isJSONSchema7);
}

/**
 * The shortest string a `pattern` makes json-schema-faker generate. A
 * `faker`, `format`, `enum`, `const` or `default` replaces the pattern, and a
 * `maxLength` truncates its match. A merged branch can do either, so a branch
 * carrying one of those keywords (or a pattern of its own) drops the floor,
 * and the smallest `maxLength` among the schema and its branches caps it.
 * Branches are read one level deep; a deeper composition that contradicts
 * the pattern can still be charged more than it generates.
 */
function patternLengthFloor(schema: FakerAwareSchema): number {
  if (
    typeof schema.pattern !== "string" ||
    compilePattern(schema.pattern) === undefined ||
    PATTERN_OVERRIDES.some(
      (keyword) => Reflect.get(schema, keyword) !== undefined,
    )
  ) {
    return 0;
  }
  const branches = mergedStringBranches(schema);
  if (
    branches.some((branch) =>
      ["pattern", ...PATTERN_OVERRIDES].some(
        (keyword) => Reflect.get(branch, keyword) !== undefined,
      ),
    )
  ) {
    return 0;
  }
  const floor = cappedBy(
    regexLengthBounds(schema.pattern).min,
    mergedCaps(schema, ...branches).maxLength,
  );
  // json-schema-faker truncates to a NaN maxLength as to zero.
  return Number.isNaN(floor) ? 0 : floor;
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

  // Every walker skips a list or map keyword of the wrong shape, so it would
  // otherwise pass unchecked and reach the estimate below as a raw value.
  const misshapen = misshapenKeyword(schema);
  if (misshapen !== undefined) {
    throw new SchemaValidationError(
      `${path}.${misshapen}`,
      `"${misshapen}" has the wrong shape`,
      "Composition and positional keywords take a list of schemas; property maps take an object",
    );
  }

  // A positional list stays aligned only if every entry is a schema: a
  // dropped entry would shift each later position down one slot.
  for (const keyword of ["items", "prefixItems"]) {
    const positional: unknown = Reflect.get(schema, keyword);
    if (!Array.isArray(positional)) continue;
    positional.forEach((entry: unknown, index) => {
      if (typeof entry !== "boolean" && !isJSONSchema7(entry)) {
        throw new SchemaValidationError(
          `${path}.${keyword}[${index}]`,
          "Positional item schemas must be schema objects or booleans",
          'Use a schema such as { "type": "string" }, or true to allow anything',
        );
      }
    });
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
      throw toError(error);
    }
  }
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

/**
 * The array `count` sizes: the root, or the array a root `$ref`, wrapper-only
 * `allOf` or null union stands for, as generation finds it (index.ts).
 */
function countedArray(
  root: JSONSchema7,
  refs: LocalRefResolver,
  chain?: Set<JSONSchema7>,
): JSONSchema7 | undefined {
  return findRootArray(root, {
    resolve: (schema) => {
      chain?.add(schema);
      const target =
        typeof schema.$ref === "string"
          ? refs.resolve(schema, schema.$ref)
          : undefined;
      return isJSONSchema7(target) ? target : undefined;
    },
    isArray: (schema) => {
      chain?.add(schema);
      return isArrayLike(schema);
    },
    throughNullUnions: true,
  });
}

function normalizeExplicitCount(count: number | undefined): number | undefined {
  if (count === undefined || Number.isNaN(count)) return undefined;
  return Math.floor(Math.max(0, count));
}

/**
 * The most times json-schema-faker generates an array's `contains` schema.
 * It draws a count between `minContains` and `maxContains`, generates that
 * many matches whatever `maxItems` allows, and only then trims the array, so
 * the item count does not bound the work.
 */
function containsDraws(schema: JSONSchema7): number {
  if (schema.contains === undefined) return 0;
  let draws = 1;
  for (const keyword of ["minContains", "maxContains"]) {
    const bound: unknown = Reflect.get(schema, keyword);
    // Math.max with NaN is NaN, which would hide every node estimate above
    // it from MAX_GENERATED_NODES. Infinity stays and trips MAX_ARRAY_SIZE.
    if (typeof bound === "number" && !Number.isNaN(bound)) {
      draws = Math.max(draws, bound);
    }
  }
  return draws;
}

/**
 * Record array-size breaches. `minItems` counts as much as `maxItems`: it is
 * a floor json-schema-faker has to reach, so a large one is exactly as
 * expensive. The `contains` draws count too, and no merged maximum caps them.
 */
function recordDeclaredArrayLimit(
  schema: JSONSchema7,
  path: string,
  state: WalkState,
  caps: MergedCaps,
): void {
  const declared = Math.max(
    cappedBy(
      Math.max(schema.minItems ?? 0, schema.maxItems ?? 0),
      caps.maxItems,
    ),
    containsDraws(schema),
  );
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
  caps: MergedCaps,
): void {
  if (!isObjectLike(schema)) return;

  const properties = new Set(Object.keys(schema.properties ?? {}));
  const requiredExtras = new Set(
    (schema.required ?? []).filter((name) => !properties.has(name)),
  ).size;
  const actual = Math.max(
    cappedBy(schema.minProperties ?? 0, caps.maxProperties),
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
  caps: MergedCaps,
): void {
  if (canGenerateString(schema)) {
    for (const declared of [schema.minLength, schema.maxLength]) {
      if (declared !== undefined) {
        recordStringViolation(cappedBy(declared, caps.maxLength), path, state);
      }
    }
    // json-schema-faker honours a pattern's explicit repetition floor
    // (`a{70000}`) and caps its upper bounds, so the shortest match is what a
    // pattern forces it to generate.
    if (
      typeof schema.pattern === "string" &&
      compilePattern(schema.pattern) !== undefined
    ) {
      const bounds = regexLengthBounds(schema.pattern);
      recordStringViolation(bounds.min, path, state);
      recordPatternGrowth(schema, bounds.longest, path, state);
    }
  }
  // Generation invents a key matching a `patternProperties` pattern, so the
  // pattern's shortest match is a key it is certain to generate, unless the
  // node's const, enum or default is returned instead.
  if (generatesPatternKeys(schema) && isRecord(schema.patternProperties)) {
    for (const source of Object.keys(schema.patternProperties)) {
      if (compilePattern(source) === undefined) continue;
      recordStringViolation(
        regexLengthBounds(source).min,
        `${path}.patternProperties`,
        state,
      );
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

function generatesPatternKeys(schema: JSONSchema7): boolean {
  if (schema.type !== undefined && !hasType(schema, "object")) return false;
  return (
    schema.const === undefined &&
    schema.enum === undefined &&
    schema.default === undefined
  );
}

/**
 * Nested open quantifiers multiply json-schema-faker's repetition cap, so a
 * pattern whose shortest match is one character can still make it build a
 * string of billions before any output check runs. One such string alone
 * passing the whole response budget is refused, unless a keyword that
 * replaces the pattern means it is never built.
 */
function recordPatternGrowth(
  schema: JSONSchema7,
  longest: number,
  path: string,
  state: WalkState,
): void {
  if (
    longest <= MAX_GENERATED_CHARS ||
    state.patternGrowth ||
    PATTERN_OVERRIDES.some(
      (keyword) => Reflect.get(schema, keyword) !== undefined,
    )
  ) {
    return;
  }
  state.patternGrowth = {
    resource: "generated_chars",
    limit: MAX_GENERATED_CHARS,
    actual: longest,
    path: `${path}.pattern`,
  };
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
