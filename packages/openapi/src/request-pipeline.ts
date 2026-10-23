import type * as Schmock from "@schmock/core";
import { getHeader, getResponseParts } from "@schmock/core";
import { toError } from "@schmock/core/adapter";
import { generateFromSchema } from "@schmock/faker";
import type { CodeOptions, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { JSONSchema7 } from "json-schema";
import {
  negotiateContentType,
  selectResponseMediaType,
} from "./content-negotiation.js";
import { asSchemaGenerationError } from "./generators.js";
import type {
  ParsedResponseContent,
  ParsedResponseEntry,
  SecurityScheme,
} from "./parser.js";
import { parsePreferHeader } from "./prefer.js";
import {
  admitsType,
  isBinaryPayload,
  isFormMediaType,
  isJsonMediaType,
  isUntyped,
  NORMALIZED_BODY_STATE_KEY,
  normalizeRequestBody,
  toValidationInstance,
} from "./request-body.js";
import {
  findResponseEntry,
  findSuccessResponse,
  type ResponseStatusKey,
} from "./response-status.js";
import { hasType, isRecord, normalizeMediaType } from "./utils.js";

// Every request header is read through core's case-insensitive `getHeader`:
// core does not normalize header case at `mock.handle`, so a direct-API caller
// (unit test, BDD step, callable API with no adapter) still delivers
// `Accept`/`PREFER` exactly as written. The adapters lowercase, but they are
// not the only entry point.

// Type-safe route config accessors (avoid `as` casts on `[key: string]: unknown`)
function getRouteSecurity(route: Schmock.RouteConfig): string[][] | undefined {
  const value = route["openapi:security"];
  return Array.isArray(value) ? value : undefined;
}

function getRouteResponses(
  route: Schmock.RouteConfig,
): Map<ResponseStatusKey, ParsedResponseEntry> | undefined {
  const value = route["openapi:responses"];
  return value instanceof Map ? value : undefined;
}

function getRouteRequestBody(
  route: Schmock.RouteConfig,
): JSONSchema7 | undefined {
  const value = route["openapi:requestBody"];
  return isRecord(value) ? value : undefined;
}

/**
 * A body core handed over undecoded: a string for `text/*`, bytes for every
 * other media type it does not parse as JSON or as a form.
 */
function isUndecodedBody(body: unknown, mediaType: string): boolean {
  if (isJsonMediaType(mediaType) || isFormMediaType(mediaType)) return false;
  return typeof body === "string" || isBinaryPayload(body);
}

// `hasType`, not `type === "string"`: the normalizer turns 3.0 `nullable: true`
// into `type: ["string", "null"]`, which 3.1 also writes directly.
function isBinaryStringSchema(schema: JSONSchema7): boolean {
  return hasType(schema, "string") && schema.format === "binary";
}

function isRouteRequestBodyRequired(route: Schmock.RouteConfig): boolean {
  return route["openapi:requestBodyRequired"] === true;
}

function getRouteRequestContent(
  route: Schmock.RouteConfig,
): Map<string, JSONSchema7 | undefined> | undefined {
  const value = route["openapi:requestContent"];
  return value instanceof Map ? value : undefined;
}

/**
 * Which declared request media type covers `mediaType`, if any.
 *
 * Wildcards are matched the way a spec author means them: an explicit key wins,
 * then `type/*`, then `*​/*`.
 */
function selectRequestMediaType(
  content: Map<string, JSONSchema7 | undefined>,
  mediaType: string,
): string | undefined {
  if (content.has(mediaType)) return mediaType;
  const type = mediaType.split("/", 1)[0];
  if (content.has(`${type}/*`)) return `${type}/*`;
  if (content.has("*/*")) return "*/*";
  return undefined;
}

function unsupportedMediaTypeError(
  context: Schmock.PluginContext,
  supported: string[],
): Schmock.PluginResult {
  return {
    context,
    response: [
      415,
      {
        error: "Unsupported Media Type",
        code: "UNSUPPORTED_MEDIA_TYPE",
        supported,
      },
    ],
  };
}

/**
 * Validate security requirements for the request.
 * Returns 401 if auth is required and missing/invalid.
 */
export function validateSecurity(
  context: Schmock.PluginContext,
  schemes: Map<string, SecurityScheme>,
  globalSecurity?: string[][],
): Schmock.PluginResult | undefined {
  // Determine applicable security: operation-level overrides global
  const routeSecurity = getRouteSecurity(context.route);
  const security = routeSecurity ?? globalSecurity;

  // No security requirements
  if (!security || security.length === 0) return undefined;

  // Check each OR group — if any group passes, request is authorized
  for (const group of security) {
    // Empty group = public endpoint (security: [{}])
    if (group.length === 0) return undefined;

    // All schemes in the group must pass (AND)
    const allPass = group.every((schemeName) => {
      const scheme = schemes.get(schemeName);
      if (!scheme) return false;
      return checkSchemePresence(scheme, context);
    });

    if (allPass) return undefined;
  }

  // No group passed — build WWW-Authenticate header
  const wwwAuth = buildWwwAuthenticate(security, schemes);
  const headers: Record<string, string> = {};
  if (wwwAuth) {
    headers["www-authenticate"] = wwwAuth;
  }

  return {
    context,
    response: [
      401,
      {
        error: "Unauthorized",
        code: "UNAUTHORIZED",
      },
      headers,
    ],
  };
}

function checkSchemePresence(
  scheme: SecurityScheme,
  context: Schmock.PluginContext,
): boolean {
  if (scheme.type === "http") {
    const auth = getHeader(context.headers, "authorization") ?? "";
    if (scheme.scheme === "bearer") {
      return /^bearer\s+\S+/i.test(auth);
    }
    if (scheme.scheme === "basic") {
      return /^basic\s+\S+/i.test(auth);
    }
    return false;
  }

  if (scheme.type === "apiKey") {
    if (!scheme.name) return false;
    if (scheme.in === "header") {
      return hasValue(getHeader(context.headers, scheme.name));
    }
    if (scheme.in === "query") {
      return hasValue(context.query[scheme.name]);
    }
    if (scheme.in === "cookie") {
      return hasCookieValue(getHeader(context.headers, "cookie"), scheme.name);
    }
    return false;
  }

  if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
    const auth = getHeader(context.headers, "authorization") ?? "";
    return /^bearer\s+\S+/i.test(auth);
  }

  // The client certificate is presented in the TLS handshake, which a mock
  // never sees (handle(), fetch interception and a plain-http listen() alike),
  // so there is nothing to check and a requirement on it always holds.
  if (scheme.type === "mutualTLS") return true;

  return false;
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function hasCookieValue(
  cookieHeader: string | undefined,
  name: string,
): boolean {
  if (!cookieHeader) return false;

  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const cookieName = segment.slice(0, separator).trim();
    const cookieValue = segment.slice(separator + 1).trim();
    if (cookieName === name) return cookieValue.length > 0;
  }

  return false;
}

