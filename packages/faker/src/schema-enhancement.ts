import type { JSONSchema7 } from "json-schema";
import { findBestMapping } from "./field-name-matcher.js";
import { isJSONSchema7, validateFakerMethod } from "./validation.js";

/** JSONSchema7 extended with json-schema-faker's `faker` property and schmock markers */
interface FakerSchema extends JSONSchema7 {
  faker?: string | Record<string, unknown>;
  schmockNullable?: boolean;
  schmockTrueProbability?: number;
}

function needsStringFallback(schema: FakerSchema): boolean {
  return (
    schema.type === "string" &&
    schema.faker === undefined &&
    schema.format === undefined &&
    schema.pattern === undefined &&
    schema.enum === undefined &&
    schema.const === undefined &&
    schema.$ref === undefined &&
    schema.minLength === undefined &&
    schema.maxLength === undefined
  );
}

/**
 * Collapse a normalizer-emitted nullable schema back to its non-null shape for
 * the generation pass.
 *
 * The OpenAPI normalizer makes nullability visible to AJV (`type: [T, "null"]`,
 * or `anyOf: [{type:"null"}, rest]` for composition-only schemas). JSF would
 * read that union as a ~50/50 type choice and it also defeats the
 * `type === "string"` gates in `needsStringFallback`/`findBestMapping`, so on
 * the generation path we strip it and let `postProcessGenerated` reintroduce
 * null at ~5%.
 *
 * The `schmockNullable` marker MUST survive: `postProcessGenerated` walks the
 * ENHANCED schema, so dropping it here would silently stop nulls entirely.
 *
 * Contract: the caller passes an already-shallow-copied object; this helper may
 * mutate it in place, and always returns the object to use.
 */
function stripNullableForGeneration(schema: FakerSchema): FakerSchema {
  if (schema.schmockNullable !== true) return schema;

  // `anyOf: [{type:"null"}, rest]` encoding (composition-only nullable).
  // The structural match is deliberately strict — do not loosen it to
  // `anyOf.some(b => b.type === "null")`.
  if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
    const [nullBranch, rest] = schema.anyOf;
    if (
      isJSONSchema7(nullBranch) &&
      nullBranch.type === "null" &&
      Object.keys(nullBranch).length === 1 &&
      isJSONSchema7(rest)
    ) {
      const { anyOf: _dropped, ...wrapper } = schema;
      return { ...rest, ...wrapper, schmockNullable: true };
    }
  }

  // `type: [T, "null"]` encoding
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== "null");
    if (nonNull.length === 1) {
      schema.type = nonNull[0];
    } else if (nonNull.length > 0) {
      schema.type = nonNull;
    }
    // all-null: leave untouched
  }
  if (Array.isArray(schema.enum)) {
    const nonNull = schema.enum.filter((v) => v !== null);
    if (nonNull.length > 0) {
      schema.enum = nonNull;
    }
  }

  return schema;
}

/**
 * @param schema - Schema to enhance
 * @param seen - Nodes on the current descent path. Enhancement recurses through
 *   composition, `additionalProperties` and `patternProperties`, so a cyclic
 *   schema reaching this function directly used to overflow the stack. Cycles
 *   are rejected by `validateSchema` first, but this function is exported and
 *   must not depend on that: a node already being enhanced is handed back
 *   untouched. Removing it on the way out keeps legitimate reuse of one
 *   sub-schema by sibling branches fully enhanced.
 */
export function enhanceSchemaWithSmartMapping(
  schema: JSONSchema7,
  seen: Set<JSONSchema7> = new Set(),
): JSONSchema7 {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (seen.has(schema)) {
    return schema;
  }
  seen.add(schema);
  try {
    return enhanceSchemaNode(schema, seen);
  } finally {
    seen.delete(schema);
  }
}

