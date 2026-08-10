import type * as Schmock from "@schmock/core";
import { isStatusTuple, SchmockError } from "@schmock/core";
import { version as packageVersion } from "../package.json";

export interface PaginationOptions {
  /** Default items per page (default: 10) */
  defaultLimit?: number;
  /** Maximum items per page (default: 100) */
  maxLimit?: number;
  /** Query parameter name for page number (default: "page") */
  pageParam?: string;
  /** Query parameter name for limit (default: "limit") */
  limitParam?: string;
}

export interface SortingOptions {
  /** Fields allowed for sorting */
  allowed: string[];
  /** Default sort field */
  default?: string;
  /** Default sort order (default: "asc") */
  defaultOrder?: "asc" | "desc";
  /** Query parameter name for sort field (default: "sort") */
  sortParam?: string;
  /** Query parameter name for sort order (default: "order") */
  orderParam?: string;
}

export interface FilteringOptions {
  /** Fields allowed for filtering */
  allowed: string[];
  /** Query parameter prefix for filters (default: "filter") */
  filterPrefix?: string;
}

export interface QueryPluginOptions {
  pagination?: PaginationOptions;
  sorting?: SortingOptions;
  filtering?: FilteringOptions;
}

/** Field names that would reach up the prototype chain if honoured. */
const RESERVED_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads a key without consulting the prototype chain, so inherited members such
 * as `toString` or `constructor` are never mistaken for query params or fields.
 */
function ownValue<T>(source: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

function describeReceived(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function configError(message: string, option: string, received: unknown) {
  return new SchmockError(
    `queryPlugin: ${message} (received ${describeReceived(received)})`,
    "QUERY_CONFIG_INVALID",
    { option, received },
  );
}

function assertPositiveInteger(value: unknown, option: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw configError(`${option} must be a positive integer`, option, value);
  }
}

function assertNonEmptyString(value: unknown, option: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw configError(`${option} must be a non-empty string`, option, value);
  }
}

function assertAllowedFields(value: unknown, option: string): void {
  if (!Array.isArray(value)) {
    throw configError(
      `${option} must be an array of field names`,
      option,
      value,
    );
  }

  for (const field of value) {
    if (typeof field !== "string" || field.length === 0) {
      throw configError(
        `${option} must contain only non-empty field names`,
        option,
        field,
      );
    }
    if (RESERVED_FIELDS.has(field)) {
      throw configError(
        `${option} must not contain the reserved field name`,
        option,
        field,
      );
    }
  }
}

/**
 * Validates configuration at plugin creation time so misconfiguration surfaces
 * to the developer immediately instead of producing nonsensical responses.
 */