function buildWwwAuthenticate(
  security: string[][],
  schemes: Map<string, SecurityScheme>,
): string {
  const challenges: string[] = [];

  for (const group of security) {
    for (const schemeName of group) {
      const scheme = schemes.get(schemeName);
      if (!scheme) continue;

      if (scheme.type === "http" && scheme.scheme === "bearer") {
        if (!challenges.includes("Bearer")) challenges.push("Bearer");
      } else if (scheme.type === "http" && scheme.scheme === "basic") {
        if (!challenges.includes("Basic")) challenges.push("Basic");
      } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
        if (!challenges.includes("Bearer")) challenges.push("Bearer");
      }
    }
  }

  return challenges.join(", ");
}

/**
 * Check Accept header against available content types. Returns 406 if no match.
 */
export function processContentNegotiation(
  context: Schmock.PluginContext,
  defaultStatus?: number,
): Schmock.PluginResult | undefined {
  const accept = getHeader(context.headers, "accept");
  if (!accept || accept === "*/*") return undefined;

  const responses = getRouteResponses(context.route);
  if (!responses) return undefined;

  const prefer = parsePreferHeader(getHeader(context.headers, "prefer") ?? "");
  let selectedEntry: ParsedResponseEntry | undefined;
  if (prefer.code !== undefined) {
    selectedEntry = findResponseEntry(responses, prefer.code);
  } else if (prefer.example !== undefined) {
    selectedEntry = [...responses.values()].find(
      (entry) =>
        selectResponseExample(context, entry, prefer.example ?? "").found,
    );
  } else if (defaultStatus !== undefined) {
    selectedEntry = findResponseEntry(responses, defaultStatus);
  } else {
    return undefined;
  }

  const availableContentTypes = selectedEntry?.contentTypes ?? [];

  // No content types defined in spec → skip negotiation
  if (availableContentTypes.length === 0) return undefined;

  const matched = negotiateContentType(accept, availableContentTypes);
  if (!matched) {
    return {
      context,
      response: [
        406,
        {
          error: "Not Acceptable",
          code: "NOT_ACCEPTABLE",
          acceptable: availableContentTypes,
        },
      ],
    };
  }

  return undefined;
}

