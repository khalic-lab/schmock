import type { JSONSchema7 } from "json-schema";
import type { FieldMapping } from "./field-mappings.js";
import { ALL_FIELD_MAPPINGS } from "./field-mappings.js";

/**
 * Formats json-schema-faker can actually generate a value for.
 *
 * Deferring to a declared `format` only helps when something downstream honors
 * it. A spec is free to declare a vocabulary format nothing implements
 * (`format: iso-country-code` in the wild), and for those json-schema-faker
 * falls back to an arbitrary string — strictly worse than the name-based
 * mapping this module would otherwise supply. So the skip below applies to
 * known formats only.
 *
 * The source of truth is json-schema-faker's own built-in format registry, and
 * `generateWithJsf` starts from that registry alone (`formats: {}`), so nothing
 * can add to it at runtime. `uri-template` and `regex` are standard Draft 7
 * formats but are NOT in it — they generated the plain random string this set
 * exists to avoid — so they are deliberately absent. `field-name-matcher.test.ts`
 * pins every member against real generation, which is what keeps this list from
 * drifting on a json-schema-faker upgrade.
 */
export const GENERATABLE_FORMATS = new Set([
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "json-pointer",
  "relative-json-pointer",
  "uuid",
]);

/** True when `format` names something the generator can satisfy. */
function isGeneratableFormat(format: unknown): boolean {
  return typeof format === "string" && GENERATABLE_FORMATS.has(format);
}

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

/** A keyword with its tokenization computed once. */
interface TokenizedKeyword {
  tokens: string[];
  joined: string;
}

function tokenizeKeyword(keyword: string): TokenizedKeyword {
  const tokens = tokenizeFieldName(keyword);
  return { tokens, joined: tokens.join("") };
}

/**
 * Keyword tokenization is pure and the mapping table is immutable, so the
 * result is cached per mapping object. Without this, every `findBestMapping`
 * call re-tokenized all 379 keywords of the 152 built-in mappings — measured
 * at ~65µs per call, which made schema enhancement (not json-schema-faker)
 * the dominant cost of generating from a large schema.
 */
const tokenizedKeywordCache = new WeakMap<FieldMapping, TokenizedKeyword[]>();

function tokenizedKeywordsOf(mapping: FieldMapping): TokenizedKeyword[] {
  let tokenized = tokenizedKeywordCache.get(mapping);
  if (!tokenized) {
    tokenized = mapping.keywords.map(tokenizeKeyword);
    tokenizedKeywordCache.set(mapping, tokenized);
  }
  return tokenized;
}

/**
 * Score how well a set of pre-tokenized keywords matches field name tokens.
 * Scoring rules are documented on {@link scoreMatch}.
 */
function scoreTokenizedMatch(
  fieldTokens: string[],
  fieldJoined: string,
  keywords: TokenizedKeyword[],
): number {
  let bestScore = 0;

  // Try each keyword variant, keep the highest score
  for (const { tokens: kwTokens, joined: kwJoined } of keywords) {
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
  return scoreTokenizedMatch(
    fieldTokens,
    fieldTokens.join(""),
    keywords.map(tokenizeKeyword),
  );
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

  // Skip if schema already has pattern, enum, faker, format or $ref constraint.
  // `format` is a declared contract and json-schema-faker gives the `faker`
  // extension precedence over it, so a name-based mapping would silently
  // override the declared format (an email address in a `date-time` field).
  // Preserving `format` is not sufficient — mappings such as "name" set no
  // format at all — so the mapping is skipped entirely and json-schema-faker's
  // own format generator produces the value. `format: "uuid"` is handled by the
  // priority return above, the one case where name and format agree. An
  // unrecognized format (see GENERATABLE_FORMATS) is NOT deferred to: nothing
  // downstream can satisfy it, so skipping would trade a good name-based value
  // for an arbitrary string.
  // Also skip string mappings when minLength/maxLength is set — name-based
  // mappings (e.g. lorem.word for "label") don't honor JSON Schema length
  // constraints, so they'd produce out-of-range strings ~20% of the time.
  // Mirrors the numeric constraint skip just below.
  if (
    schema.pattern ||
    schema.enum ||
    ("faker" in schema && schema.faker) ||
    schema.$ref ||
    isGeneratableFormat(schema.format) ||
    (schemaType === "string" &&
      (schema.minLength !== undefined || schema.maxLength !== undefined))
  ) {
    return undefined;
  }

  // Skip numeric faker mapping when schema already constrains the value.
  // `multipleOf` counts: faker's numeric generators don't honor it, so a
  // mapped "age" would come back as 44 for `multipleOf: 10`.
  const hasNumericConstraints =
    schema.minimum !== undefined ||
    schema.maximum !== undefined ||
    schema.exclusiveMinimum !== undefined ||
    schema.exclusiveMaximum !== undefined ||
    schema.multipleOf !== undefined;

  // A constrained number/integer schema can't be satisfied by any name-based
  // mapping, whatever the mapping declares — several mappings (e.g. "price")
  // carry no schemaType at all and would otherwise slip through.
  const isNumericSchema = schemaType === "number" || schemaType === "integer";

  const tokens = tokenizeFieldName(fieldName);
  const joined = tokens.join("");

  let best: MatchResult | undefined;

  for (const mapping of mappings) {
    // Skip numeric faker mappings when schema has explicit constraints
    if (
      hasNumericConstraints &&
      (isNumericSchema ||
        mapping.schemaType === "number" ||
        mapping.schemaType === "integer")
    ) {
      continue;
    }

    // Skip faker mappings for object/array schemas — they generate primitive values
    if (schemaType === "object" || schemaType === "array") {
      continue;
    }

    // Check schema type constraint
    if (mapping.schemaType && schemaType && mapping.schemaType !== schemaType) {
      const isNumeric =
        (mapping.schemaType === "number" && schemaType === "integer") ||
        (mapping.schemaType === "integer" && schemaType === "number");
      if (!isNumeric) continue;
    }

    const score = scoreTokenizedMatch(
      tokens,
      joined,
      tokenizedKeywordsOf(mapping),
    );
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
