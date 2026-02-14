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
  const normalizedPath =
    path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  const staticMatch = staticRoutes.get(`${method} ${normalizedPath}`);
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
 */
export function extractParams(
  route: CompiledCallableRoute,
  path: string,
): Record<string, string> {
  const match = path.match(route.pattern);
  if (!match) return {};

  const params: Record<string, string> = {};
  route.params.forEach((param, index) => {
    params[param] = match[index + 1];
  });

  return params;
}