/**
 * Decimal places of tolerance AJV allows when it divides a value by
 * `multipleOf`. Without one, 19.99 / 0.01 comes out as 1998.9999999999998 and
 * an exact amount of cents fails `multipleOf: 0.01`. The quotient's rounding
 * error grows with the value, so a tighter tolerance rejects large amounts
 * again: 1e-9 already refuses 1234567.89, while 1e-6 holds for cent values
 * past a hundred million.
 */
const MULTIPLE_OF_PRECISION = 6;

/**
 * Compiles a spec `pattern` the way faker's `compilePattern` does: with the
 * `u` flag first, then without it for patterns only the legacy grammar
 * accepts. AJV's default engine is `u`-only, so a pattern such as
 * `^\d{3}\-\d{4}$` (an identity escape `u` forbids) failed to compile while
 * faker generated values from it. A pattern neither grammar accepts still
 * throws.
 */
const specPatternEngine: NonNullable<CodeOptions["regExp"]> = Object.assign(
  (pattern: string, flags: string): RegExp => {
    try {
      return new RegExp(pattern, flags);
    } catch (error) {
      if (!flags.includes("u")) throw error;
      return new RegExp(pattern, flags.replace("u", ""));
    }
  },
  // Read only when AJV emits standalone source, which this package never does.
  { code: "specPatternEngine" },
);

/**
 * Per-plugin validator context. Each openapi() call creates its own
 * AJV instance and schema cache so that loading multiple specs in the
 * same process can't collide on duplicate \$id values.
 */
export interface BodyValidatorContext {
  ajv: Ajv2020;
  cache: WeakMap<object, ValidateFunction>;
  /**
   * Why a schema failed to compile, so a route whose schema cannot compile
   * answers from the recorded error instead of compiling it on every request.
   */
  failures: WeakMap<object, Error>;
}

export function createBodyValidatorContext(): BodyValidatorContext {
  const ajv = new Ajv2020({
    allErrors: true,
    strictSchema: false,
    strictTypes: false,
    multipleOfPrecision: MULTIPLE_OF_PRECISION,
    code: { regExp: specPatternEngine },
    // With strictSchema off AJV ignores an unknown format such as Stripe's
    // `unix-time`, but logs two console lines per occurrence on every compile:
    // tens of thousands for one large response schema, with no option to
    // silence them. Its other warnings are strict-mode remarks on the spec's
    // own schemas, which the mock's user cannot act on either.
    logger: false,
  });
  addFormats(ajv);

  return {
    ajv,
    cache: new WeakMap(),
    failures: new WeakMap(),
  };
}

/**
 * The validator for `schema`, compiled once per context and cached on the
 * schema object the parser handed over. A schema that fails to compile throws
 * the same error on every later call without being compiled again.
 */
