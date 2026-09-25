/// <reference path="../schmock.d.ts" />

// Each helper returns its literal status (`[404, object]`, not
// `[number, object]`), as docs/api.md documents: a literal tuple is still
// assignable to `[number, object]`, and callers can destructure a typed status.

export function notFound(
  message: string | object = "Not Found",
): [404, object] {
  const body = typeof message === "string" ? { message } : message;
  return [404, body];
}

export function badRequest(
  message: string | object = "Bad Request",
): [400, object] {
  const body = typeof message === "string" ? { message } : message;
  return [400, body];
}

export function unauthorized(
  message: string | object = "Unauthorized",
): [401, object] {
  const body = typeof message === "string" ? { message } : message;
  return [401, body];
}

export function forbidden(
  message: string | object = "Forbidden",
): [403, object] {
  const body = typeof message === "string" ? { message } : message;
  return [403, body];
}

export function serverError(
  message: string | object = "Internal Server Error",
): [500, object] {
  const body = typeof message === "string" ? { message } : message;
  return [500, body];
}

export function created(body: object): [201, object] {
  return [201, body];
}

export function noContent(): [204, null] {
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
 * consistent with `data`. `items` is only read, so a readonly array is fine.
 */
export function paginate<T>(
  items: readonly T[],
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
