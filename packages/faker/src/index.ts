import type * as Schmock from "@schmock/core";
import {
  ResourceLimitError,
  SchemaGenerationError,
  SchemaValidationError,
} from "@schmock/core";
import { toError } from "@schmock/core/adapter";
import type { JSONSchema7 } from "json-schema";
import { version as packageVersion } from "../package.json";
import {
  MAX_ARRAY_SIZE,
  MAX_GENERATED_NODES,
  MAX_NESTING_DEPTH,
  MAX_OBJECT_PROPERTIES,
  MAX_SCHEMA_NODES,
  MAX_STRING_LENGTH,
} from "./constants.js";
import {
  createSeededRandom,
  DETERMINISTIC_REF_DATE,
  generateWithJsf,
  resolveGenerationSeed,
  snapshotGraphs,
} from "./jsf-config.js";
import { assertOutputWithinLimits } from "./output-limits.js";
import { applyOverrides, determineArrayCount } from "./overrides.js";
import { applyNullableRolls, resolveLocalRef } from "./post-process.js";
import { enhanceSchemaWithSmartMapping } from "./schema-enhancement.js";
import { isJSONSchema7, isRecord } from "./utils.js";
import { hasType, validateSchema } from "./validation.js";

export type SchemaGenerationContext = Schmock.SchemaGenerationContext;

export type FakerPluginOptions = Schmock.FakerPluginOptions;

/**
 * Every generation ceiling, so callers can pre-check their input. A breach is
 * reported as a `ResourceLimitError` naming the exceeded `resource`.
 */
export {
  MAX_ARRAY_SIZE,
  MAX_GENERATED_NODES,
  MAX_NESTING_DEPTH,
  MAX_OBJECT_PROPERTIES,
  MAX_SCHEMA_NODES,
  MAX_STRING_LENGTH,
};

/** A schema that passed `validateSchema`, with its smart-mapping enhancement. */
interface PreparedSchema {
  schema: JSONSchema7;
  enhanced: JSONSchema7;
}

/** Pair a schema that already passed `validateSchema` with its enhancement. */
function enhancePrepared(schema: JSONSchema7): PreparedSchema {
  return { schema, enhanced: enhanceSchemaWithSmartMapping(schema) };
}

function prepareSchema(schema: JSONSchema7, count?: number): PreparedSchema {
  validateSchema(schema, "$", count);
  return enhancePrepared(schema);
}