function getValidator(
  validatorCtx: BodyValidatorContext,
  schema: JSONSchema7,
): ValidateFunction {
  const cached = validatorCtx.cache.get(schema);
  if (cached) return cached;
  const failure = validatorCtx.failures.get(schema);
  if (failure) throw failure;

  try {
    const validate = validatorCtx.ajv.compile(
      isRecord(schema) ? shareRepeatedSubschemas(schema) : schema,
    );
    validatorCtx.cache.set(schema, validate);
    return validate;
  } catch (error) {
    const compileError = toError(error);
    validatorCtx.failures.set(schema, compileError);
    throw compileError;
  }
}

/** Keywords whose value is a single subschema. */
const SUBSCHEMA_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = [
  "allOf",
  "anyOf",
  "items",
  "oneOf",
  "prefixItems",
] as const;

/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
] as const;

/** Keywords that point at another schema by URI or JSON pointer. */
const REFERENCE_KEYWORDS = ["$ref", "$dynamicRef", "$recursiveRef"] as const;

/** Keywords that name a schema so that a reference can point at it. */
const IDENTITY_KEYWORDS = [
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$recursiveAnchor",
] as const;

/** `$defs` key prefix for a subschema moved there by shareRepeatedSubschemas. */
const SHARED_DEF_PREFIX = "schmockShared";

function forEachSubschema(
  node: Record<string, unknown>,
  visit: (child: Record<string, unknown>) => void,
): void {
  for (const keyword of SUBSCHEMA_KEYWORDS) {
    const value = node[keyword];
    if (isRecord(value)) visit(value);
  }
  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    const value = node[keyword];
    if (!Array.isArray(value)) continue;
    for (const child of value) if (isRecord(child)) visit(child);
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const value = node[keyword];
    if (!isRecord(value)) continue;
    for (const child of Object.values(value)) if (isRecord(child)) visit(child);
  }
}

/** A shallow copy of `node` with every subschema replaced by `replace`'s result. */
function mapSubschemas(
  node: Record<string, unknown>,
  replace: (child: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  // Spread and fromEntries define keys, so a property named `__proto__`
  // stays a property instead of setting the copy's prototype.
  const copy: Record<string, unknown> = { ...node };
  for (const keyword of IDENTITY_KEYWORDS) delete copy[keyword];
  for (const keyword of SUBSCHEMA_KEYWORDS) {
    const value = node[keyword];
    if (isRecord(value)) copy[keyword] = replace(value);
  }
  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    const value = node[keyword];
    if (!Array.isArray(value)) continue;
    copy[keyword] = value.map((child: unknown) =>
      isRecord(child) ? replace(child) : child,
    );
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const value = node[keyword];
    if (!isRecord(value)) continue;
    copy[keyword] = Object.fromEntries(
      Object.entries(value).map(([name, child]) => [
        name,
        isRecord(child) ? replace(child) : child,
      ]),
    );
  }
  return copy;
}

/**
 * `schema` with every subschema it reaches more than once moved under `$defs`
 * and referenced from each place it occurred. The input is not modified.
 *
 * The parser dereferences a spec into a graph where every use of a component
 * is the same object and no `$ref` is left. AJV compiles a schema as a tree,
 * so it inlined a shared object once per path to it: Stripe's error schema
 * holds about 9,000 objects but expands to three million nodes, and its first
 * compile took about a minute and tens of gigabytes, or ran out of memory.
 * Referenced from `$defs`, each shared subschema is compiled once, and a cycle
 * (left in keywords the normalizer does not walk) becomes a recursive `$ref`
 * instead of an endless descent.
 *
 * Identity keywords such as `$id` are dropped from the copy. With no reference
 * left they name nothing, while a nested `$id` would re-base the `$ref`s placed
 * under it, and AJV refuses one `$id` reached by two paths. A schema that still
 * holds a reference is returned as it is: its pointers were written against
 * the original layout.
 */
