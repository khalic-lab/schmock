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

const ROOT_CONTEXT = Symbol("root-schema");
type EnhancementContext = typeof ROOT_CONTEXT | string;

interface EnhancementState {
  cache: Map<JSONSchema7, Map<EnhancementContext, FakerSchema>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enhance each distinct schema/context pair once and preserve shared edges. */
export function enhanceSchemaWithSmartMapping(
  schema: JSONSchema7,
): JSONSchema7 {
  if (!schema || typeof schema !== "object") return schema;
  return enhanceSchema(schema, { cache: new Map() }, ROOT_CONTEXT);
}

function enhanceSchema(
  schema: JSONSchema7,
  state: EnhancementState,
  context: EnhancementContext,
): FakerSchema {
  let contexts = state.cache.get(schema);
  if (!contexts) {
    contexts = new Map();
    state.cache.set(schema, contexts);
  }
  const cached = contexts.get(context);
  if (cached) return cached;

  const enhanced = stripNullableForGeneration({ ...schema } as FakerSchema);
  contexts.set(context, enhanced);

  if (context !== ROOT_CONTEXT && enhanced.faker) {
    if (typeof enhanced.faker === "string") {
      validateFakerMethod(enhanced.faker);
    }
    return enhanced;
  }

  if (enhanced.properties) {
    const properties = { ...enhanced.properties };
    for (const [fieldName, definition] of Object.entries(properties)) {
      if (isJSONSchema7(definition)) {
        properties[fieldName] = enhanceSchema(definition, state, fieldName);
      }
    }
    enhanced.properties = properties;
  }

  for (const keyword of [
    "definitions",
    "$defs",
    "patternProperties",
  ] as const) {
    const definitions = Reflect.get(enhanced, keyword);
    if (!isRecord(definitions)) continue;
    const copied: Record<string, unknown> = { ...definitions };
    for (const [name, definition] of Object.entries(copied)) {
      if (isJSONSchema7(definition)) {
        copied[name] = enhanceSchema(definition, state, ROOT_CONTEXT);
      }
    }
    Reflect.set(enhanced, keyword, copied);
  }

  if (enhanced.dependencies) {
    const dependencies = { ...enhanced.dependencies };
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (!Array.isArray(dependency) && isJSONSchema7(dependency)) {
        dependencies[name] = enhanceSchema(dependency, state, ROOT_CONTEXT);
      }
    }
    enhanced.dependencies = dependencies;
  }

  const dependentSchemas = Reflect.get(enhanced, "dependentSchemas");
  if (isRecord(dependentSchemas)) {
    const copied: Record<string, unknown> = { ...dependentSchemas };
    for (const [name, definition] of Object.entries(copied)) {
      if (isJSONSchema7(definition)) {
        copied[name] = enhanceSchema(definition, state, ROOT_CONTEXT);
      }
    }
    Reflect.set(enhanced, "dependentSchemas", copied);
  }

  if (Array.isArray(enhanced.items)) {
    enhanced.items = enhanced.items.map((item) =>
      isJSONSchema7(item) ? enhanceSchema(item, state, ROOT_CONTEXT) : item,
    );
  } else if (isJSONSchema7(enhanced.items)) {
    enhanced.items = enhanceSchema(enhanced.items, state, ROOT_CONTEXT);
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = enhanced[keyword];
    if (branches) {
      enhanced[keyword] = branches.map((branch) =>
        isJSONSchema7(branch)
          ? enhanceSchema(branch, state, ROOT_CONTEXT)
          : branch,
      );
    }
  }

  for (const keyword of ["prefixItems", "containsAll"] as const) {
    const definitions = Reflect.get(enhanced, keyword);
    if (Array.isArray(definitions)) {
      Reflect.set(
        enhanced,
        keyword,
        definitions.map((definition) =>
          isJSONSchema7(definition)
            ? enhanceSchema(definition, state, ROOT_CONTEXT)
            : definition,
        ),
      );
    }
  }

  for (const keyword of [
    "additionalItems",
    "contains",
    "additionalProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ] as const) {
    const definition = Reflect.get(enhanced, keyword);
    if (isJSONSchema7(definition)) {
      Reflect.set(
        enhanced,
        keyword,
        enhanceSchema(definition, state, ROOT_CONTEXT),
      );
    }
  }

  if (context === ROOT_CONTEXT) {
    if (needsStringFallback(enhanced)) enhanced.faker = "lorem.word";
    return enhanced;
  }

  const hasComposition = enhanced.allOf || enhanced.anyOf || enhanced.oneOf;
  if (hasComposition || enhanced.const !== undefined || enhanced.enum) {
    return enhanced;
  }

  const match = findBestMapping(context, enhanced);
  if (match) {
    const { fakerMethod, format, trueProbability, fakerArgs } = match.mapping;
    enhanced.faker = fakerArgs ? { [fakerMethod]: [fakerArgs] } : fakerMethod;
    if (format && enhanced.format === undefined) enhanced.format = format;
    if (trueProbability !== undefined) {
      enhanced.schmockTrueProbability = trueProbability;
    }
  } else if (needsStringFallback(enhanced)) {
    enhanced.faker = "lorem.word";
  }

  return enhanced;
}
