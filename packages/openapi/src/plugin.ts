import type * as Schmock from "@schmock/core";
import { getHeader, isHttpMethod, SchmockError } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import { version as packageVersion } from "../package.json";
import { dispatchCallbacks, getRouteCallbacks } from "./callbacks.js";
import { detectCrudResources } from "./crud-detector.js";
import {
  applyOverrides,
  assertKnownResourceOverrides,
  logResourceDetection,
  registerCrudRoutes,
  registerNonCrudRoutes,
  selectRequestEncoding,
  selectRequestSchema,
} from "./crud-registration.js";
import {
  NORMALIZED_BODY_SOURCE_KEY,
  PENDING_MUTATIONS_KEY,
} from "./generators.js";
import { createOwnerToken, isOwnedRoute } from "./owner.js";
import type { ParsedPath, ParsedResponseEntry } from "./parser.js";
import { convertPathTemplate, parseSpec } from "./parser.js";
import { templateToRoutePath } from "./path-template.js";
import {
  NORMALIZED_BODY_STATE_KEY,
  normalizeRequestBody,
} from "./request-body.js";
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
import { createHeaderSeed } from "./response-headers.js";
import {
  CREATE_SUCCESS_STATUS_ORDER,
  findSuccessResponse,
  isStatusInRange,
} from "./response-status.js";
import type { SeedConfig, SeedSource } from "./seed.js";
import { assertValidSeedConfig, loadSeed } from "./seed.js";
import { normalizeMediaType } from "./utils.js";

export type { SeedConfig, SeedSource };

export type OnSchemaCallback = Schmock.OnSchemaCallback;
export type OnSchemaContext = Schmock.OnSchemaContext;
export type OpenApiOptions = Schmock.OpenApiOptions;
export type OpenApiRefPolicy = Schmock.OpenApiRefPolicy;
export type OpenApiCallbackOptions = Schmock.OpenApiCallbackOptions;
export type OpenApiCallbackRequest = Schmock.OpenApiCallbackRequest;
export type ResourceOverride = Schmock.ResourceOverride;
export type CrudOperationMeta = Schmock.CrudOperationMeta;

const REQUEST_REJECTED_STATE = "openapi:requestRejected";
/** The status an applied Prefer directive answered with, for afterResponse. */
const PREFER_STATUS_STATE = "openapi:preferStatus";
/**
 * Set by `process()` once it has handled the route's own response without
 * throwing. It stays unset when a `beforeRequest` answered instead (this
 * plugin's rejection, or another plugin's short-circuit), when an `onError`
 * hook recovered a generator failure, since core skips the response
 * processors then, and when `process()` itself threw: the operation did not
 * run, or did not finish, so afterResponse commits nothing and dispatches no
 * callback. A failure a plugin piped later raised after it was set is caught
 * by core's `context.recoveredFromError` instead.
 */
