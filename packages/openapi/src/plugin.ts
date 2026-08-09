import type * as Schmock from "@schmock/core";
import { SchmockError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { version as packageVersion } from "../package.json";
import { dispatchCallbacks, getRouteCallbacks } from "./callbacks.js";
import { detectCrudResources } from "./crud-detector.js";
import {
  applyOverrides,
  logResourceDetection,
  registerCrudRoutes,
  registerNonCrudRoutes,
} from "./crud-registration.js";
import type { ParsedPath, ParsedResponseEntry } from "./parser.js";
import { parseSpec } from "./parser.js";
import {
  applyResponseContentType,
  createBodyValidatorContext,
  processContentNegotiation,
  processPreferHeader,
  validateRequestBody,
  validateResponse,
  validateSecurity,
} from "./request-pipeline.js";
import { isStatusInRange } from "./response-status.js";
import type { SeedConfig, SeedSource } from "./seed.js";
import { loadSeed } from "./seed.js";

export type { SeedConfig, SeedSource };

export type OnSchemaCallback = (
  schema: JSONSchema7,
  context: {
    method: string;
    path: string;
    params: Record<string, string>;
    query: Record<string, string>;
    headers: Record<string, string>;
  },
) => JSONSchema7 | undefined;

export type OpenApiOptions = Schmock.OpenApiOptions;
export type OpenApiCallbackOptions = Schmock.OpenApiCallbackOptions;
export type OpenApiCallbackRequest = Schmock.OpenApiCallbackRequest;

const REQUEST_REJECTED_STATE = "openapi:requestRejected";

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
  if (options.queryFeatures !== undefined) {
    throw new SchmockError(
      'OpenAPI option "queryFeatures" is not implemented',
      "OPENAPI_UNSUPPORTED_OPTION",
      { option: "queryFeatures" },
    );
  }

  const spec = await parseSpec(options.spec);
  const { resources, nonCrudPaths } = detectCrudResources(spec.paths);
  const seedData = options.seed
    ? await loadSeed(options.seed, resources, options.fakerSeed)
    : new Map<string, unknown[]>();

  // Build a lookup of all parsed paths for process() to reference
  const allParsedPaths = new Map<string, ParsedPath>();
  for (const pp of [...spec.paths]) {
    allParsedPaths.set(`${pp.method} ${pp.path}`, pp);
  }

  // Security scheme lookup
  const securitySchemes = spec.securitySchemes;
  const globalSecurity = spec.globalSecurity;

  // Separate request/response AJV instances prevent duplicate schema IDs in
  // one spec and isolate validators belonging to different plugin instances.
  const requestValidatorCtx = createBodyValidatorContext();
  const responseValidatorCtx = createBodyValidatorContext();

  return {
    name: "@schmock/openapi",
    version: packageVersion,

    install(instance: Schmock.CallableMockInstance) {
      // Apply user-provided schema overrides
      if (options.schemas) {
        for (const [key, schema] of Object.entries(options.schemas)) {
          const parts = key.split(" ");
          const method = parts[0];
          const path = parts[1];
          const status = parts[2] ? Number.parseInt(parts[2], 10) : undefined;
          const routeKey = `${method} ${path}`;

          const parsedPath = allParsedPaths.get(routeKey);
          if (!parsedPath) continue;

          if (status !== undefined) {
            const entry = parsedPath.responses.get(status);
            if (entry) {
              replaceResponseSchema(entry, schema);
            } else {
              parsedPath.responses.set(status, { schema, description: "" });
            }
          } else {
            let patched = false;
            for (const [code, entry] of parsedPath.responses) {
              if (isStatusInRange(code, 200, 300)) {
                replaceResponseSchema(entry, schema);
                patched = true;
                break;
              }
            }
            if (!patched) {
              parsedPath.responses.set(200, { schema, description: "" });
            }
          }
        }
      }

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
      registerNonCrudRoutes(
        instance,
        nonCrudPaths,
        options.fakerSeed,
        options.onSchema,
      );
    },

    beforeRequest(
      context: Schmock.PluginContext,
    ): Schmock.PluginResult | undefined {
      if (options.security) {
        const securityResult = validateSecurity(
          context,
          securitySchemes ?? new Map(),
          globalSecurity,
        );
        if (securityResult) return rejectRequest(context, securityResult);
      }

      const preflightResponseStatus =
        context.route["openapi:preflightResponseStatus"];
      if (typeof preflightResponseStatus === "number") {
        const contentResult = processContentNegotiation(
          context,
          preflightResponseStatus,
        );
        if (contentResult) return rejectRequest(context, contentResult);
      }

      if (options.validateRequests) {
        const validationResult = validateRequestBody(
          context,
          requestValidatorCtx,
        );
        if (validationResult) return rejectRequest(context, validationResult);
      }

      return undefined;
    },

    async process(
      context: Schmock.PluginContext,
      incomingResponse?: unknown,
    ): Promise<Schmock.PluginResult> {
      if (
        context.requestShortCircuited === true ||
        context.state.get(REQUEST_REJECTED_STATE) === true
      ) {
        return { context, response: incomingResponse };
      }

      const result = await processPreferHeader(
        context,
        incomingResponse,
        options.fakerSeed,
        options.onSchema,
      );
      const negotiated = applyResponseContentType(context, result.response);
      const response = negotiated.response;
      if (negotiated.rejected) {
        return { context, response };
      }

      if (options.validateResponses) {
        const validationResult = validateResponse(
          context,
          response,
          responseValidatorCtx,
        );
        if (validationResult) return validationResult;
      }

      if (options.callbacks) {
        const callbacks = getRouteCallbacks(context.route);
        if (callbacks && callbacks.length > 0) {
          await dispatchCallbacks(
            callbacks,
            options.callbacks.dispatch,
            context,
            response,
          );
        }
      }

      return { context, response };
    },
  };
}

function rejectRequest(
  context: Schmock.PluginContext,
  result: Schmock.PluginResult,
): Schmock.PluginResult {
  context.state.set(REQUEST_REJECTED_STATE, true);
  return result;
}

function replaceResponseSchema(
  entry: ParsedResponseEntry,
  schema: JSONSchema7,
): void {
  entry.schema = schema;
  if (!entry.content) return;
  for (const content of entry.content.values()) {
    content.schema = schema;
  }
}
