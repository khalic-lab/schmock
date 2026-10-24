import type { JSONSchema7 } from "json-schema";
import { applyExampleValues } from "./example-values.js";
import { isRecord, toJsonSchema } from "./utils.js";

/**
 * Where the parser records the explicit mapping key or implicit component name
 * for the branch at index i, before dereference erases its `$ref`. Written in
 * load-document.ts (`markDiscriminatorValues` /
 * `markDereferencedDiscriminatorValues`); read here; dropped with the whole
 * `discriminator` object below.
 */
const DISCRIMINATOR_VALUES_MARKER = "x-schmock-discriminator-values";

/**
 * Property names a schema node marked `readOnly` / `writeOnly` before
 * normalization erased the flags (and, depending on direction, the properties).
 */
export interface AccessModes {
  readonly readOnly: ReadonlySet<string>;
  readonly writeOnly: ReadonlySet<string>;
}

/**
 * Side table from a normalized node to the access modes its `properties`
 * declared.
 *
 * Deliberately not an in-schema keyword: normalized schemas reach Ajv in
 * `@schmock/validation`, whose fixed vocabulary would reject an unknown key.
 * Keyed on the exact object `normalizeNode` returns, so the lookup follows the
 * schema through `$ref` sharing and the parser's per-direction cache, and simply
 * misses on a copy (an `onSchema` result, an `options.schemas` override).
 */
const accessModesByNode = new WeakMap<object, AccessModes>();

const NO_ACCESS_MODES: AccessModes = {
  readOnly: new Set(),
  writeOnly: new Set(),
};

/**
 * Union the access modes recorded on a normalized schema and its `allOf`
 * branches — the same flattening `collectSchemaProperties` applies.
 *
 * The request direction strips `readOnly` properties and the response direction
 * strips `writeOnly` ones, so this is the only place either name survives.
 */
export function collectAccessModes(
  schema: JSONSchema7 | undefined,
): AccessModes {
  const readOnly = new Set<string>();
  const writeOnly = new Set<string>();
  const seen = new Set<object>();

  const visit = (node: unknown): void => {
    if (!isRecord(node) || seen.has(node)) return;
    seen.add(node);
    const recorded = accessModesByNode.get(node);
    if (recorded) {
      for (const name of recorded.readOnly) readOnly.add(name);
      for (const name of recorded.writeOnly) writeOnly.add(name);
    }
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) visit(branch);
    }
    // A composition-only nullable wraps its node as `anyOf: [{type:"null"}, node]`.
    if (node.schmockNullable === true && Array.isArray(node.anyOf)) {
      for (const branch of node.anyOf) visit(branch);
    }
  };

  visit(schema);
  if (readOnly.size === 0 && writeOnly.size === 0) return NO_ACCESS_MODES;
  return { readOnly, writeOnly };
}

/**
 * Normalize an OpenAPI schema to pure JSON Schema 7 that json-schema-faker understands.
 *
 * Transforms applied:
 * - nullable: true -> validation-visible null (`type: [T, "null"]`, or
 *   `anyOf: [{type:"null"}, rest]` for any schema that composes, typed or
 *   not) plus the `schmockNullable` marker the faker plugin uses to roll nulls
 *   at ~5%
 * - discriminator beside oneOf or anyOf -> required + enum on branches
 * - readOnly/writeOnly -> strip based on direction (names recorded, see
 *   {@link collectAccessModes})
 * - example, or else the 3.1 `examples` entries -> what a scalar node
 *   generates, counting only values the node accepts (see
 *   {@link applyExampleValues}); a `default` still pins
 * - exclusiveMinimum/exclusiveMaximum boolean -> number format
 * - x-* extensions -> stripped
 * - a cycle -> ended where generation can stop: an optional property closing
 *   it is left out of an open object, an array of the enclosing schema
 *   defaults to `[]`, and any other back-reference becomes an open schema that
 *   generates `null`
 *
 * The input is never modified, and neither is any node shared inside it.
 */
export function normalizeSchema(
  schema: Record<string, unknown>,
  direction: "request" | "response",
): JSONSchema7 {
  const input = structuredClone(schema);
  return normalizeNode(input, {
    direction,
    stack: new Set<object>(),
    memo: new Map<object, JSONSchema7>(),
    canLeaveOutBackReferences: !closesEvaluation(input),
  });
}

