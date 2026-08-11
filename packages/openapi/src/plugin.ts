import type * as Schmock from "@schmock/core";
import { isHttpMethod, SchmockError } from "@schmock/core";
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
import { createHeaderSeed, PENDING_MUTATIONS_KEY } from "./generators.js";
import { createOwnerToken, isOwnedRoute } from "./owner.js";
import type { ParsedPath, ParsedResponseEntry } from "./parser.js";
import { convertPathTemplate, parseSpec } from "./parser.js";
import {
  applyResponseContentType,
  createBodyValidatorContext,
  getResponseStatus,
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

  const spec = await parseSpec(options.spec, {
    strict: options.strict,
    refs: options.refs,
  });
  if (options.debug) {
    for (const warning of spec.warnings) {
      console.warn(`[@schmock/openapi] ${warning}`);
    }
  }
  // One token per openapi() call, captured by install/beforeRequest/process so
  // the hooks only ever act on routes this plugin instance registered.
  const ownerToken = createOwnerToken();

  // Build a lookup of all parsed paths for process() to reference
  const allParsedPaths = new Map<string, ParsedPath>();
  for (const pp of [...spec.paths]) {
    allParsedPaths.set(`${pp.method} ${pp.path}`, pp);
  }

  // Overrides patch the ParsedPath objects everything downstream reads, so they
  // have to land BEFORE detection and seeding: CRUD metadata and `{ count: n }`
  // seed generation are both derived from those schemas exactly once.
  if (options.schemas) {
    applySchemaOverrides(allParsedPaths, options.schemas);
  }

  const { resources, nonCrudPaths } = detectCrudResources(spec.paths);
  const seedData = options.seed
    ? await loadSeed(options.seed, resources, options.fakerSeed)
    : new Map<string, unknown[]>();

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
      // Installation-local, not module- or openapi()-scoped: every route in one
      // mock shares an ordinal while separately installed mocks replay it.
      const headerSeed = createHeaderSeed(options.fakerSeed);
      const generationHooks = {
        fakerSeed: options.fakerSeed,
        onSchema: options.onSchema,
        headerSeed,
      };
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
          ownerToken,
          generationHooks,
        );
      }

      // Register non-CRUD routes with static generators
      registerNonCrudRoutes(
        instance,
        nonCrudPaths,
        ownerToken,
        generationHooks,
      );
    },

    beforeRequest(
      context: Schmock.PluginContext,
    ): Schmock.PluginResult | undefined {
      // Routes this plugin did not register (manual routes, or routes from a
      // second openapi() instance) carry no openapi:* metadata, so security,
      // negotiation and validation would fall back to THIS spec's globals.
      if (!isOwnedRoute(context.route, ownerToken)) return undefined;

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
      if (!isOwnedRoute(context.route, ownerToken)) {
        return { context, response: incomingResponse };
      }

      if (
        context.requestShortCircuited === true ||
        context.state.get(REQUEST_REJECTED_STATE) === true
      ) {
        settlePendingMutations(context, incomingResponse);
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
        settlePendingMutations(context, response);
        return { context, response };
      }

      if (options.validateResponses) {
        const validationResult = validateResponse(
          context,
          response,
          responseValidatorCtx,
        );
        if (validationResult) {
          settlePendingMutations(context, validationResult.response);
          return validationResult;
        }
      }

      // Commit before callbacks so a callback that re-enters the mock observes
      // committed state.
      settlePendingMutations(context, response);

      if (options.callbacks) {
        const callbacks = getRouteCallbacks(context.route);
        if (callbacks && callbacks.length > 0) {
          await dispatchCallbacks(
            callbacks,
            options.callbacks.dispatch,
            context,
            response,
            options.fakerSeed,
          );
        }
      }

      return { context, response };
    },
  };
}

/**
 * Apply or discard the mutations a CRUD generator staged for this request.
 *
 * The pending queue is always cleared first, so a second `openapi()` instance
 * later in the pipe cannot re-commit it. The queue is then applied only when the
 * response the plugin is about to return is a success: a `Prefer: code=400`, a
 * `Prefer: example=<4xx>`, a 406 from response content negotiation and a 500
 * from response validation all leave the collection untouched.
 *
 * Not called on the not-owned early return: clearing another instance's queue
 * there would drop a mutation its owner still has to commit.
 */
function settlePendingMutations(
  context: Schmock.PluginContext,
  response: unknown,
): void {
  const pending = context.state.get(PENDING_MUTATIONS_KEY);
  context.state.delete(PENDING_MUTATIONS_KEY);
  if (!Array.isArray(pending) || pending.length === 0) return;
  if (getResponseStatus(response) >= 400) return;
  for (const commit of pending) {
    if (typeof commit === "function") commit();
  }
}