const OPERATION_RAN_STATE = "openapi:operationRan";

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
    applySchemaOverrides(
      allParsedPaths,
      options.schemas,
      crudCreates(spec.paths),
    );
  }

  const { resources, nonCrudPaths } = detectCrudResources(spec.paths);
  assertKnownResourceOverrides(options.resources, resources);
  // `null` is read as "no seed" like `undefined`; anything else goes through
  // validation, so a JS caller's `seed: 42` (meant as `fakerSeed`) or a typo'd
  // resource key fails here instead of silently leaving collections empty.
  const seedOption: unknown = options.seed;
  let seedData = new Map<string, unknown[]>();
  if (seedOption !== undefined && seedOption !== null) {
    assertValidSeedConfig(seedOption, resources);
    seedData = await loadSeed(seedOption, resources, options.fakerSeed);
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

      // The body the normalization below reads. A plugin piped later may still
      // replace `context.body`; the CRUD generators then normalize the
      // replacement instead of storing this one.
      context.state.set(NORMALIZED_BODY_SOURCE_KEY, context.body);
      if (options.validateRequests) {
        const validationResult = validateRequestBody(
          context,
          requestValidatorCtx,
        );
        if (validationResult) return rejectRequest(context, validationResult);
      } else {
        storeNormalizedBody(context);
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
        return { context, response: incomingResponse };
      }

      const result = await processPreferHeader(
        context,
        incomingResponse,
        options.fakerSeed,
        options.onSchema,
      );
      if (result.applied) {
        // A Prefer response is a pure simulation: its body was generated or
        // taken from an example, not from the write the generator staged, so
        // committing that write would store an item the client never saw and
        // hand the client an id that does not exist. Its status is recorded
        // because afterResponse sees only the final one, and a simulated
        // status still fires its callbacks.
        discardPendingMutations(context);
        context.state.set(
          PREFER_STATUS_STATE,
          getResponseStatus(result.response),
        );
      }
      const negotiated = applyResponseContentType(context, result.response);
      const response = negotiated.response;
      let settled: Schmock.PluginResult = { context, response };
      if (!negotiated.rejected && options.validateResponses) {
        settled =
          validateResponse(context, response, responseValidatorCtx) ?? settled;
      }

      // Only once every step above has returned: a throw in them (an
      // `onSchema` hook failing on a Prefer body) leaves the operation
      // unfinished, and an `onError` hook that recovers it with a 2xx must
      // not commit the write the generator staged.
      context.state.set(OPERATION_RAN_STATE, true);
      return settled;
    },

    // Staged writes are committed, and callbacks dispatched, only here: once
    // the whole pipeline has run and the response is final. Inside process()
    // a plugin piped later could still answer 500 or throw after the row was
    // stored, and an aborted request kept its write. Core skips this hook for
    // a request aborted before it settled, so that write is never committed.
    afterResponse(
      context: Schmock.PluginContext,
      response: Readonly<Schmock.Response>,
    ): Promise<void> | undefined {
      if (!isOwnedRoute(context.route, ownerToken)) return undefined;

      // Commit before callbacks so a callback that re-enters the mock observes
      // committed state.
      // A recovered failure settles nothing even after this plugin's own
      // process() finished: a plugin piped later threw, so the request did
      // not complete, whatever status the recovery answered with.
      const ran =
        context.state.get(OPERATION_RAN_STATE) === true &&
        context.recoveredFromError !== true;
      settlePendingMutations(context, ran && response.status < 400);

      if (!options.callbacks) return undefined;
      const callbacks = getRouteCallbacks(context.route);
      if (!callbacks || callbacks.length === 0) return undefined;
      if (!ran || !shouldDispatchCallbacks(context, response.status)) {
        return undefined;
      }

      // Returned, so the response waits for delivery and an abort of the
      // request while the dispatcher is pending still rejects it. A
      // dispatcher that should not hold the response returns without
      // awaiting its own delivery.
      return dispatchCallbacks(
        callbacks,
        options.callbacks.dispatch,
        context,
        response,
        { seed: options.fakerSeed, debug: options.debug === true },
      );
    },
  };
}

/** Drop the mutations a CRUD generator staged for this request, unapplied. */
function discardPendingMutations(context: Schmock.PluginContext): void {
  context.state.delete(PENDING_MUTATIONS_KEY);
}

/**
 * Apply or discard the mutations a CRUD generator staged for this request, by
 * the request's final status.
 *
 * The pending queue is always cleared first. It is applied only when
 * `apply` says the operation ran to completion and the response the client
 * receives is a success: a `Prefer: code=400`, a 406 from
 * response content negotiation, a 500 from response validation, and a 4xx or
 * 500 that a plugin piped after this one answered with all leave the
 * collection untouched. Any applied Prefer directive has already discarded
 * the queue (see `process()`), so a `Prefer: code=201` on a create stores
 * nothing either. A failure an `onError` hook recovered, even with a 2xx,
 * whether the generator, this plugin's own `process()` or a plugin piped later
 * raised it, did not finish, so whatever it staged is dropped.
 *
 * Only the instance that owns the route settles: clearing another instance's
 * queue would drop a mutation its owner still has to commit.
 */
function settlePendingMutations(
  context: Schmock.PluginContext,
  apply: boolean,
): void {
  const pending = context.state.get(PENDING_MUTATIONS_KEY);
  discardPendingMutations(context);
  if (!Array.isArray(pending) || pending.length === 0) return;
  if (!apply) return;
  for (const commit of pending) {
    if (typeof commit === "function") commit();
  }
}

/**
 * A callback reports something that happened. A rejected request, a 404 or
 * 409 from a CRUD handler, a validation 500 and a failure a later plugin
 * answered with did not happen, so they fire none, and neither does a request
 * whose operation never ran (see `OPERATION_RAN_STATE`). A status a Prefer
 * directive simulated is the simulation the client asked for, and fires with
 * the simulated body.
 */