export function shareRepeatedSubschemas(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const uses = new Map<Record<string, unknown>, number>();
  let shared = false;
  let named = false;
  let referenced = false;
  const count = (node: Record<string, unknown>): void => {
    const seen = uses.get(node);
    uses.set(node, (seen ?? 0) + 1);
    if (seen !== undefined) {
      shared = true;
      return;
    }
    if (REFERENCE_KEYWORDS.some((keyword) => keyword in node)) {
      referenced = true;
    }
    if (IDENTITY_KEYWORDS.some((keyword) => keyword in node)) named = true;
    forEachSubschema(node, count);
  };
  count(schema);
  if (referenced || (!shared && !named)) return schema;

  const reserved = new Set(
    isRecord(schema.$defs) ? Object.keys(schema.$defs) : [],
  );
  const names = new Map<Record<string, unknown>, string>();
  const definitions: Record<string, unknown> = {};
  let nextIndex = 0;
  const freshName = (): string => {
    let name = `${SHARED_DEF_PREFIX}${nextIndex++}`;
    while (reserved.has(name)) name = `${SHARED_DEF_PREFIX}${nextIndex++}`;
    return name;
  };
  const reference = (
    node: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (node === schema) return { $ref: "#" };
    if ((uses.get(node) ?? 0) < 2) return mapSubschemas(node, reference);
    let name = names.get(node);
    if (name === undefined) {
      name = freshName();
      // Named before the copy is built, so a cycle back to this node finds
      // the reference instead of copying it again.
      names.set(node, name);
      definitions[name] = mapSubschemas(node, reference);
    }
    return { $ref: `#/$defs/${name}` };
  };

  const root = mapSubschemas(schema, reference);
  if (names.size === 0) return root;
  return {
    ...root,
    $defs: { ...(isRecord(root.$defs) ? root.$defs : {}), ...definitions },
  };
}

/**
 * Validate request body against the schema declared for its media type.
 *
 * Returns 415 for a media type the operation does not declare, 400 when the
 * body does not satisfy the selected schema, or undefined to continue.
 *
 * 415 lives here, and therefore behind `options.validateRequests`, on purpose:
 * emitting it unconditionally would change status codes for every existing
 * caller who never opted into request validation.
 */
export function validateRequestBody(
  context: Schmock.PluginContext,
  validatorCtx: BodyValidatorContext,
): Schmock.PluginResult | undefined {
  const requestBodyRequired = isRouteRequestBodyRequired(context.route);

  if (context.body === undefined) {
    if (requestBodyRequired) {
      return requestValidationError(context, [
        {
          path: "/",
          message: "request body is required",
          keyword: "required",
        },
      ]);
    }
    return undefined;
  }

  let requestBodySchema = getRouteRequestBody(context.route);
  const content = getRouteRequestContent(context.route);
  const rawContentType = getHeader(context.headers, "content-type");
  if (content && content.size > 0) {
    // No declared type from the client is not a violation — fall back to the
    // JSON-ish default contract rather than rejecting.
    if (rawContentType) {
      const selected = selectRequestMediaType(
        content,
        normalizeMediaType(rawContentType),
      );
      if (!selected) {
        return unsupportedMediaTypeError(context, [...content.keys()]);
      }
      requestBodySchema = content.get(selected);
    }
  }

  // Form bodies are validated as the record the schema describes rather than
  // the FormData or string record core decoded, and that record is kept for
  // the CRUD generators to read through readRequestBody().
  const body = normalizeRequestBody(
    context.body,
    rawContentType,
    requestBodySchema,
  );
  context.state.set(NORMALIZED_BODY_STATE_KEY, body);

  if (!requestBodySchema) {
    return undefined;
  }

  // `type: string, format: binary` is OpenAPI's raw upload. Every transport
  // (fetch interceptor, mock.listen(), the CLI) delivers such a body as bytes,
  // which AJV would reject as "must be string".
  if (
    isBinaryPayload(context.body) &&
    isBinaryStringSchema(requestBodySchema)
  ) {
    return undefined;
  }

  // XML, CSV and other media types core does not parse arrive as the text or
  // bytes that were sent, which no object schema can describe: the media type
  // was already checked above. Text is still checked against a schema that
  // can take a string: one with a string branch, or one that declares no type.
  if (
    rawContentType &&
    isUndecodedBody(context.body, normalizeMediaType(rawContentType)) &&
    (typeof context.body !== "string" ||
      !(
        admitsType(requestBodySchema, "string") || isUntyped(requestBodySchema)
      ))
  ) {
    return undefined;
  }

  let validate: ValidateFunction;
  try {
    validate = getValidator(validatorCtx, requestBodySchema);
  } catch (error) {
    return requestValidationError(context, [
      {
        path: "/",
        message:
          error instanceof Error
            ? `request schema could not be compiled: ${error.message}`
            : "request schema could not be compiled",
        keyword: "schema",
      },
    ]);
  }
  // A form body is checked with its file parts read as strings (see
  // `toValidationInstance`); any other body is checked exactly as received.
  const instance = body === context.body ? body : toValidationInstance(body);
  if (!validate(instance)) {
    const errors =
      validate.errors?.map((e) => ({
        path: e.instancePath || "/",
        message: e.message ?? "validation failed",
        keyword: e.keyword,
      })) ?? [];

    return requestValidationError(context, errors);
  }

  return undefined;
}

