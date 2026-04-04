/// <reference path="../../core/schmock.d.ts" />

import { version as packageVersion } from "../package.json";

interface PaginationOptions {
  /** Default items per page (default: 10) */
  defaultLimit?: number;
  /** Maximum items per page (default: 100) */
  maxLimit?: number;
  /** Query parameter name for page number (default: "page") */
  pageParam?: string;
  /** Query parameter name for limit (default: "limit") */
  limitParam?: string;
}

interface SortingOptions {
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

interface FilteringOptions {
  /** Fields allowed for filtering */
  allowed: string[];
  /** Query parameter prefix for filters (default: "filter") */
  filterPrefix?: string;
}

interface QueryPluginOptions {
  pagination?: PaginationOptions;
  sorting?: SortingOptions;
  filtering?: FilteringOptions;
}

export function queryPlugin(options: QueryPluginOptions): Schmock.Plugin {
  return {
    name: "query",
    version: packageVersion,

    process(
      context: Schmock.PluginContext,
      response?: unknown,
    ): Schmock.PluginResult {
      // Only process array responses
      if (!Array.isArray(response)) {
        return { context, response };
      }

      let items: unknown[] = [...response];
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
        return { context, response: result };
      }

      return { context, response: items };
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
    // Support filter[field]=value format
    const bracketKey = `${prefix}[${field}]`;
    // Support filter.field=value format
    const dotKey = `${prefix}.${field}`;
    // Support plain field=value format as fallback
    const value = query[bracketKey] ?? query[dotKey] ?? query[field];

    if (value !== undefined) {
      result = result.filter((item) => {
        if (typeof item !== "object" || item === null) return false;
        const record = item as Record<string, unknown>;
        const itemValue = record[field];
        if (itemValue === undefined) return false;
        // Intentional string coercion: query params are inherently strings
        return String(itemValue) === value;
      });
    }
  }

  return result;
}

function applySorting(
  items: unknown[],
  query: Record<string, string>,
  options: SortingOptions,
): unknown[] {
  const sortParam = options.sortParam ?? "sort";
  const orderParam = options.orderParam ?? "order";
  const sortField = query[sortParam] ?? options.default;
  const rawOrder = query[orderParam] ?? options.defaultOrder ?? "asc";
  const sortOrder = rawOrder === "desc" ? "desc" : "asc";

  if (!sortField) return items;

  // Only sort by allowed fields
  if (!options.allowed.includes(sortField)) return items;

  return items.sort((a, b) => {
    if (typeof a !== "object" || a === null) return 0;
    if (typeof b !== "object" || b === null) return 0;
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aVal = aRecord[sortField];
    const bVal = bRecord[sortField];

    if (aVal === bVal) return 0;
    if (aVal === undefined) return 1;
    if (bVal === undefined) return -1;

    let comparison: number;
    if (typeof aVal === "number" && typeof bVal === "number") {
      comparison = aVal - bVal;
    } else {
      comparison = String(aVal).localeCompare(String(bVal));
    }

    return sortOrder === "desc" ? -comparison : comparison;
  });
}

interface PaginatedResult {
  data: unknown[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
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

  const page = Math.max(1, Number.parseInt(query[pageParam] || "1", 10) || 1);
  const limit = Math.min(
    maxLimit,
    Math.max(
      1,
      Number.parseInt(query[limitParam] || String(defaultLimit), 10) ||
        defaultLimit,
    ),
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
