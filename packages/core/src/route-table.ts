import { isBinaryBody } from "./binary.js";
import { normalizePath } from "./constants.js";
import type { DebugLogger } from "./debug-logger.js";
import { RouteDefinitionError } from "./errors.js";
import { parseRouteKey } from "./parser.js";
import type { CompiledCallableRoute } from "./route-matcher.js";

/** The route containers an admitted request routes with. */
export interface RouteTableSnapshot {
  readonly routes: CompiledCallableRoute[];
  readonly staticRoutes: Map<string, CompiledCallableRoute>;
}

/** The table as it stood before a `pipe()` install, for its rollback. */
interface RouteTableCheckpoint extends RouteTableSnapshot {
  readonly shared: boolean;
}

function defaultContentType(generator: Schmock.Generator): string {
  if (typeof generator === "function") {
    // Default to JSON for function generators
    return "application/json";
  }
  if (
    typeof generator === "string" ||
    typeof generator === "number" ||
    typeof generator === "boolean"
  ) {
    // Default to plain text for primitives
    return "text/plain";
  }
  if (isBinaryBody(generator)) {
    // Default to octet-stream for browser and Node binary values
    return "application/octet-stream";
  }
  // Default to JSON for objects/arrays
  return "application/json";
}

/**
 * The mock's registered routes: every route in registration order, plus the
 * static (parameterless) ones in a map for O(1) lookup.
 *
 * The containers are copy-on-write. An admitted request captures them by
 * reference (`share()`), and the first registration after that copies them,
 * so an in-flight snapshot never changes underneath its request and no
 * request pays for a copy of the whole table.
 */
export class RouteTable {
  #routes: CompiledCallableRoute[] = [];
  #staticRoutes = new Map<string, CompiledCallableRoute>();
  /** True once an admission holds the containers by reference. */
  #shared = false;

  /** O(1) snapshot for an admitted request. */
  share(): RouteTableSnapshot {
    this.#shared = true;
    return { routes: this.#routes, staticRoutes: this.#staticRoutes };
  }

  define(input: {
    route: Schmock.RouteKey;
    generator: Schmock.Generator;
    config: Schmock.RouteConfig;
    logger: DebugLogger;
  }): void {
    const { route, generator, logger } = input;
    // FIX 1.2: shallow-clone the caller's config so mutations below stay private
    const routeConfig = { ...input.config };

    // Auto-detect contentType if not provided
    if (!routeConfig.contentType) {
      routeConfig.contentType = defaultContentType(generator);
    }

    // Validate generator matches contentType if it's static data
    if (
      typeof generator !== "function" &&
      routeConfig.contentType === "application/json"
    ) {
      try {
        JSON.stringify(generator);
      } catch (_error) {
        throw new RouteDefinitionError(
          route,
          "Generator data is not valid JSON but contentType is application/json",
        );
      }
    }

    // Parse the route key to create pattern and extract parameters
    const parsed = parseRouteKey(route);

    // FIX 2.2: normalize paths before duplicate check so /users and /users/ are
    // treated as the same route (consistent with the static-route Map key below).
    // Routes that differ only in parameter names (`/users/:id` and
    // `/users/:userId`) compile to the same pattern and match the same
    // requests, so the later one would be unreachable: it is a duplicate too.
    const normalizedParsedPath = normalizePath(parsed.path);
    const existing = this.#routes.find(
      (r) =>
        r.method === parsed.method &&
        (normalizePath(r.path) === normalizedParsedPath ||
          r.pattern.source === parsed.pattern.source),
    );
    if (existing) {
      logger.log(
        "warning",
        normalizePath(existing.path) === normalizedParsedPath
          ? `Duplicate route: ${route} — first registration wins`
          : `Duplicate route: ${route} matches the same requests as ${existing.method} ${existing.path} — first registration wins`,
      );
      return;
    }

    // Compile the route
    const compiledRoute: CompiledCallableRoute = {
      pattern: parsed.pattern,
      params: parsed.params,
      method: parsed.method,
      path: parsed.path,
      generator,
      config: routeConfig,
    };

    this.#writable();
    this.#routes.push(compiledRoute);

    // Store static routes (no params) in Map for O(1) lookup
    if (parsed.params.length === 0) {
      const key = `${parsed.method} ${normalizePath(parsed.path)}`;
      this.#staticRoutes.set(key, compiledRoute);
    }

    logger.log("route", `Route defined: ${route}`, {
      contentType: routeConfig.contentType,
      generatorType: typeof generator,
      hasParams: parsed.params.length > 0,
    });
  }

