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
  try {
    return Object.hasOwn(source, key) ? source[key] : undefined;
  } catch {
    return undefined;
  }
}

function describeReceived(value: unknown): string {
  try {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
  } catch {
    return "<unprintable>";
  }
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

function snapshotOptions(options: QueryPluginOptions): QueryPluginOptions {
  const { pagination, sorting, filtering } = options;
  let paginationSnapshot: PaginationOptions | undefined;
  let sortingSnapshot: SortingOptions | undefined;
  let filteringSnapshot: FilteringOptions | undefined;

  if (pagination) {
    const { defaultLimit, maxLimit, pageParam, limitParam } = pagination;
    paginationSnapshot = { defaultLimit, maxLimit, pageParam, limitParam };
  }

  if (sorting) {
    const {
      allowed,
      default: defaultField,
      defaultOrder,
      sortParam,
      orderParam,
    } = sorting;
    sortingSnapshot = {
      allowed: Array.isArray(allowed) ? [...allowed] : allowed,
      default: defaultField,
      defaultOrder,
      sortParam,
      orderParam,
    };
  }

  if (filtering) {
    const { allowed, filterPrefix } = filtering;
    filteringSnapshot = {
      allowed: Array.isArray(allowed) ? [...allowed] : allowed,
      filterPrefix,
    };
  }

  return {
    pagination: paginationSnapshot,
    sorting: sortingSnapshot,
    filtering: filteringSnapshot,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
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
  if (isStructuredResponse(response)) {
    return response.headers === undefined
      ? { status: response.status, body }
      : { status: response.status, body, headers: response.headers };
  }
  return body;
}

export function queryPlugin(options: QueryPluginOptions = {}): Schmock.Plugin {
  const configuredOptions = snapshotOptions(options);
  validateOptions(configuredOptions);

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
      if (configuredOptions.filtering) {
        items = applyFiltering(items, query, configuredOptions.filtering);
      }

      // Apply sorting
      if (configuredOptions.sorting) {
        items = applySorting(items, query, configuredOptions.sorting);
      }

      // Apply pagination
      if (configuredOptions.pagination) {
        const result = applyPagination(
          items,
          query,
          configuredOptions.pagination,
        );
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
        try {
          // Intentional string coercion: query params are inherently strings
          return String(itemValue) === value;
        } catch {
          return false;
        }
      });
    }
  }

  return result;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// Complex values are opaque: inspecting them can recurse, invoke traps, or
// expand shared DAGs. They compare equal in a stable bucket after all scalars.
type SortKey =
  | { kind: "number"; value: number }
  | { kind: "non-finite-number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "bigint"; value: bigint }
  | { kind: "null" }
  | { kind: "unsupported" }
  | { kind: "missing" };

function createSortKey(value: unknown): SortKey {
  if (value === undefined) return { kind: "missing" };
  if (value === null) return { kind: "null" };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { kind: "number", value }
      : { kind: "non-finite-number", value };
  }
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "bigint") return { kind: "bigint", value };
  return { kind: "unsupported" };
}

function sortRank(key: SortKey): number {
  switch (key.kind) {
    case "number":
      return 0;
    case "non-finite-number":
      return 1;
    case "string":
      return 2;
    case "boolean":
      return 3;
    case "bigint":
      return 4;
    case "null":
      return 5;
    case "unsupported":
      return 6;
    case "missing":
      return 7;
  }
}

function nonFiniteRank(value: number): number {
  if (value === Number.NEGATIVE_INFINITY) return 0;
  if (value === Number.POSITIVE_INFINITY) return 1;
  return 2;
}

function compareSortKeys(
  a: SortKey,
  b: SortKey,
  order: "asc" | "desc",
): number {
  if (a.kind === "missing" || b.kind === "missing") {
    if (a.kind === b.kind) return 0;
    return a.kind === "missing" ? 1 : -1;
  }
  if (a.kind === "unsupported" || b.kind === "unsupported") {
    if (a.kind === b.kind) return 0;
    return a.kind === "unsupported" ? 1 : -1;
  }

  const rankComparison = sortRank(a) - sortRank(b);
  let comparison = rankComparison;
  if (rankComparison === 0) {
    if (a.kind === "number" && b.kind === "number") {
      comparison = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    } else if (
      a.kind === "non-finite-number" &&
      b.kind === "non-finite-number"
    ) {
      comparison = nonFiniteRank(a.value) - nonFiniteRank(b.value);
    } else if (a.kind === "string" && b.kind === "string") {
      comparison = compareStrings(a.value, b.value);
    } else if (a.kind === "boolean" && b.kind === "boolean") {
      comparison = Number(a.value) - Number(b.value);
    } else if (a.kind === "bigint" && b.kind === "bigint") {
      comparison = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    }
  }

  return order === "desc" ? -comparison : comparison;
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

  return items
    .map((item) => ({
      item,
      key: createSortKey(
        isRecord(item) ? ownValue(item, sortField) : undefined,
      ),
    }))
    .sort((a, b) => compareSortKeys(a.key, b.key, sortOrder))
    .map(({ item }) => item);
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