interface ValidationDetail {
  path: string;
  message: string;
  keyword: string;
}

function requestValidationError(
  context: Schmock.PluginContext,
  details: ValidationDetail[],
): Schmock.PluginResult {
  return {
    context,
    response: [
      400,
      {
        error: "Request validation failed",
        code: "VALIDATION_ERROR",
        details,
      },
    ],
  };
}

/**
 * Core's `getResponseParts`, with a plain `null` result read as no body.
 *
 * Core carries the element as given (`null` stays `null`). This module has
 * always validated and re-wrapped a plain `null` as `undefined`, which is also
 * what core puts on the wire for it; a tuple or envelope carrying `null` keeps
 * it, as before.
 */
function responseParts(response: unknown): Schmock.ResponseParts {
  const parts = getResponseParts(response);
  return parts.kind === "plain" && parts.body === null
    ? { ...parts, body: undefined }
    : parts;
}

/**
 * Status a response value will resolve to, whatever shape it carries
 * (tuple, response object, or a plain body defaulting to 200 / 204 for nullish).
 */
export function getResponseStatus(response: unknown): number {
  return responseParts(response).status;
}

interface AppliedResponseContentType {
  response: unknown;
  rejected: boolean;
}

/** Add the media type selected for the actual response status. */
export function applyResponseContentType(
  context: Schmock.PluginContext,
  response: unknown,
): AppliedResponseContentType {
  const responses = getRouteResponses(context.route);
  if (!responses) return { response, rejected: false };

  const parts = responseParts(response);
  const entry = findResponseEntry(responses, parts.status);
  if (!entry) return { response, rejected: false };

  const accept = getHeader(context.headers, "accept");
  const explicitContentType = getHeader(parts.headers, "content-type");
  const availableContentTypes = explicitContentType
    ? [explicitContentType]
    : (entry.contentTypes ?? []);
  if (
    accept &&
    accept !== "*/*" &&
    availableContentTypes.length > 0 &&
    !negotiateContentType(accept, availableContentTypes)
  ) {
    return {
      response: [
        406,
        {
          error: "Not Acceptable",
          code: "NOT_ACCEPTABLE",
          acceptable: availableContentTypes,
        },
      ],
      rejected: true,
    };
  }

  const selected = selectResponseMediaType(
    entry,
    context.headers,
    parts.headers,
  );
  if (!selected || getHeader(parts.headers, "content-type")) {
    return { response, rejected: false };
  }

  const headers = { ...parts.headers, "content-type": selected.mediaType };
  if (parts.kind === "object") {
    return {
      response: { status: parts.status, body: parts.body, headers },
      rejected: false,
    };
  }
  return {
    response: [parts.status, parts.body, headers],
    rejected: false,
  };
}