  list(): Schmock.RouteInfo[] {
    return this.#routes.map((r) => ({
      method: r.method,
      path: r.path,
      hasParams: r.params.length > 0,
    }));
  }

  /**
   * Start a transaction: later registrations go into fresh copies, and
   * `rollback()` puts the table back exactly as it was.
   */
  checkpoint(): RouteTableCheckpoint {
    const checkpoint: RouteTableCheckpoint = {
      routes: this.#routes,
      staticRoutes: this.#staticRoutes,
      shared: this.#shared,
    };
    this.#routes = checkpoint.routes.slice();
    this.#staticRoutes = new Map(checkpoint.staticRoutes);
    this.#shared = false;
    return checkpoint;
  }

  rollback(checkpoint: RouteTableCheckpoint): void {
    this.#routes = checkpoint.routes;
    this.#staticRoutes = checkpoint.staticRoutes;
    this.#shared = checkpoint.shared;
  }

  /**
   * Empty the table. The containers are replaced, never cleared in place:
   * in-flight admissions still route with the old ones.
   */
  clear(): void {
    this.#routes = [];
    this.#staticRoutes = new Map();
    this.#shared = false;
  }

  /**
   * Copy-on-write for the route tables. An admitted request routes with the
   * containers it captured, by reference; the first registration after that
   * copies them so the in-flight snapshot never changes underneath it.
   */
  #writable(): void {
    if (!this.#shared) return;
    this.#routes = this.#routes.slice();
    this.#staticRoutes = new Map(this.#staticRoutes);
    this.#shared = false;
  }
}

/**
 * A per-request copy of a route's config for the plugin context.
 *
 * Shallow on purpose: plugin metadata under `openapi:*` keys is shared,
 * read-only structure (and some of it is keyed by identity in WeakMaps), but a
 * plugin that assigns `context.route.contentType` or edits the delay tuple must
 * not change every later request.
 */
export function copyRouteConfig(
  config: Schmock.RouteConfig,
): Schmock.RouteConfig {
  const copy: Schmock.RouteConfig = { ...config };
  if (Array.isArray(config.delay)) {
    copy.delay = [config.delay[0], config.delay[1]];
  }
  return copy;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep-copy the plain data (arrays and plain objects) of a static generator so
 * plugins can edit their response in place without changing the route.
 *
 * Anything else — dates, binary values, class instances with a prototype
 * `toJSON` — is passed by reference: `structuredClone` would strip those
 * prototypes (a Buffer would come back as a bare Uint8Array) and change what
 * the response serializes to. Enumerable symbol keys are kept so the response
 * normalizer still sees, and rejects, them.
 */
export function copyStaticData(
  value: unknown,
  copies = new Map<object, unknown>(),
): unknown {
  if (typeof value !== "object" || value === null) return value;
  const existing = copies.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    copies.set(value, copy);
    for (let index = 0; index < value.length; index += 1) {
      if (index in value) copy[index] = copyStaticData(value[index], copies);
    }
    for (const key of Object.getOwnPropertySymbols(value)) {
      if (!Object.getOwnPropertyDescriptor(value, key)?.enumerable) continue;
      Reflect.set(copy, key, copyStaticData(Reflect.get(value, key), copies));
    }
    return copy;
  }
  if (!isPlainObject(value)) return value;

  const copy: Record<PropertyKey, unknown> =
    Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  copies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (!Object.getOwnPropertyDescriptor(value, key)?.enumerable) continue;
    copy[key] = copyStaticData(Reflect.get(value, key), copies);
  }
  return copy;
}
