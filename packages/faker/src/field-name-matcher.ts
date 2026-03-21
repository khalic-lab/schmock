import type { JSONSchema7 } from "json-schema";
import type { FieldMapping } from "./field-mappings.js";
import { ALL_FIELD_MAPPINGS } from "./field-mappings.js";

/**
 * Split a field name (camelCase, snake_case, kebab-case) into lowercase tokens.
 * "userFirstName" → ["user", "first", "name"]
 * "created_at"    → ["created", "at"]
 * "HTMLParser"    → ["html", "parser"]
 * "is_active"     → ["is", "active"]
 */
export function tokenizeFieldName(name: string): string[] {
  // Split on _ and -
  const parts = name.split(/[_-]/);
  const tokens: string[] = [];

  for (const part of parts) {
    if (!part) continue;
    // Split camelCase and consecutive uppercase (e.g., HTMLParser → HTML, Parser)
    const camelTokens = part
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .split("_");

    for (const t of camelTokens) {
      if (t) tokens.push(t.toLowerCase());
    }
  }

  return tokens;
}

/**
 * Score how well a set of keyword tokens matches field name tokens.
 * Returns 0-1:
 *   1.0 — exact full match (joined tokens equal joined keywords)
 *   0.9 — all keyword tokens found in field tokens with high coverage (>50%)
 *   0.8 — field ends with keyword tokens
 *   0.7 — substring match (keyword appears in joined field name)
 *   0.65 — all keyword tokens found but low coverage (<=50%)
 */
export function scoreMatch(fieldTokens: string[], keywords: string[]): number {
  const fieldJoined = fieldTokens.join("");

  let bestScore = 0;

  // Try each keyword variant, keep the highest score
  for (const keyword of keywords) {
    const kwTokens = tokenizeFieldName(keyword);
    const kwJoined = kwTokens.join("");

    // Exact match: joined tokens are identical
    if (fieldJoined === kwJoined) return 1.0;

    // All keyword tokens present in field tokens with high coverage
    if (
      kwTokens.length > 0 &&
      kwTokens.every((kt) => fieldTokens.includes(kt))
    ) {
      const coverage = kwTokens.length / fieldTokens.length;
      const score = coverage > 0.5 ? 0.9 : 0.65;
      bestScore = Math.max(bestScore, score);
    }

    // Field ends with keyword tokens
    if (kwTokens.length > 0 && kwTokens.length <= fieldTokens.length) {
      const tail = fieldTokens.slice(-kwTokens.length);
      if (tail.every((t, i) => t === kwTokens[i])) {
        bestScore = Math.max(bestScore, 0.8);
      }
    }

    // Substring match: keyword joined appears in field joined
    if (kwJoined.length >= 3 && fieldJoined.includes(kwJoined)) {
      bestScore = Math.max(bestScore, 0.7);
    }
  }

  return bestScore;
}

interface MatchResult {
  mapping: FieldMapping;
  score: number;
}

/**
 * Find the best field mapping for a given field name and schema.
 * Returns the highest-scoring match above its threshold, or undefined.
 */
export function findBestMapping(
  fieldName: string,
  schema: JSONSchema7,
  mappings: FieldMapping[] = ALL_FIELD_MAPPINGS,
): MatchResult | undefined {
  const schemaAny = schema as Record<string, unknown>;
  const schemaType = typeof schema.type === "string" ? schema.type : undefined;

  // Priority: format:uuid always maps to string.uuid
  if (schemaType === "string" && schema.format === "uuid") {
    return {
      mapping: {
        keywords: ["uuid"],
        fakerMethod: "string.uuid",
        schemaType: "string",
        minScore: 0.5,
      },
      score: 1.0,
    };
  }

  // Skip if schema already has pattern, enum, or faker constraint
  if (schemaAny.pattern || schemaAny.enum || schemaAny.faker) {
    return undefined;
  }

  // Skip numeric faker mapping when schema already constrains the range
  const hasNumericConstraints =
    schema.minimum !== undefined ||
    schema.maximum !== undefined ||
    schema.exclusiveMinimum !== undefined ||
    schema.exclusiveMaximum !== undefined;

  const tokens = tokenizeFieldName(fieldName);

  let best: MatchResult | undefined;

  for (const mapping of mappings) {
    // Skip numeric faker mappings when schema has explicit constraints
    if (
      hasNumericConstraints &&
      (mapping.schemaType === "number" || mapping.schemaType === "integer")
    ) {
      continue;
    }

    // Check schema type constraint
    if (mapping.schemaType && schemaType && mapping.schemaType !== schemaType) {
      const isNumeric =
        (mapping.schemaType === "number" && schemaType === "integer") ||
        (mapping.schemaType === "integer" && schemaType === "number");
      if (!isNumeric) continue;
    }

    const score = scoreMatch(tokens, mapping.keywords);
    if (score >= mapping.minScore && (!best || score > best.score)) {
      best = { mapping, score };
    }
  }

  // ID suffix detection: fields ending in Id/_id with string type → UUID
  // Only if no better match was found or the existing match is weak
  if (schemaType === "string") {
    const lastToken = tokens[tokens.length - 1];
    if (lastToken === "id" && tokens.length > 1) {
      const idScore = 0.8;
      if (!best || best.score < idScore) {
        best = {
          mapping: {
            keywords: ["id"],
            fakerMethod: "string.uuid",
            schemaType: "string",
            minScore: 0.5,
          },
          score: idScore,
        };
      }
    }
  }

  return best;
}
