import { toHttpMethod } from "./constants";
import { RouteParseError } from "./errors";
import type { HttpMethod } from "./types";

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

  return {
    method: toHttpMethod(method),
    path,
    pattern,
    params,
  };
}
