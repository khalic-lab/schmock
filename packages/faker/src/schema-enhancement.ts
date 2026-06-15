import type { JSONSchema7 } from "json-schema";
import { findBestMapping } from "./field-name-matcher.js";
import { isJSONSchema7, validateFakerMethod } from "./validation.js";

/** JSONSchema7 extended with json-schema-faker's `faker` property and schmock markers */
interface FakerSchema extends JSONSchema7 {
  faker?: string | Record<string, unknown>;
  schmockNullable?: boolean;
  schmockTrueProbability?: number;
}

export function enhanceSchemaWithSmartMapping(
  schema: JSONSchema7,
): JSONSchema7 {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const enhanced = { ...schema } as FakerSchema;

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
        );
      }
    }
  }

  // Recurse into composition keywords
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = enhanced[keyword];
    if (Array.isArray(branches)) {
      (enhanced as Record<string, unknown>)[keyword] = branches.map((branch) =>
        isJSONSchema7(branch) ? enhanceSchemaWithSmartMapping(branch) : branch,
      );
    }
  }

  // Recurse into array items
  if (enhanced.items) {
    if (Array.isArray(enhanced.items)) {
      enhanced.items = enhanced.items.map((item) =>
        isJSONSchema7(item) ? enhanceSchemaWithSmartMapping(item) : item,
      );
    } else if (isJSONSchema7(enhanced.items)) {
      enhanced.items = enhanceSchemaWithSmartMapping(enhanced.items);
    }
  }

  // Recurse into additionalProperties
  if (
    enhanced.additionalProperties &&
    typeof enhanced.additionalProperties === "object" &&
    !Array.isArray(enhanced.additionalProperties)
  ) {
    enhanced.additionalProperties = enhanceSchemaWithSmartMapping(
      enhanced.additionalProperties as JSONSchema7,
    );
  }

  return enhanced;
}

function enhanceFieldSchema(
  fieldName: string,
  fieldSchema: JSONSchema7,
): FakerSchema {
  const enhanced: FakerSchema = { ...fieldSchema };

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
    const recursed = enhanceSchemaWithSmartMapping(enhanced);
    Object.assign(enhanced, recursed);
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
    if (format) {
      enhanced.format = format;
    }
    if (trueProbability !== undefined) {
      enhanced.schmockTrueProbability = trueProbability;
    }
  }

  return enhanced;
}
