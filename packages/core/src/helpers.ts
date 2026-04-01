/// <reference path="../schmock.d.ts" />

export function notFound(message: string | object = "Not Found"): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [404, body];
}

export function badRequest(message: string | object = "Bad Request"): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [400, body];
}

export function unauthorized(message: string | object = "Unauthorized"): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [401, body];
}

export function forbidden(message: string | object = "Forbidden"): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [403, body];
}

export function serverError(message: string | object = "Internal Server Error"): [number, object] {
  const body = typeof message === "string" ? { message } : message;
  return [500, body];
}

export function created(body: object): [number, object] {
  return [201, body];
}

export function noContent(): [number, null] {
  return [204, null];
}

export function paginate<T>(
  items: T[],
  options: Schmock.PaginateOptions = {},
): Schmock.PaginatedResponse<T> {
  const page = options.page || 1;
  const pageSize = options.pageSize || 10;
  const total = items.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const data = items.slice(start, end);
  return { data, page, pageSize, total, totalPages };
}