/** Validate a response against the schema for its actual status and media type. */
export function validateResponse(
  context: Schmock.PluginContext,
  response: unknown,
  validatorCtx: BodyValidatorContext,
): Schmock.PluginResult | undefined {
  const responses = getRouteResponses(context.route);
  if (!responses) return undefined;

  const parts = responseParts(response);
  const entry = findResponseEntry(responses, parts.status);
  if (!entry) {
    return responseValidationError(context, parts.status, undefined, [
      {
        path: "/",
        message: `status ${parts.status} is not declared by the operation`,
        keyword: "status",
      },
    ]);
  }

  const selectedMediaType = selectResponseMediaType(
    entry,
    context.headers,
    parts.headers,
  );
  const mediaType = selectedMediaType?.mediaType;
  let schema = entry.schema;

  if (entry.content && entry.content.size > 0) {
    if (!mediaType) {
      return responseValidationError(context, parts.status, undefined, [
        {
          path: "/",
          message: "response media type could not be determined",
          keyword: "contentType",
        },
      ]);
    }

    const mediaEntry: ParsedResponseContent | undefined =
      selectedMediaType.declared
        ? entry.content.get(selectedMediaType.declared)
        : undefined;
    if (!mediaEntry) {
      return responseValidationError(context, parts.status, mediaType, [
        {
          path: "/",
          message: `media type ${mediaType} is not declared for status ${parts.status}`,
          keyword: "contentType",
        },
      ]);
    }
    schema = mediaEntry.schema;
  }

  if (!schema) return undefined;

  let validate: ValidateFunction;
  try {
    validate = getValidator(validatorCtx, schema);
  } catch (error) {
    return responseValidationError(context, parts.status, mediaType, [
      {
        path: "/",
        message:
          error instanceof Error
            ? `response schema could not be compiled: ${error.message}`
            : "response schema could not be compiled",
        keyword: "schema",
      },
    ]);
  }

  if (validate(parts.body)) return undefined;

  const details =
    validate.errors?.map((error) => ({
      path: error.instancePath || "/",
      message: error.message ?? "validation failed",
      keyword: error.keyword,
    })) ?? [];
  return responseValidationError(context, parts.status, mediaType, details);
}

function responseValidationError(
  context: Schmock.PluginContext,
  status: number,
  mediaType: string | undefined,
  details: ValidationDetail[],
): Schmock.PluginResult {
  return {
    context,
    response: [
      500,
      {
        error: "Response validation failed",
        code: "RESPONSE_VALIDATION_ERROR",
        status,
        // Omitted rather than undefined: core refuses a body holding an
        // undefined value and would answer INVALID_RESPONSE in place of this
        // error. An undeclared status, and every Swagger 2.0 response without
        // `produces`, has no media type.
        ...(mediaType === undefined ? {} : { mediaType }),
        details,
      },
    ],
  };
}

/**
 * What `processPreferHeader` produced. `applied` is true when a Prefer
 * directive replaced the generator's response, so the caller can treat the
 * request as a simulation (see `settlePendingMutations` in plugin.ts).
 */
export interface PreferResult extends Schmock.PluginResult {
  applied: boolean;
}

/**
 * Handle Prefer header directives: code=N, example=name, dynamic=true
 */
