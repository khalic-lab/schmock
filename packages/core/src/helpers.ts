/// <reference path="../schmock.d.ts" />

export function notFound(
  message: string | object = "Not Found",
): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [404, body];
}

export function badRequest(
  message: string | object = "Bad Request",
): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [400, body];
}

export function unauthorized(
  message: string | object = "Unauthorized",
): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [401, body];
}

export function forbidden(
  message: string | object = "Forbidden",
): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [403, body];
}

export function serverError(
  message: string | object = "Internal Server Error",
): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [500, body];
}

export function created(body: object): [number, object] {
  return [201, body];
}

export function noContent(): [number, null] {
  return [204, null];
}

/** Default page size used when `pageSize` is absent or not a positive integer. */
const DEFAULT_PAGE_SIZE = 10;

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : fallback;
}

/**
 * Slice `items` into a page envelope.
 *
 * `page` and `pageSize` are normalized to positive integers (falling back to
 * page 1 and a page size of 10) so a fractional, negative, NaN or infinite
 * option can never produce a nonsensical slice or a negative `totalPages`. The
 * returned envelope always echoes the NORMALIZED values, so it is internally
 * consistent with `data`.
 */
export function paginate<T>(
  items: T[],
  options: Schmock.PaginateOptions = {},
): Schmock.PaginatedResponse<T> {
  const page = positiveInteger(options.page, 1);
  const pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE);
  const total = items.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const data = items.slice(start, end);
  return { data, page, pageSize, total, totalPages };
}
