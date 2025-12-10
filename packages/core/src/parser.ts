import { RouteParseError } from "./errors.js";
import type { HttpMethod } from "./types.js";

const HTTP_METHODS: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
];

function isHttpMethod(method: string): method is HttpMethod {
  return HTTP_METHODS.includes(method as HttpMethod);
}

export interface ParsedRoute {
  method: HttpMethod;
  path: string;
  pattern: RegExp;
  params: string[];
}

/**
 * Parse 'METHOD /path' route key format
 *
 * Design note: We validate the format strictly to catch typos early.
 * The 'METHOD /path' format was chosen for its readability and
 * similarity to API documentation formats.
 *
 * @example
 * parseRouteKey('GET /users/:id')
 * // => { method: 'GET', path: '/users/:id', pattern: /^\/users\/([^/]+)$/, params: ['id'] }
 */
export function parseRouteKey(routeKey: string): ParsedRoute {
  const match = routeKey.match(
    /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) (.+)$/,
  );

  if (!match) {
    throw new RouteParseError(
      routeKey,
      'Expected format: "METHOD /path" (e.g., "GET /users")',
    );
  }

  const [, method, path] = match;

  // Extract parameter names
  const params: string[] = [];
  const paramPattern = /:([^/]+)/g;
  let paramMatch: RegExpExecArray | null;

  paramMatch = paramPattern.exec(path);
  while (paramMatch !== null) {
    params.push(paramMatch[1]);
    paramMatch = paramPattern.exec(path);
  }

  // Build regex pattern for matching
  // Replace :param with capture groups
  const regexPath = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // Escape special regex chars except :
    .replace(/:([^/]+)/g, "([^/]+)"); // Replace :param with capture group

  const pattern = new RegExp(`^${regexPath}$`);

  // The regex guarantees method is valid, but we use the type guard for type safety
  if (!isHttpMethod(method)) {
    throw new RouteParseError(routeKey, `Invalid HTTP method: ${method}`);
  }

  return {
    method,
    path,
    pattern,
    params,
  };
}