export async function processPreferHeader(
  context: Schmock.PluginContext,
  response: unknown,
  fakerSeed?: number,
  onSchema?: Schmock.OnSchemaCallback,
): Promise<PreferResult> {
  const unchanged: PreferResult = { context, response, applied: false };
  const preferValue = getHeader(context.headers, "prefer");
  if (!preferValue) {
    return unchanged;
  }

  const prefer = parsePreferHeader(preferValue);
  const responses = getRouteResponses(context.route);

  if (!responses) {
    return unchanged;
  }

  const replaced = (status: number, body: unknown): PreferResult => ({
    context,
    response: [status, body],
    applied: true,
  });

  // Prefer: code=N — return the response for that status code
  if (prefer.code !== undefined) {
    const entry = findResponseEntry(responses, prefer.code);
    if (entry) {
      const schema = selectResponseSchema(context, entry);
      const body = schema
        ? await generateResponseBody({
            schema,
            seed: fakerSeed,
            onSchema,
            context,
          })
        : prefer.code === 204
          ? undefined
          : {};
      return replaced(prefer.code, body);
    }
  }

  // Prefer: example=name — find a named example across responses
  if (prefer.example !== undefined) {
    for (const [code, entry] of responses) {
      const selectedExample = selectResponseExample(
        context,
        entry,
        prefer.example,
      );
      if (typeof code === "number" && selectedExample.found) {
        return replaced(code, selectedExample.value);
      }
    }
  }

  // Prefer: dynamic=true — regenerate from schema
  if (prefer.dynamic) {
    // A CRUD create records the status it answers with; regenerating must not
    // move it (a POST declaring 200 and 201 answers 201, see
    // CREATE_SUCCESS_STATUS_ORDER).
    const createStatus = context.route["openapi:preflightResponseStatus"];
    const success = findSuccessResponse(
      responses,
      typeof createStatus === "number" ? [createStatus] : undefined,
    );
    if (success) {
      const [code, entry] = success;
      const schema = selectResponseSchema(context, entry);
      if (!schema) return replaced(code, code === 204 ? undefined : {});
      const body = await generateResponseBody({
        schema,
        seed: fakerSeed,
        onSchema,
        context,
      });
      return replaced(code, body);
    }
  }

  return unchanged;
}

function selectResponseSchema(
  context: Schmock.PluginContext,
  entry: ParsedResponseEntry,
): JSONSchema7 | undefined {
  const mediaType = selectResponseMediaType(entry, context.headers, {});
  if (entry.content && entry.content.size > 0) {
    return mediaType?.declared
      ? entry.content.get(mediaType.declared)?.schema
      : undefined;
  }

  return entry.schema;
}

type SelectedResponseExample =
  | { found: true; value: unknown }
  | { found: false };

function selectResponseExample(
  context: Schmock.PluginContext,
  entry: ParsedResponseEntry,
  name: string,
): SelectedResponseExample {
  if (entry.content && entry.content.size > 0) {
    const mediaType = selectResponseMediaType(entry, context.headers, {});
    const examples = mediaType?.declared
      ? entry.content.get(mediaType.declared)?.examples
      : undefined;
    return examples?.has(name)
      ? { found: true, value: examples.get(name) }
      : { found: false };
  }

  return entry.examples?.has(name)
    ? { found: true, value: entry.examples.get(name) }
    : { found: false };
}

interface ResponseBodyGeneration {
  schema: JSONSchema7;
  seed?: number;
  onSchema?: Schmock.OnSchemaCallback;
  context: Schmock.PluginContext;
}

async function generateResponseBody({
  schema,
  seed,
  onSchema,
  context,
}: ResponseBodyGeneration): Promise<unknown> {
  let finalSchema = schema;
  if (onSchema) {
    // The same five-field context, with the same template path, that the
    // static and CRUD generators hand the hook: one operation must not show
    // `/pets/:id` on a plain request and `/pets/5` under Prefer.
    const templatePath = context.route["openapi:path"];
    const patched = onSchema(finalSchema, {
      method: context.method,
      path: typeof templatePath === "string" ? templatePath : context.path,
      params: context.params,
      query: context.query,
      headers: context.headers,
    });
    if (patched) finalSchema = patched;
  }
  try {
    return await generateFromSchema({ schema: finalSchema, seed });
  } catch (error) {
    // Same rule as the static generator: a failed generation is an error, not
    // an empty success body. This runs inside `plugin.process()`, so core wraps
    // it as a `PluginError` and the wire shape is
    // `500 {error: 'Plugin "@schmock/openapi" failed: Schema generation failed
    // for route GET /x: …', code: "PLUGIN_ERROR"}` rather than
    // `SCHEMA_GENERATION_ERROR`. That asymmetry is accepted: unifying the code
    // needs either an `onError` hook or a raw `[500, …]` tuple, and both change
    // unrelated pipeline behaviour.
    throw asSchemaGenerationError(
      error,
      `${context.method} ${context.path}`,
      finalSchema,
    );
  }
}
