import type { Faker } from "@faker-js/faker";
import { ResourceLimitError, SchemaValidationError } from "@schmock/core";
import { MAX_ARRAY_SIZE, MAX_STRING_LENGTH } from "./constants.js";
import { createFakerInstance } from "./jsf-config.js";
import { regexLengthBounds } from "./regex-bounds.js";
import { capped } from "./saturating.js";
import { isRecord } from "./utils.js";

let validationFaker: Faker | undefined;

/**
 * Validate a schema's `faker` keyword: a `module.method` string, or an object
 * with exactly one own method key whose arguments are held to the allocation
 * policies.
 */
export function validateFakerConfig(config: unknown): void {
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
  /**
   * The argument is a length faker always produces, so its lower bound is
   * certain output. Unset for counts of words, sentences or items, for a
   * length that only selects dictionary words (`word.sample`), and for a
   * count of entries that may be empty strings (`string.fromCharacters`).
   */
  exact?: true;
}

const STRING_LIMIT = {
  resource: "string_length",
  limit: MAX_STRING_LENGTH,
} as const;
const EXACT_LENGTH = { ...STRING_LIMIT, exact: true } as const;
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
      ...EXACT_LENGTH,
    },
  ],
  "string.alphanumeric": [
    {
      argumentIndex: 0,
      direct: true,
      property: "length",
      ...EXACT_LENGTH,
    },
  ],
  "string.binary": [
    {
      argumentIndex: 0,
      direct: false,
      property: "length",
      ...EXACT_LENGTH,
    },
  ],
  "string.octal": [
    {
      argumentIndex: 0,
      direct: false,
      property: "length",
      ...EXACT_LENGTH,
    },
  ],
  "string.hexadecimal": [
    {
      argumentIndex: 0,
      direct: false,
      property: "length",
      ...EXACT_LENGTH,
    },
  ],
  "string.numeric": [
    {
      argumentIndex: 0,
      direct: true,
      property: "length",
      ...EXACT_LENGTH,
    },
  ],
  "string.sample": [{ argumentIndex: 0, direct: true, ...EXACT_LENGTH }],
  "string.nanoid": [{ argumentIndex: 0, direct: true, ...EXACT_LENGTH }],
  "string.symbol": [{ argumentIndex: 0, direct: true, ...EXACT_LENGTH }],
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
      ...EXACT_LENGTH,
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

  // Strings are held to the length limit before any template is scanned, so
  // the scan only ever walks a bounded string.
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
  validateTemplateArguments(method, args);
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

/** The lower end of a faker size argument: a number, or a `{ min, max }`. */
function minimumCardinality(value: unknown): number {
  const bound = isRecord(value) ? Reflect.get(value, "min") : value;
  return typeof bound === "number" && Number.isFinite(bound)
    ? Math.max(0, bound)
    : 0;
}

/**
 * The fewest characters a faker config is certain to produce: the lower
 * bound of a length argument its method always reaches (an `exact` rule).
 * An options object carries the length under the rule's property; only a
 * method without one takes a `{ min, max }` range directly.
 */
export function fakerLengthFloor(config: unknown): number {
  if (!isRecord(config)) return 0;
  let floor = 0;
  for (const [method, args] of Object.entries(config)) {
    if (!Array.isArray(args)) continue;
    for (const rule of FAKER_ALLOCATION_POLICIES[method] ?? []) {
      if (!rule.exact) continue;
      const argument: unknown = args[rule.argumentIndex];
      const length =
        rule.property && isRecord(argument)
          ? Reflect.get(argument, rule.property)
          : rule.direct
            ? argument
            : undefined;
      floor = Math.max(floor, minimumCardinality(length));
    }
  }
  return floor;
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

interface FakePlaceholder {
  /** Index of the opening `{{`. */
  start: number;
  /** Index just past the closing `}}`. */
  end: number;
  /** The text faker evaluates. */
  expression: string;
}

/**
 * Find the placeholders faker 10's `helpers.fake` evaluates, the way it finds
 * them: a `{{` followed by a lowercase letter opens one, the next `}}` closes
 * it, and the first `{{` inside is dropped. Anything else, such as `{{(5)}}`
 * or the outer braces of `{{{string.alpha(5)}}}`, stays literal text.
 */
function fakePlaceholders(template: string): FakePlaceholder[] {
  const placeholders: FakePlaceholder[] = [];
  const opening = /\{\{[a-z]/g;
  for (;;) {
    const match = opening.exec(template);
    if (match === null) break;
    const close = template.indexOf("}}", match.index);
    if (close === -1) break;
    placeholders.push({
      start: match.index,
      end: close + 2,
      expression: template.slice(match.index + 2, close).replace("{{", ""),
    });
    opening.lastIndex = close + 2;
  }
  return placeholders;
}

/**
 * The method a placeholder calls and the arguments faker passes it, or
 * undefined for a placeholder that calls nothing (faker then invokes the
 * method with no arguments) or never closes its argument list.
 */
function fakeCall(
  expression: string,
): { method: string; args: unknown[] } | undefined {
  const open = expression.indexOf("(");
  if (open === -1) return undefined;
  const args = parseFakeArguments(expression.slice(open));
  if (args === undefined) return undefined;
  return { method: expression.slice(0, open).trim(), args };
}

/**
 * Parse a placeholder's argument list the way faker does: at each `)` in
 * turn, try the text before it as JSON, then, when it holds no quote, as one
 * JSON string; failing every `)`, pass everything up to the last one as a
 * single string.
 */
function parseFakeArguments(call: string): unknown[] | undefined {
  let close = call.indexOf(")", 1);
  if (close === -1) return undefined;
  while (close !== -1) {
    const text = call.slice(1, close);
    const parsed =
      parseJsonArray(`[${text}]`) ??
      (text.includes("'") || text.includes('"')
        ? undefined
        : parseJsonArray(`["${text}"]`));
    if (parsed) return parsed;
    close = call.indexOf(")", close + 1);
  }
  return [call.slice(1, call.lastIndexOf(")"))];
}

function parseJsonArray(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `helpers.fake` evaluates each `{{module.method(args)}}` placeholder with
 * JSON-parsed arguments, so every placeholder is held to the same method path
 * rule and allocation policy as the method called directly. Placeholders are
 * those written in the template; one that a placeholder's output assembles
 * when faker scans the substituted string again is not seen here.
 */
function validateFakeTemplates(templates: unknown): void {
  const candidates = Array.isArray(templates) ? templates : [templates];
  for (const template of candidates) {
    if (typeof template !== "string") continue;
    for (const { expression } of fakePlaceholders(template)) {
      const call = fakeCall(expression);
      if (!call) continue;
      validateFakerMethod(call.method);
      validateFakerAllocationArguments(call.method, call.args);
    }
  }
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

/**
 * Validate that faker method string references a valid Faker.js API
 * Checks format (namespace.method) and validates against known namespaces
 * @param fakerMethod - Faker method string (e.g., "person.fullName")
 * @throws {SchemaValidationError} When faker method format or namespace is invalid
 */
export function validateFakerMethod(fakerMethod: string): void {
  // Every faker 10 method is `namespace.method`. A longer path can only reach
  // through a module's `faker` back-reference (`person.faker.string.alpha`),
  // an alias no entry in FAKER_ALLOCATION_POLICIES is keyed by.
  const parts = fakerMethod.split(".");
  if (parts.length !== 2) {
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