function rejectRequest(
  context: Schmock.PluginContext,
  result: Schmock.PluginResult,
): Schmock.PluginResult {
  context.state.set(REQUEST_REJECTED_STATE, true);
  return result;
}

/**
 * The one grammar an `options.schemas` key may take.
 *
 * Deliberately not `key.split(" ")`: that accepted `"GET /widgets 200 extra"`
 * by dropping the tail, and `Number.parseInt("2xx", 10) === 2` turned a typo
 * into a phantom `responses[2]` entry that then won status selection. One
 * anchored pattern rejects extra tokens, non-3-digit statuses, lowercase
 * methods, a missing space and a path without a leading slash at once.
 */
const SCHEMA_OVERRIDE_KEY = /^([A-Z]+) (\/\S*)(?: ([1-5]\d{2}))?$/;

const SCHEMA_OVERRIDE_GRAMMAR =
  'expected "METHOD /path" or "METHOD /path STATUS" (uppercase method, path with a leading slash, 3-digit status); a path parameter may be written "{petId}" or ":petId"';

function invalidOverrideKey(key: string, reason: string): SchmockError {
  return new SchmockError(
    `Invalid OpenAPI schema override key "${key}": ${reason}.`,
    "OPENAPI_INVALID_SCHEMA_OVERRIDE",
    { key },
  );
}

/**
 * Apply `options.schemas` onto the parsed paths, in place.
 *
 * Keys are `"METHOD /path"` or `"METHOD /path STATUS"`. Without a status the
 * first declared 2xx entry is patched, and an operation declaring no 2xx gains
 * a synthetic 200.
 *
 * Every key is validated before ANY mutation, and both a malformed key and a
 * well-formed key naming a route the spec does not declare throw. Silently
 * ignoring either turned a typo into a mock that quietly served the unpatched
 * contract.
 */
function applySchemaOverrides(
  paths: Map<string, ParsedPath>,
  schemas: Record<string, JSONSchema7>,
): void {
  const parsed: Array<{
    parsedPath: ParsedPath;
    status?: number;
    schema: JSONSchema7;
  }> = [];

  for (const [key, schema] of Object.entries(schemas)) {
    const match = SCHEMA_OVERRIDE_KEY.exec(key);
    if (!match) {
      throw invalidOverrideKey(key, SCHEMA_OVERRIDE_GRAMMAR);
    }
    const [, method, path, statusText] = match;
    if (!isHttpMethod(method)) {
      throw invalidOverrideKey(
        key,
        `"${method}" is not a supported HTTP method`,
      );
    }
    // `ParsedPath.path` is always the Express form, so a key copied verbatim
    // out of the spec (`GET /pets/{petId}`) has to go through the parser's own
    // rewrite before the lookup. Both spellings therefore name one operation;
    // the parameter NAME still matters, because it is part of the route key.
    const routeKey = `${method} ${convertPathTemplate(path)}`;
    const parsedPath = paths.get(routeKey);
    if (!parsedPath) {
      // When the key used `{param}`, say which form was actually looked up —
      // otherwise the message reads as a claim about the spelling the author
      // wrote rather than about the route.
      const lookedUp =
        routeKey === `${method} ${path}`
          ? ""
          : ` (path parameters are matched in Express form, so it was looked up as "${routeKey}")`;
      throw invalidOverrideKey(
        key,
        `the spec declares no "${method} ${path}" operation${lookedUp}`,
      );
    }
    parsed.push({
      parsedPath,
      status: statusText === undefined ? undefined : Number(statusText),
      schema,
    });
  }

  for (const { parsedPath, status, schema } of parsed) {
    if (status !== undefined) {
      const entry = parsedPath.responses.get(status);
      if (entry) {
        replaceResponseSchema(entry, schema);
      } else {
        parsedPath.responses.set(status, { schema, description: "" });
      }
      continue;
    }

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

/**
 * Is this a media type an `options.schemas` override should apply to?
 *
 * Override keys carry no media type, so the override is read as a replacement
 * for the JSON-ish contract. Rewriting an `application/xml` branch with it as
 * well would silently reshape a media type the caller never named.
 */
function isJsonMediaType(mediaType: string): boolean {
  const base = mediaType.split(";")[0].trim().toLowerCase();
  return (
    base === "application/json" || base.endsWith("+json") || base === "*/*"
  );
}

function replaceResponseSchema(
  entry: ParsedResponseEntry,
  schema: JSONSchema7,
): void {
  entry.schema = schema;
  if (!entry.content || entry.content.size === 0) return;

  let patched = false;
  for (const [mediaType, content] of entry.content) {
    if (isJsonMediaType(mediaType)) {
      content.schema = schema;
      patched = true;
    }
  }

  // A route declaring exactly one non-JSON media type still honours the
  // override: there is no ambiguity about which contract was meant.
  if (!patched && entry.content.size === 1) {
    for (const content of entry.content.values()) {
      content.schema = schema;
    }
  }
}
