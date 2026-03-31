import type { JSONSchema7 } from "json-schema";
import { findBestMapping } from "./field-name-matcher.js";
import { isJSONSchema7, validateFakerMethod } from "./validation.js";

/** JSONSchema7 extended with json-schema-faker's `faker` property and schmock markers */
interface FakerSchema extends JSONSchema7 {
  faker?: string;
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

  // If already has faker extension, validate it and don't override
  if (enhanced.faker) {
    validateFakerMethod(enhanced.faker);
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
    enhanced.faker = match.mapping.fakerMethod;
    if (match.mapping.format) {
      enhanced.format = match.mapping.format;
    }
    if (match.mapping.trueProbability !== undefined) {
      enhanced.schmockTrueProbability = match.mapping.trueProbability;
    }
  }

  return enhanced;
}