/** One {@link normalizeSchema} call's traversal state. */
interface NormalizePass {
  readonly direction: "request" | "response";
  /** Input nodes still being normalized, the ancestors of the current one. */
  readonly stack: Set<object>;
  /** Every input node normalized so far, by identity. */
  readonly memo: Map<object, JSONSchema7>;
  /**
   * May an optional property closing a cycle be left out of an open object?
   * Decided once for the whole schema, never per position: a normalized node
   * is memoized and reused wherever its input occurs again.
   */
  readonly canLeaveOutBackReferences: boolean;
}

/**
 * Does anything in `schema` set `unevaluatedProperties` to something other
 * than `true`?
 *
 * That keyword reaches through `allOf`, `anyOf`, `oneOf`, `$ref` and the
 * conditionals: a 3.1 composition closed with `unevaluatedProperties: false`
 * accepts only the names its branches declare. A property one branch left out
 * of `properties` becomes a name nothing declares, and the composer rejects it,
 * however open the branch itself looks. Which composer a memoized branch ends
 * up under is not known while it is normalized, so the answer covers the whole
 * schema.
 */
function closesEvaluation(schema: unknown, seen = new Set<object>()): boolean {
  if (typeof schema !== "object" || schema === null || seen.has(schema)) {
    return false;
  }
  seen.add(schema);
  if (
    !Array.isArray(schema) &&
    "unevaluatedProperties" in schema &&
    schema.unevaluatedProperties !== true &&
    schema.unevaluatedProperties !== undefined
  ) {
    return true;
  }
  return Object.values(schema).some((value) => closesEvaluation(value, seen));
}

/**
 * Apply nullability to an already-normalized node in a form AJV can see.
 *
 * The `schmockNullable` marker alone leaves the non-null `type` in place, so a
 * generated `null` fails the plugin's own validator. Every branch below emits a
 * schema that accepts `null` and keeps the marker so `applyNullableRolls`
 * still rolls nulls at ~5%.
 */
function applyNullability(
  node: Record<string, unknown>,
): Record<string, unknown> {
  if (node.allOf || node.anyOf || node.oneOf || node.$ref) {
    // A composing node (the standard `allOf: [{$ref}], nullable: true` idiom)
    // moves whole into the non-null branch. Widening only its `type` left the
    // branches demanding the non-null type, so null still failed.
    return { anyOf: [{ type: "null" }, node], schmockNullable: true };
  }
  if (typeof node.type === "string") {
    node.type = [node.type, "null"];
  } else if (Array.isArray(node.type)) {
    if (!node.type.includes("null")) {
      node.type = [...node.type, "null"];
    }
  }
  // A typeless, composition-free node accepts null by type — but an `enum` or
  // `const` still constrains the value regardless of `type`, so it falls
  // through to the same value fix-up as the typed branches.

  // A union type alone still rejects null when an enum or const constrains the
  // values.
  if ("const" in node) {
    const value = node.const;
    delete node.const;
    node.enum = value === null ? [null] : [value, null];
  } else if (Array.isArray(node.enum) && !node.enum.includes(null)) {
    node.enum = [...node.enum, null];
  }

  node.schmockNullable = true;
  return node;
}

/**
 * What a reference back into a schema still being normalized becomes.
 *
 * The cut has two readers. AJV validates requests, stored rows and generated
 * bodies against it, so it must accept whatever nesting real data carries, as
 * an unconstrained schema does. @schmock/faker generates from it and rejects
 * an empty schema, so `{}` failed every request. `default` is an annotation to
 * AJV, and json-schema-faker returns it verbatim, so generation ends in `null`.
 *
 * Where the schema uses `unevaluatedProperties`, the cut also evaluates every
 * name. As a property or an item that changes nothing; as an `anyOf` or
 * `oneOf` branch it stands in for the names the branch would have declared,
 * which the closed composer above it still expects to see evaluated.
 *
 * Optional properties and arrays end the recursion before it gets here; see
 * {@link reachesBackReference}.
 */
