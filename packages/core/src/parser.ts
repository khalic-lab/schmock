import { toHttpMethod } from "./constants.js";
import { RouteParseError } from "./errors.js";
import type { HttpMethod } from "./types.js";

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

  // Parameter names are restricted to [A-Za-z0-9_-] so that surrounding
  // literals (".json", brackets, parens, etc.) terminate the name and can
  // be escaped without bleeding into the parameter regex. Build the
  // pattern by splitting the path on the param marker, escaping each
  // literal segment, then substituting the capture group for each :name.
  const params: string[] = [];

  const regexPath = path
    .split(/(:[a-zA-Z0-9_-]+)/g)
    .map((segment) => {
      const paramMatch = segment.match(/^:([a-zA-Z0-9_-]+)$/);
      if (paramMatch) {
        params.push(paramMatch[1]);
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");

  const pattern = new RegExp(`^${regexPath}$`);

  return {
    method: toHttpMethod(method),
    path,
    pattern,
    params,
  };
}