function shouldDispatchCallbacks(
  context: Schmock.PluginContext,
  status: number,
): boolean {
  if (context.state.get(REQUEST_REJECTED_STATE) === true) return false;
  return status < 400 || context.state.get(PREFER_STATUS_STATE) === status;
}

/**
 * Leave the request body, read the way the operation's request schema reads
 * it, where the CRUD generators look for it (`readRequestBody`). Request
 * validation does this itself; this is the same step when it is off, so a
 * multipart or urlencoded create stores the submitted fields either way.
 */
function storeNormalizedBody(context: Schmock.PluginContext): void {
  if (context.body === undefined) return;
  const contentType = getHeader(context.headers, "content-type");
  context.state.set(
    NORMALIZED_BODY_STATE_KEY,
    normalizeRequestBody(
      context.body,
      contentType,
      requestSchemaFor(context.route, contentType),
      {
        fields: context.form,
        encoding: selectRequestEncoding(
          context.route["openapi:requestContent"],
          context.route["openapi:requestEncoding"],
          contentType,
        ),
      },
    ),
  );
}

/** The request schema declared for the body's media type on `route`. */
function requestSchemaFor(
  route: Schmock.RouteConfig,
  contentType: string | undefined,
): JSONSchema7 | undefined {
  return selectRequestSchema(
    route["openapi:requestBody"],
    route["openapi:requestContent"],
    contentType,
  );
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
 * 2xx entry the route answers with is patched (201 before 200 for a CRUD
 * create in `creates`, the lowest declared 2xx otherwise), and an operation
 * declaring no 2xx gains a synthetic 200.
 *
 * Every key is validated before ANY mutation, and both a malformed key and a
 * well-formed key naming a route the spec does not declare throw. Silently
 * ignoring either turned a typo into a mock that quietly served the unpatched
 * contract.
 */
function applySchemaOverrides(
  paths: Map<string, ParsedPath>,
  schemas: Record<string, JSONSchema7>,
  creates: ReadonlySet<ParsedPath>,
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
    // The parser escapes literal colons (`{job}:run` → `:job\:run`), but an
    // Express-form key already uses `:` for its parameters, so the unescaped
    // rewrite is tried first and keeps every key that resolved before working.
    const legacyKey = `${method} ${templateToRoutePath(path, { escapeLiteralColons: false })}`;
    const routeKey = `${method} ${convertPathTemplate(path)}`;
    const parsedPath = paths.get(legacyKey) ?? paths.get(routeKey);
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

    // The 2xx entry the route answers with: a CRUD create tries 201 before
    // 200 (an upsert contract declaring both answers a fresh create with 201),
    // everything else takes the lowest declared 2xx. Patching the first 2xx in
    // map order changed a create's 200 while it served the untouched 201.
    // A `default` the route would fall back to is not a 2xx entry, and gets a
    // synthetic 200 in front of it instead of being rewritten.
    const success = findSuccessResponse(
      parsedPath.responses,
      creates.has(parsedPath) ? CREATE_SUCCESS_STATUS_ORDER : undefined,
    )?.[1];
    const declaredAs2xx = [...parsedPath.responses].some(
      ([code, entry]) => entry === success && isStatusInRange(code, 200, 300),
    );
    if (success && declaredAs2xx) {
      replaceResponseSchema(success, schema);
    } else {
      parsedPath.responses.set(200, { schema, description: "" });
    }
  }
}

/**
 * The operations CRUD detection will serve as a create. Detection groups and
 * classifies by path and method alone, so running it before the overrides
 * land gives the same answer as the run after them.
 */
function crudCreates(paths: ParsedPath[]): ReadonlySet<ParsedPath> {
  const creates = new Set<ParsedPath>();
  for (const resource of detectCrudResources(paths).resources) {
    for (const route of resource.routes) {
      if (route.op === "create") creates.add(route.parsed);
    }
  }
  return creates;
}

/**
 * Is this a media type an `options.schemas` override should apply to?
 *
 * Override keys carry no media type, so the override is read as a replacement
 * for the JSON-ish contract. Rewriting an `application/xml` branch with it as
 * well would silently reshape a media type the caller never named.
 */
function isJsonMediaType(mediaType: string): boolean {
  const base = normalizeMediaType(mediaType);
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
