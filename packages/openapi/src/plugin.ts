/// <reference path="../../../types/schmock.d.ts" />

import type { CrudResource } from "./crud-detector.js";
import { detectCrudResources } from "./crud-detector.js";
import {
  createCreateGenerator,
  createDeleteGenerator,
  createListGenerator,
  createReadGenerator,
  createStaticGenerator,
  createUpdateGenerator,
} from "./generators.js";
import { parseSpec } from "./parser.js";
import type { SeedConfig, SeedSource } from "./seed.js";
import { loadSeed } from "./seed.js";

export type { SeedConfig, SeedSource };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface OpenApiOptions {
  /** File path or inline spec object */
  spec: string | object;
  /** Optional seed data per resource */
  seed?: SeedConfig;
  /** Validate request bodies (default: true) */
  validateRequests?: boolean;
  /** Validate response bodies (default: false) */
  validateResponses?: boolean;
  /** Query features for list endpoints */
  queryFeatures?: {
    pagination?: boolean;
    sorting?: boolean;
    filtering?: boolean;
  };
}

/**
 * Create an OpenAPI plugin that auto-registers CRUD routes from a spec.
 *
 * @example
 * ```typescript
 * const mock = schmock();
 * mock.pipe(await openapi({
 *   spec: "./petstore.yaml",
 *   seed: { pets: { count: 10 } },
 * }));
 * ```
 */
export async function openapi(
  options: OpenApiOptions,
): Promise<Schmock.Plugin> {
  const spec = await parseSpec(options.spec);
  const { resources, nonCrudPaths } = detectCrudResources(spec.paths);
  const seedData = options.seed
    ? loadSeed(options.seed, resources)
    : new Map<string, unknown[]>();

  return {
    name: "@schmock/openapi",
    version: "1.0.0",

    install(instance: Schmock.CallableMockInstance) {
      // Seed initial state — we need state to be initialized before registering routes
      // The state is populated via generator context.state on first request,
      // but we need to pre-populate it. We'll use a global config state approach.
      // Since generators use ctx.state (the global config state), we set up seed
      // data through a setup route that runs on first access, or we just seed
      // in the generators themselves.

      // Register CRUD routes
      for (const resource of resources) {
        registerCrudRoutes(instance, resource, seedData.get(resource.name));
      }

      // Register non-CRUD routes with static generators
      for (const parsedPath of nonCrudPaths) {
        const routeKey =
          `${parsedPath.method} ${parsedPath.path}` as Schmock.RouteKey;
        instance(routeKey, createStaticGenerator(parsedPath));
      }
    },

    process(
      context: Schmock.PluginContext,
      response?: unknown,
    ): Schmock.PluginResult {
      // Pass through — generators handle everything
      return { context, response };
    },
  };
}

function registerCrudRoutes(
  instance: Schmock.CallableMockInstance,
  resource: CrudResource,
  seedItems?: unknown[],
): void {
  // Create a seeded generator wrapper that initializes state on first call
  const ensureSeeded = createSeeder(resource, seedItems);

  for (const op of resource.operations) {
    switch (op) {
      case "list": {
        const gen = createListGenerator(resource);
        const routeKey = `GET ${resource.basePath}` as Schmock.RouteKey;
        instance(routeKey, wrapWithSeeder(ensureSeeded, gen));
        break;
      }
      case "create": {
        const gen = createCreateGenerator(resource);
        const routeKey = `POST ${resource.basePath}` as Schmock.RouteKey;
        instance(routeKey, wrapWithSeeder(ensureSeeded, gen));
        break;
      }
      case "read": {
        const gen = createReadGenerator(resource);
        const routeKey = `GET ${resource.itemPath}` as Schmock.RouteKey;
        instance(routeKey, wrapWithSeeder(ensureSeeded, gen));
        break;
      }
      case "update": {
        const gen = createUpdateGenerator(resource);
        const putKey = `PUT ${resource.itemPath}` as Schmock.RouteKey;
        const patchKey = `PATCH ${resource.itemPath}` as Schmock.RouteKey;
        instance(putKey, wrapWithSeeder(ensureSeeded, gen));
        instance(patchKey, wrapWithSeeder(ensureSeeded, gen));
        break;
      }
      case "delete": {
        const gen = createDeleteGenerator(resource);
        const routeKey = `DELETE ${resource.itemPath}` as Schmock.RouteKey;
        instance(routeKey, wrapWithSeeder(ensureSeeded, gen));
        break;
      }
    }
  }
}

/**
 * Create a seeder function that initializes collection state once.
 */
function createSeeder(
  resource: CrudResource,
  seedItems?: unknown[],
): (state: Record<string, unknown>) => void {
  const stateKey = `openapi:collections:${resource.name}`;
  const counterKey = `openapi:counter:${resource.name}`;
  const seededKey = `openapi:seeded:${resource.name}`;

  return (state: Record<string, unknown>) => {
    if (state[seededKey]) return;
    state[seededKey] = true;

    if (seedItems && seedItems.length > 0) {
      state[stateKey] = [...seedItems];
      // Set counter to highest existing ID
      let maxId = 0;
      for (const item of seedItems) {
        if (isRecord(item) && resource.idParam in item) {
          const id = item[resource.idParam];
          if (typeof id === "number" && id > maxId) {
            maxId = id;
          }
        }
      }
      state[counterKey] = maxId;
    } else {
      state[stateKey] = [];
      state[counterKey] = 0;
    }
  };
}

function wrapWithSeeder(
  seeder: (state: Record<string, unknown>) => void,
  generator: Schmock.GeneratorFunction,
): Schmock.GeneratorFunction {
  return (ctx: Schmock.RequestContext) => {
    seeder(ctx.state);
    return generator(ctx);
  };
}