function recursionCut(pass: NormalizePass): JSONSchema7 {
  return pass.canLeaveOutBackReferences
    ? { default: null }
    : toJsonSchema({ default: null, unevaluatedProperties: true });
}

/**
 * Does `schema` lead straight back into a schema still being normalized,
 * itself or through the `allOf` wrapper a 3.0 `$ref` with siblings is written
 * as? A property or an array item like that is where a generated instance can
 * end the recursion within the contract: the optional property is left out
 * and the array is empty.
 */
function reachesBackReference(
  schema: Record<string, unknown>,
  stack: ReadonlySet<object>,
  seen: Set<object> = new Set(),
): boolean {
  if (stack.has(schema)) return true;
  if (seen.has(schema)) return false;
  seen.add(schema);
  return (
    Array.isArray(schema.allOf) &&
    schema.allOf.some(
      (branch: unknown) =>
        isRecord(branch) && reachesBackReference(branch, stack, seen),
    )
  );
}

/**
 * Can a property be left out of `properties` without this object rejecting it?
 * Only when nothing else here constrains the undeclared key. An enclosing
 * `unevaluatedProperties` is {@link closesEvaluation}'s to rule out.
 */
function acceptsUndeclaredProperties(node: Record<string, unknown>): boolean {
  const open = (value: unknown) => value === undefined || value === true;
  return (
    open(node.additionalProperties) &&
    open(node.unevaluatedProperties) &&
    node.patternProperties === undefined
  );
}

/**
 * Copy a normalized node's recorded access modes onto a derived copy, so
 * {@link collectAccessModes} still finds them through the copy.
 */
function inheritAccessModes(copy: object, source: object): void {
  const recorded = accessModesByNode.get(source);
  if (recorded) accessModesByNode.set(copy, recorded);
}

/**
 * A discriminated branch, required to carry the discriminator property and,
 * when load-document.ts resolved its mapping values, pinned to them.
 *
 * Returns a copy: the normalized branch is memoized, so the same component
 * used outside this composition must not pick up the pin.
 */
function pinDiscriminator(
  branch: JSONSchema7,
  propName: string,
  marked: unknown,
): JSONSchema7 {
  const required = Array.isArray(branch.required) ? [...branch.required] : [];
  if (!required.includes(propName)) required.push(propName);
  const pinned: JSONSchema7 = { ...branch, required };

  const mappingValues = Array.isArray(marked)
    ? marked.filter((value): value is string => typeof value === "string")
    : [];
  if (mappingValues.length > 0) {
    const props = isRecord(branch.properties) ? branch.properties : {};
    const existing = isRecord(props[propName]) ? props[propName] : {};
    pinned.properties = {
      ...props,
      [propName]: { ...existing, enum: mappingValues },
    };
  }

  inheritAccessModes(pinned, branch);
  return pinned;
}

/**
 * `schema` with `names` dropped from its `required` list and from those of the
 * branches {@link collectAccessModes} flattens (`allOf`, and the nullable
 * `anyOf` wrapper). Unchanged nodes come back as they are; a changed one is a
 * copy, because normalized nodes are memoized and shared.
 */
function withoutRequired(
  schema: Record<string, unknown>,
  names: ReadonlySet<string>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...schema };
  let changed = false;

  const required = schema.required;
  if (Array.isArray(required) && required.some((name) => names.has(name))) {
    const kept = required.filter((name) => !names.has(name));
    if (kept.length > 0) copy.required = kept;
    else delete copy.required;
    changed = true;
  }

  const keywords =
    schema.schmockNullable === true ? ["allOf", "anyOf"] : ["allOf"];
  for (const keyword of keywords) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    const next = branches.map((branch: unknown) =>
      isRecord(branch) ? withoutRequired(branch, names) : branch,
    );
    if (next.some((branch, index) => branch !== branches[index])) {
      copy[keyword] = next;
      changed = true;
    }
  }

  if (!changed) return schema;
  inheritAccessModes(copy, schema);
  return copy;
}