export function fakerPlugin(options: FakerPluginOptions): Schmock.Plugin {
  const [schemaSnapshot, overridesSnapshot] = snapshotGraphs([
    options.schema,
    options.overrides,
  ]);
  if (!isJSONSchema7(schemaSnapshot)) {
    throw new SchemaValidationError(
      "$",
      "Schema must be a valid JSON Schema object",
    );
  }
  if (overridesSnapshot !== undefined && !isRecord(overridesSnapshot)) {
    throw new SchemaValidationError(
      "$.overrides",
      "Overrides must be an object mapping paths to values",
    );
  }
  const schema = schemaSnapshot;
  const overrides = overridesSnapshot;
  const count = options.count;
  const seed = options.seed;

  // Validate schema immediately when plugin is created (fail-fast)
  validateSchema(schema, "$", count);

  // The snapshot is private and never mutated, so the validation above holds
  // for every request; only the enhancement is deferred to the first one.
  let prepared: PreparedSchema | undefined;

  return {
    name: "faker",
    version: packageVersion,

    async process(context: Schmock.PluginContext, response?: unknown) {
      // If response already exists, pass it through
      if (response !== undefined && response !== null) {
        return { context, response };
      }

      try {
        prepared ??= enhancePrepared(schema);
        const generatedResponse = await generateFromPrepared(prepared, {
          schema,
          count,
          overrides,
          params: context.params,
          state: context.routeState,
          query: context.query,
          seed,
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

        // Wrap other errors, describing a non-Error throw the way core does
        throw new SchemaGenerationError(context.path, toError(error), schema);
      }
    },
  };
}

/**
 * Generate a value from a JSON Schema.
 *
 * The schema is validated on every call: the caller owns it and may change it
 * between calls (an OpenAPI `onSchema` hook can edit a schema in place), so a
 * cached verdict could be stale. `fakerPlugin` validates its private snapshot
 * once instead.
 */
export async function generateFromSchema(
  options: SchemaGenerationContext,
): Promise<unknown> {
  return generateFromPrepared(
    prepareSchema(options.schema, options.count),
    options,
  );
}

/** The enhancer's null-roll markers, which a resized root must keep. */
const NULLABLE_MARKERS = ["schmockNullable", "schmockNullAlternative"];

/** Keys that leave a single-entry `allOf` root standing for its entry alone. */
const ALLOF_WRAPPER_KEYS = new Set([
  "allOf",
  "$schema",
  "$id",
  "$comment",
  "$defs",
  "definitions",
  "title",
  "description",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  ...NULLABLE_MARKERS,
]);

/** An array json-schema-faker generates with items it can size. */
function isSizableArray(schema: JSONSchema7): boolean {
  if (schema.items === undefined) return false;
  return hasType(schema, "array") || schema.type === undefined;
}

/**
 * The array node a root value is generated from: the root itself, or what a
 * root `$ref` (whose siblings JSF ignores) or a single-entry `allOf` with
 * nothing else to merge stands for. A null union is already unwrapped by the
 * enhancer. Undefined when the root is not such an array.
 */
function findRootArray(root: JSONSchema7): JSONSchema7 | undefined {
  const visited = new Set<JSONSchema7>();
  let node: JSONSchema7 | undefined = root;
  while (node && !visited.has(node)) {
    visited.add(node);
    if (isSizableArray(node)) return node;
    if (typeof node.$ref === "string") {
      node = resolveLocalRef(node, root);
    } else if (
      node.allOf?.length === 1 &&
      Object.keys(node).every((key) => ALLOF_WRAPPER_KEYS.has(key)) &&
      isJSONSchema7(node.allOf[0])
    ) {
      const [entry] = node.allOf;
      node =
        typeof entry.$ref === "string" ? resolveLocalRef(entry, root) : entry;
    } else {
      node = undefined;
    }
  }
  return undefined;
}

/**
 * `root` with `array` fixed at `itemCount` items. A root reached through a
 * `$ref` or `allOf` is replaced by that array, keeping the root's
 * definitions so every reference inside still resolves (the array's own
 * `$defs` shadow the root's, as they do while JSF walks it), and the root's
 * null-roll markers, so a nullable root still rolls null.
 */
function sizeRootArray(
  root: JSONSchema7,
  array: JSONSchema7,
  itemCount: number,
): JSONSchema7 {
  const sized: JSONSchema7 = {
    ...array,
    minItems: itemCount,
    maxItems: itemCount,
  };
  if (array === root) return sized;
  if (root.$defs !== undefined || array.$defs !== undefined) {
    sized.$defs = { ...root.$defs, ...array.$defs };
  }
  if (root.definitions !== undefined) sized.definitions = root.definitions;
  for (const marker of NULLABLE_MARKERS) {
    if (Reflect.get(root, marker) === true) Reflect.set(sized, marker, true);
  }
  return sized;
}

async function generateFromPrepared(
  prepared: PreparedSchema,
  options: SchemaGenerationContext,
): Promise<unknown> {
  const { count, overrides, params, state, query, seed } = options;

  const generationSeed = resolveGenerationSeed(seed);
  const random = createSeededRandom(generationSeed);

  let enhancedSchema = prepared.enhanced;

  // Resolve the top-level array size once, then let JSF generate the complete
  // array so tuple positions, uniqueness, and a seeded sequence are preserved.
  const rootArray = findRootArray(enhancedSchema);
  if (rootArray) {
    const itemCount = determineArrayCount(rootArray, count, random);

    if (itemCount > MAX_ARRAY_SIZE) {
      throw new ResourceLimitError("array_size", MAX_ARRAY_SIZE, itemCount);
    }

    enhancedSchema = sizeRootArray(enhancedSchema, rootArray, itemCount);
  }

  // A caller-supplied seed promises reproducible output, so date fields are
  // anchored to a fixed reference date instead of the wall clock. Unseeded
  // generation stays wall-clock relative (`date.future` must stay in the future).
  let generated: unknown = await generateWithJsf(
    enhancedSchema,
    generationSeed,
    seed !== undefined ? DETERMINISTIC_REF_DATE : undefined,
  );
  generated = applyNullableRolls(generated, enhancedSchema, random);

  if (Array.isArray(generated)) {
    const result = generated.map((item) =>
      applyOverrides(item, overrides, params, state, query),
    );
    assertOutputWithinLimits(result);
    return result;
  }

  generated = applyOverrides(generated, overrides, params, state, query);
  assertOutputWithinLimits(generated);
  return generated;
}
