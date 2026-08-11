import { decodePathSegment, normalizePath } from "./constants.js";

/**
 * Compiled callable route with pattern matching
 */
export interface CompiledCallableRoute {
  pattern: RegExp;
  params: string[];
  method: Schmock.HttpMethod;
  path: string;
  generator: Schmock.Generator;
  config: Schmock.RouteConfig;
}

export function isGeneratorFunction(
  gen: Schmock.Generator,
): gen is Schmock.GeneratorFunction {
  return typeof gen === "function";
}

/**
 * Find a route that matches the given method and path
 * Uses two-pass matching: static routes first, then parameterized routes
 * Matches routes in registration order (first registered wins)
 */
export function findRoute(
  method: Schmock.HttpMethod,
  path: string,
  staticRoutes: Map<string, CompiledCallableRoute>,
  routes: CompiledCallableRoute[],
): CompiledCallableRoute | undefined {
  // O(1) lookup for static routes
  const staticMatch = staticRoutes.get(`${method} ${normalizePath(path)}`);
  if (staticMatch) {
    return staticMatch;
  }

  // Fall through to parameterized route scan
  for (const route of routes) {
    if (
      route.method === method &&
      route.params.length > 0 &&
      route.pattern.test(path)
    ) {
      return route;
    }
  }

  return undefined;
}

/**
 * Extract parameter values from path based on route pattern
 * Maps capture groups from regex match to parameter names
 *
 * Matching runs on the ENCODED path so `%2F` cannot act as a separator;
 * captures are decoded afterwards, so a generator receives readable values.
 */
export function extractParams(
  route: CompiledCallableRoute,
  path: string,
): Record<string, string> {
  const match = path.match(route.pattern);
  if (!match) return {};

  // Object.fromEntries defines own properties, so a parameter named
  // `__proto__` (or any other Object.prototype key) survives instead of being
  // swallowed by the prototype setter. The prototype itself is retained so
  // generators can still call params.hasOwnProperty(...).
  return Object.fromEntries(
    route.params.map((param, index) => [
      param,
      decodePathSegment(match[index + 1]),
    ]),
  );
}