function enhanceSchemaNode(
  schema: JSONSchema7,
  seen: Set<JSONSchema7>,
): JSONSchema7 {
  const enhanced: FakerSchema = stripNullableForGeneration({
    ...schema,
  } as FakerSchema);

  // Handle object properties
  if (enhanced.properties) {
    enhanced.properties = { ...enhanced.properties };

    for (const [fieldName, fieldSchema] of Object.entries(
      enhanced.properties,
    )) {
      if (isJSONSchema7(fieldSchema)) {
        enhanced.properties[fieldName] = enhanceFieldSchema(
          fieldName,
          fieldSchema,
          seen,
        );
      }
    }
  }

  // Recurse into composition keywords
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = enhanced[keyword];
    if (Array.isArray(branches)) {
      enhanced[keyword] = branches.map((branch) =>
        isJSONSchema7(branch)
          ? enhanceSchemaWithSmartMapping(branch, seen)
          : branch,
      );
    }
  }

  // Recurse into array items
  if (enhanced.items) {
    if (Array.isArray(enhanced.items)) {
      enhanced.items = enhanced.items.map((item) =>
        isJSONSchema7(item) ? enhanceSchemaWithSmartMapping(item, seen) : item,
      );
    } else if (isJSONSchema7(enhanced.items)) {
      enhanced.items = enhanceSchemaWithSmartMapping(enhanced.items, seen);
    }
  }

  // Recurse into additionalProperties
  if (isJSONSchema7(enhanced.additionalProperties)) {
    enhanced.additionalProperties = enhanceSchemaWithSmartMapping(
      enhanced.additionalProperties,
      seen,
    );
  }

  // Recurse into patternProperties — the normalizer recurses into them, so a
  // nullable schema there would otherwise keep its union and get ~50% nulls.
  if (enhanced.patternProperties) {
    const patterned = { ...enhanced.patternProperties };
    for (const [pattern, subSchema] of Object.entries(patterned)) {
      if (isJSONSchema7(subSchema)) {
        patterned[pattern] = enhanceSchemaWithSmartMapping(subSchema, seen);
      }
    }
    enhanced.patternProperties = patterned;
  }

  if (needsStringFallback(enhanced)) {
    enhanced.faker = "lorem.word";
  }

  return enhanced;
}

function enhanceFieldSchema(
  fieldName: string,
  fieldSchema: JSONSchema7,
  seen: Set<JSONSchema7>,
): FakerSchema {
  // A field whose schema is already being enhanced is part of a cycle; hand it
  // back untouched rather than recursing forever.
  if (seen.has(fieldSchema)) {
    return fieldSchema as FakerSchema;
  }

  const enhanced: FakerSchema = stripNullableForGeneration({
    ...fieldSchema,
  } as FakerSchema);

  // If already has faker extension, validate it and don't override.
  // User-supplied faker values are always strings; the object form is only
  // produced internally by this function when fakerArgs are present.
  if (enhanced.faker) {
    if (typeof enhanced.faker === "string") {
      validateFakerMethod(enhanced.faker);
    }
    return enhanced;
  }

  // Recursively enhance nested schemas first
  const hasComposition = enhanced.allOf || enhanced.anyOf || enhanced.oneOf;
  if (enhanced.properties || hasComposition || enhanced.items) {
    // `enhanced` is a fresh copy, so it is tracked through the original node:
    // marking `fieldSchema` is what stops a cycle from recursing forever.
    seen.add(fieldSchema);
    try {
      const recursed = enhanceSchemaNode(enhanced, seen);
      Object.assign(enhanced, recursed);
    } finally {
      seen.delete(fieldSchema);
    }
  }

  // Don't apply field-level faker mapping to composition schemas — the branches define their own types
  if (hasComposition) {
    return enhanced;
  }

  // Don't apply smart mapping when const or enum is defined — these have fixed values
  if (enhanced.const !== undefined || enhanced.enum) {
    return enhanced;
  }

  // Apply smart field name mapping via the scoring matcher
  const match = findBestMapping(fieldName, enhanced);
  if (match) {
    const { fakerMethod, format, trueProbability, fakerArgs } = match.mapping;
    // Use the JSF object form when fakerArgs are present so the options object
    // is forwarded to the faker method (e.g. number.int({ min, max })).
    // JSF calls Q(...J) where J is the value, so we must wrap fakerArgs in an
    // array: { "number.int": [{ min, max }] } → faker.number.int({ min, max }).
    // Fall back to the plain string form when there are no args.
    if (fakerArgs) {
      enhanced.faker = { [fakerMethod]: [fakerArgs] };
    } else {
      enhanced.faker = fakerMethod;
    }
    // A declared format is a contract: never let a name-based mapping clobber
    // it. `findBestMapping` already skips schemas that declare a format, so
    // this is defence in depth for any other route into this branch.
    if (format && enhanced.format === undefined) {
      enhanced.format = format;
    }
    if (trueProbability !== undefined) {
      enhanced.schmockTrueProbability = trueProbability;
    }
  } else if (needsStringFallback(enhanced)) {
    enhanced.faker = "lorem.word";
  }

  return enhanced;
}
