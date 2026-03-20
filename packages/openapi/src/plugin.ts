/// <reference path="../../core/schmock.d.ts" />

import { version as packageVersion } from "../package.json";
import { fireCallbacks, getRouteCallbacks } from "./callbacks.js";
import { detectCrudResources } from "./crud-detector.js";
import {
  applyOverrides,
  logResourceDetection,
  registerCrudRoutes,
  registerNonCrudRoutes,
} from "./crud-registration.js";
import type { ParsedPath } from "./parser.js";
import { parseSpec } from "./parser.js";
import {
  processContentNegotiation,
  processPreferHeader,
  validateRequestBody,
  validateSecurity,
} from "./request-pipeline.js";
import type { SeedConfig, SeedSource } from "./seed.js";
import { loadSeed } from "./seed.js";

export type { SeedConfig, SeedSource };

export interface OpenApiOptions {
  /** File path or inline spec object */
  spec: string | object;
  /** Optional seed data per resource */
  seed?: SeedConfig;
  /** Validate request bodies (default: false) */
  validateRequests?: boolean;
  /** Validate response bodies (default: false) */
  validateResponses?: boolean;
  /** Query features for list endpoints */
  queryFeatures?: {
    pagination?: boolean;
    sorting?: boolean;
    filtering?: boolean;
  };
  /** Override auto-detected response format per resource */
  resources?: Record<string, Schmock.ResourceOverride>;
  /** Log auto-detection decisions to console (default: false) */
  debug?: boolean;
  /** Seed for deterministic random generation */
  fakerSeed?: number;
  /** Validate security schemes (API key, Bearer, Basic) (default: false) */
  security?: boolean;
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
    ? await loadSeed(options.seed, resources)
    : new Map<string, unknown[]>();

  // Build a lookup of all parsed paths for process() to reference
  const allParsedPaths = new Map<string, ParsedPath>();
  for (const pp of [...spec.paths]) {
    allParsedPaths.set(`${pp.method} ${pp.path}`, pp);
  }

  // Security scheme lookup
  const securitySchemes = spec.securitySchemes;
  const globalSecurity = spec.globalSecurity;

  return {
    name: "@schmock/openapi",
    version: packageVersion,

    install(instance: Schmock.CallableMockInstance) {
      if (options.debug) {
        console.log(
          `[@schmock/openapi] Detected ${resources.length} CRUD resources, ${nonCrudPaths.length} static routes`,
        );
      }

      // Register CRUD routes with metadata
      for (const resource of resources) {
        const override = options.resources?.[resource.name];
        if (override) {
          applyOverrides(resource, override);
        }

        if (options.debug) {
          logResourceDetection(resource, override);
        }

        registerCrudRoutes(
          instance,
          resource,
          seedData.get(resource.name),
          allParsedPaths,
        );
      }

      // Register non-CRUD routes with static generators
      registerNonCrudRoutes(instance, nonCrudPaths, options.fakerSeed);
    },

    process(
      context: Schmock.PluginContext,
      response?: unknown,
    ): Schmock.PluginResult {
      // 1. Security validation (if enabled)
      if (options.security && securitySchemes) {
        const securityResult = validateSecurity(
          context,
          securitySchemes,
          globalSecurity,
        );
        if (securityResult) return securityResult;
      }

      // 2. Content negotiation
      const contentResult = processContentNegotiation(context);
      if (contentResult) return contentResult;

      // 3. Request validation (if enabled)
      if (options.validateRequests) {
        const validationResult = validateRequestBody(context);
        if (validationResult) {
          return validationResult;
        }
      }

      // 4. Prefer header handling
      const result = processPreferHeader(context, response, options.fakerSeed);

      // 5. Fire callbacks (fire-and-forget, after response is determined)
      const callbacks = getRouteCallbacks(context.route);
      if (callbacks && callbacks.length > 0) {
        fireCallbacks(callbacks, context, result.response);
      }

      return result;
    },
  };
}