function normalizeNode(
  input: Record<string, unknown>,
  pass: NormalizePass,
): JSONSchema7 {
  const { direction, stack, memo } = pass;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return toJsonSchema({});
  }

  // Already normalized in this pass — `$ref` dereference makes two occurrences
  // of one component the SAME object, and they must both normalize fully.
  const cached = memo.get(input);
  if (cached) {
    return cached;
  }

  // Circular reference detection — break true cycles (node is on the stack)
  if (stack.has(input)) {
    return recursionCut(pass);
  }
  stack.add(input);

  // Everything below writes to this copy, never to `input`. Dereferencing
  // shares one object between every use of a component, and a `$ref` with
  // siblings is a fresh object that still shares its target's `properties`
  // and `required`: a change made in place leaked into every other use.
  let node: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith("x-")) node[key] = value;
  }

  const isNullable = node.nullable === true;
  delete node.nullable;
  // The parent's `properties` loop reads these from the input; the normalized
  // schema carries them only as recorded access modes.
  delete node.readOnly;
  delete node.writeOnly;
  const readOnlyNames: string[] = [];
  const writeOnlyNames: string[] = [];

  // Handle discriminator, which OAS allows beside oneOf or anyOf
  let discriminated: "oneOf" | "anyOf" | undefined;
  if (node.discriminator && isRecord(node.discriminator)) {
    const disc = node.discriminator;
    const propName = disc.propertyName;
    const keyword = Array.isArray(node.oneOf)
      ? "oneOf"
      : Array.isArray(node.anyOf)
        ? "anyOf"
        : undefined;
    const branches = keyword ? node[keyword] : undefined;
    if (typeof propName === "string" && keyword && Array.isArray(branches)) {
      // Explicit mapping keys or implicit `$ref` component names are resolved
      // BEFORE dereference in load-document.ts (`markDiscriminatorValues` /
      // `markDereferencedDiscriminatorValues`) and handed over index-aligned
      // here.
      const resolvedRaw = disc[DISCRIMINATOR_VALUES_MARKER];
      const resolved = Array.isArray(resolvedRaw) ? resolvedRaw : undefined;

      node[keyword] = branches.map((branch: unknown, index) =>
        isRecord(branch)
          ? pinDiscriminator(
              normalizeNode(branch, pass),
              propName,
              resolved?.[index],
            )
          : branch,
      );
      discriminated = keyword;
    }
    delete node.discriminator;
  }

  // Handle readOnly/writeOnly on properties
  if (isRecord(node.properties)) {
    const declaredRequired = Array.isArray(node.required)
      ? node.required.filter((r): r is string => typeof r === "string")
      : [];
    const props: Record<string, unknown> = {};
    const stripped: string[] = [];
    const canLeaveOut =
      pass.canLeaveOutBackReferences && acceptsUndeclaredProperties(node);

    for (const [propName, propSchema] of Object.entries(node.properties)) {
      if (!isRecord(propSchema)) {
        props[propName] = propSchema;
        continue;
      }

      // Read, never deleted: every property referencing one component shares
      // its object, and each of them has to see the flag.
      if (propSchema.readOnly === true) readOnlyNames.push(propName);
      if (propSchema.writeOnly === true) writeOnlyNames.push(propName);

      // readOnly fields leave request schemas, writeOnly ones response schemas
      if (
        (direction === "request" && propSchema.readOnly === true) ||
        (direction === "response" && propSchema.writeOnly === true)
      ) {
        stripped.push(propName);
        continue;
      }

      // An optional property that closes a cycle is where generation stops.
      // Undeclared, it still validates as anything, just as the cut would.
      if (
        canLeaveOut &&
        !declaredRequired.includes(propName) &&
        reachesBackReference(propSchema, stack)
      ) {
        continue;
      }

      props[propName] = normalizeNode(propSchema, pass);
    }
    node.properties = props;

    const required = declaredRequired.filter(
      (name) => !stripped.includes(name),
    );
    if (required.length > 0) {
      node.required = required;
    } else if (stripped.length > 0 && Array.isArray(node.required)) {
      // Every required field was stripped
      delete node.required;
    }
  }

  // Handle exclusiveMinimum/exclusiveMaximum boolean -> number
  if (node.exclusiveMinimum === true && typeof node.minimum === "number") {
    node.exclusiveMinimum = node.minimum;
    delete node.minimum;
  } else if (node.exclusiveMinimum === false) {
    delete node.exclusiveMinimum;
  }

  if (node.exclusiveMaximum === true && typeof node.maximum === "number") {
    node.exclusiveMaximum = node.maximum;
    delete node.maximum;
  } else if (node.exclusiveMaximum === false) {
    delete node.exclusiveMaximum;
  }

  // A scalar node generates from its own examples, once the bounds above are
  // numeric: an example the node rejects is never generated.
  applyExampleValues(node, isNullable);
  delete node.example;

  // Recurse into items (array schema)
  if (node.items) {
    if (Array.isArray(node.items)) {
      node.items = node.items.map((item: unknown) =>
        isRecord(item) ? normalizeNode(item, pass) : item,
      );
    } else if (isRecord(node.items)) {
      const closesCycle = reachesBackReference(node.items, stack);
      node.items = normalizeNode(node.items, pass);
      // An array of the enclosing schema ends the recursion empty, unless it
      // must hold items; those generate from the cut instead.
      const minItems = typeof node.minItems === "number" ? node.minItems : 0;
      if (closesCycle && minItems === 0 && !("default" in node)) {
        node.default = [];
      }
    }
  }

  // Recurse into additionalProperties
  if (isRecord(node.additionalProperties)) {
    node.additionalProperties = normalizeNode(node.additionalProperties, pass);
  }

  // Recurse into composition keywords (discriminated branches are done)
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (keyword === discriminated) continue;
    const declared = node[keyword];
    if (!Array.isArray(declared)) continue;
    let branches: unknown[] = declared;
    if (keyword === "allOf") {
      // An `allOf` branch closing a cycle (`allOf: [$ref Self]` beside
      // `nullable` or a description) would be cut to a schema that constrains
      // nothing, and json-schema-faker merges `allOf` without its `default`.
      // Drop it, and let this node end the recursion in `null` instead.
      const kept = branches.filter(
        (branch: unknown) => !(isRecord(branch) && stack.has(branch)),
      );
      if (kept.length < branches.length) {
        if (!("default" in node)) node.default = null;
        // The dropped branch declared names that an `unevaluatedProperties`
        // here or on an enclosing composer still expects to see evaluated.
        // Evaluating every name here keeps the cut open to real data, and
        // unlike an added branch it leaves the `null` default generating.
        if (!pass.canLeaveOutBackReferences) {
          node.unevaluatedProperties = true;
        }
        if (kept.length === 0) {
          delete node.allOf;
          continue;
        }
        branches = kept;
      }
    }
    node[keyword] = branches.map((branch: unknown) =>
      isRecord(branch) ? normalizeNode(branch, pass) : branch,
    );
  }

  // A stripped name stays required wherever another allOf branch, or this
  // node, lists it. OAS applies a required readOnly property to responses
  // only and a required writeOnly one to requests only, so prune it there too.
  if (Array.isArray(node.allOf)) {
    const branchModes = collectAccessModes(toJsonSchema({ allOf: node.allOf }));
    const stripped = new Set(
      direction === "request"
        ? [...readOnlyNames, ...branchModes.readOnly]
        : [...writeOnlyNames, ...branchModes.writeOnly],
    );
    if (stripped.size > 0) node = withoutRequired(node, stripped);
  }

  // Recurse into not
  if (isRecord(node.not)) {
    node.not = normalizeNode(node.not, pass);
  }

  // Recurse into conditional
  for (const keyword of ["if", "then", "else"]) {
    const keywordValue = node[keyword];
    if (isRecord(keywordValue)) {
      node[keyword] = normalizeNode(keywordValue, pass);
    }
  }

  // Recurse into patternProperties
  if (isRecord(node.patternProperties)) {
    const pp: Record<string, unknown> = {};
    for (const [pattern, schema] of Object.entries(node.patternProperties)) {
      pp[pattern] = isRecord(schema) ? normalizeNode(schema, pass) : schema;
    }
    node.patternProperties = pp;
  }

  const out = toJsonSchema(isNullable ? applyNullability(node) : node);
  if (readOnlyNames.length > 0 || writeOnlyNames.length > 0) {
    accessModesByNode.set(out, {
      readOnly: new Set(readOnlyNames),
      writeOnly: new Set(writeOnlyNames),
    });
  }
  stack.delete(input);
  memo.set(input, out);
  return out;
}