function validateOptions(options: QueryPluginOptions): void {
  const { pagination, sorting, filtering } = options;

  if (pagination) {
    assertPositiveInteger(pagination.defaultLimit, "pagination.defaultLimit");
    assertPositiveInteger(pagination.maxLimit, "pagination.maxLimit");
    assertNonEmptyString(pagination.pageParam, "pagination.pageParam");
    assertNonEmptyString(pagination.limitParam, "pagination.limitParam");
  }

  if (sorting) {
    assertAllowedFields(sorting.allowed, "sorting.allowed");
    assertNonEmptyString(sorting.sortParam, "sorting.sortParam");
    assertNonEmptyString(sorting.orderParam, "sorting.orderParam");
  }

  if (filtering) {
    assertAllowedFields(filtering.allowed, "filtering.allowed");
    assertNonEmptyString(filtering.filterPrefix, "filtering.filterPrefix");
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isStructuredResponse(value: unknown): value is {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
} {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    typeof value.status === "number" &&
    "body" in value &&
    (value.headers === undefined || isStringRecord(value.headers))
  );
}

function getResponseBody(response: unknown): unknown {
  if (isStatusTuple(response)) return response[1];
  if (isStructuredResponse(response)) return response.body;
  return response;
}

function replaceResponseBody(response: unknown, body: unknown): unknown {
  if (isStatusTuple(response)) {
    return response.length === 3
      ? [response[0], body, response[2]]
      : [response[0], body];
  }
  if (isStructuredResponse(response)) return { ...response, body };
  return body;
}

export function queryPlugin(options: QueryPluginOptions = {}): Schmock.Plugin {
  validateOptions(options);

  return {
    name: "query",
    version: packageVersion,

    process(
      context: Schmock.PluginContext,
      response?: unknown,
    ): Schmock.PluginResult {
      const responseBody = getResponseBody(response);
      if (!Array.isArray(responseBody)) {
        return { context, response };
      }

      let items: unknown[] = [...responseBody];
      const query = context.query || {};

      // Apply filtering
      if (options.filtering) {
        items = applyFiltering(items, query, options.filtering);
      }

      // Apply sorting
      if (options.sorting) {
        items = applySorting(items, query, options.sorting);
      }

      // Apply pagination
      if (options.pagination) {
        const result = applyPagination(items, query, options.pagination);
        return { context, response: replaceResponseBody(response, result) };
      }

      return { context, response: replaceResponseBody(response, items) };
    },
  };
}

function applyFiltering(
  items: unknown[],
  query: Record<string, string>,
  options: FilteringOptions,
): unknown[] {
  const prefix = options.filterPrefix ?? "filter";
  let result = items;

  for (const field of options.allowed) {
    // Only prefixed forms are honoured, so filters can never collide with the
    // pagination or sorting controls: filter[field]=value and filter.field=value
    const value =
      ownValue(query, `${prefix}[${field}]`) ??
      ownValue(query, `${prefix}.${field}`);

    if (value !== undefined) {
      result = result.filter((item) => {
        if (!isRecord(item)) return false;
        const itemValue = ownValue(item, field);
        if (itemValue === undefined) return false;
        // Intentional string coercion: query params are inherently strings
        return String(itemValue) === value;
      });
    }
  }

  return result;
}

/**
 * Buckets values by type so comparisons never mix incompatible rules.
 * Finite numbers < non-finite numbers < strings < booleans < everything else.
 */
function typeRank(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? 0 : 1;
  if (typeof value === "string") return 2;
  if (typeof value === "boolean") return 3;
  return 4;
}

/**
 * Total order over mixed value types. Comparing within a single bucket keeps
 * the comparator transitive, so the result never depends on input order.
 */
function compareValues(a: unknown, b: unknown): number {
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA - rankB;

  // Equal ranks mean equal runtime types, so each branch narrows rather than
  // asserts. Non-finite numbers share rank 1 and have no ordering among
  // themselves.
  if (typeof a === "number" && typeof b === "number") {
    return Number.isFinite(a) ? a - b : 0;
  }
  if (typeof a === "string" && typeof b === "string") {
    // Locale collation can rank distinct strings equal; fall back to code
    // unit order so the result stays deterministic across engines
    const collated = a.localeCompare(b);
    return collated !== 0 ? collated : compareStrings(a, b);
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return compareStrings(String(a), String(b));
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function applySorting(
  items: unknown[],
  query: Record<string, string>,
  options: SortingOptions,
): unknown[] {
  const sortParam = options.sortParam ?? "sort";
  const orderParam = options.orderParam ?? "order";
  const sortField = ownValue(query, sortParam) ?? options.default;
  const rawOrder = ownValue(query, orderParam) ?? options.defaultOrder ?? "asc";
  const sortOrder = rawOrder === "desc" ? "desc" : "asc";

  if (!sortField) return items;

  // Only sort by allowed fields
  if (!options.allowed.includes(sortField)) return items;

  return items.sort((a, b) => {
    if (!isRecord(a) || !isRecord(b)) return 0;
    const aVal = ownValue(a, sortField);
    const bVal = ownValue(b, sortField);

    // Missing values always sort last, in either direction
    if (aVal === bVal) return 0;
    if (aVal === undefined) return 1;
    if (bVal === undefined) return -1;

    const comparison = compareValues(aVal, bVal);

    return sortOrder === "desc" ? -comparison : comparison;
  });
}

export interface PaginatedResult {
  data: unknown[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Parses a query value as an exact positive integer. Anything else — padded,
 * signed, fractional, exponent, partially numeric or beyond the safe integer
 * range — falls back rather than being silently coerced.
 */
function parseCount(raw: unknown, fallback: number): number {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function applyPagination(
  items: unknown[],
  query: Record<string, string>,
  options: PaginationOptions,
): PaginatedResult {
  const pageParam = options.pageParam ?? "page";
  const limitParam = options.limitParam ?? "limit";
  const defaultLimit = options.defaultLimit ?? 10;
  const maxLimit = options.maxLimit ?? 100;

  const page = parseCount(ownValue(query, pageParam), 1);
  const limit = Math.min(
    maxLimit,
    parseCount(ownValue(query, limitParam), defaultLimit),
  );

  const total = items.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const data = items.slice(start, start + limit);

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}
