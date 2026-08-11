import SwaggerParser from "@apidevtools/swagger-parser";
import type * as Schmock from "@schmock/core";
import { SchmockError, toHttpMethod } from "@schmock/core";
import type { JSONSchema7 } from "json-schema";
import type { OpenAPI } from "openapi-types";
import { normalizeSchema } from "./normalizer.js";
import {
  buildRefParserOptions,
  checkRef,
  collectUnresolvedRefs,
  type RefPolicy,
  resolveRefPolicy,
} from "./ref-policy.js";
import {
  parseResponseStatusKey,
  type ResponseStatusKey,
} from "./response-status.js";
import { isRecord, normalizeMediaType } from "./utils.js";

export interface SecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  /** For apiKey: header, query, or cookie */
  in?: "header" | "query" | "cookie";
  /** For apiKey: the header/query/cookie name */
  name?: string;
  /** For http: bearer, basic, etc. */
  scheme?: string;
}

export interface ParsedSpec {
  title: string;
  version: string;
  paths: ParsedPath[];
  securitySchemes?: Map<string, SecurityScheme>;
  globalSecurity?: string[][];
  /**
   * Everything the parser skipped rather than failed on, one line each.
   *
   * Always collected, never fatal: `strict` decides whether the document is
   * validated up-front, this decides whether the caller can find out what was
   * dropped along the way. Surfaced by the plugin under `debug: true`.
   */
  warnings: string[];
}

export interface ParsedResponseEntry {
  schema?: JSONSchema7;
  description: string;
  headers?: Record<string, Schmock.ResponseHeaderDef>;
  examples?: Map<string, unknown>;
  contentTypes?: string[];
  /** Response schemas and examples keyed by their declared media type. */
  content?: Map<string, ParsedResponseContent>;
}

export interface ParsedResponseContent {
  schema?: JSONSchema7;
  examples?: Map<string, unknown>;
}

export interface ParsedCallback {
  /** Runtime expression for the callback URL (e.g. "{$request.body#/callbackUrl}") */
  urlExpression: string;
  /** HTTP method for the callback request */
  method: Schmock.HttpMethod;
  /** JSON Schema for the callback request body */
  requestBody?: JSONSchema7;
}

export interface ParsedPath {
  /** Express-style path e.g. "/pets/:petId" */
  path: string;
  method: Schmock.HttpMethod;
  operationId?: string;
  parameters: ParsedParameter[];
  /**
   * The JSON-ish request schema, kept as the default contract and as the
   * fallback used when a request carries no `Content-Type`.
   */
  requestBody?: JSONSchema7;
  requestBodyRequired: boolean;
  /**
   * Request schemas keyed by normalized media type. A media type declared
   * without a schema maps to `undefined`: accepted, but not validated.
   */
  requestContent?: Map<string, JSONSchema7 | undefined>;
  responses: Map<ResponseStatusKey, ParsedResponseEntry>;
  tags: string[];
  /** Per-operation security requirements (each entry is OR, keys within are AND) */
  security?: string[][];
  /** OAS3 callbacks defined on this operation */
  callbacks?: ParsedCallback[];
}

interface ParsedParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema?: JSONSchema7;
}

const HTTP_METHOD_KEYS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
]);

/** Path-item keys that are legitimately not operations. */
const NON_METHOD_PATH_ITEM_KEYS = new Set([
  "parameters",
  "summary",
  "description",
  "servers",
  "$ref",
  "trace",
]);

type SchemaDirection = "request" | "response";
type SchemaNormalizer = (
  schema: Record<string, unknown>,
  direction: SchemaDirection,
) => JSONSchema7;

function createSchemaNormalizer(): SchemaNormalizer {
  // Dereferenced component refs share identity. Reusing their normalized form
  // avoids cloning large schema graphs once per operation and media type.
  const requestSchemas = new WeakMap<object, JSONSchema7>();
  const responseSchemas = new WeakMap<object, JSONSchema7>();

  return (schema, direction) => {
    const schemas = direction === "request" ? requestSchemas : responseSchemas;
    const cached = schemas.get(schema);
    if (cached) return cached;

    const normalized = normalizeSchema(schema, direction);
    schemas.set(schema, normalized);
    return normalized;
  };
}

function isExtensionKey(key: string): boolean {
  return key.startsWith("x-");
}

function isOpenApiDocument(value: unknown): value is OpenAPI.Document {
  return isRecord(value) && ("swagger" in value || "openapi" in value);
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((v): v is string => typeof v === "string");
  return entries.length > 0 ? entries : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Strip root-level x-* extensions from a spec object.
 * These may contain $ref to external docs (e.g. markdown files)
 * that swagger-parser cannot resolve.
 */
function stripRootExtensions(spec: object): void {
  for (const key of Object.keys(spec)) {
    if (key.startsWith("x-")) {
      Reflect.deleteProperty(spec, key);
    }
  }
}

/**
 * Ensure a paths key exists on a spec object (required by swagger-parser validation).
 */
function ensurePathsKey(spec: object): void {
  if (!("paths" in spec)) {
    Object.assign(spec, { paths: {} });
  }
}

export interface ParseSpecOptions {
  /**
   * Validate the document against the OpenAPI schema and specification at load
   * time. Default `false`: incomplete specs are deliberately tolerated.
   */
  strict?: boolean;
  /** External `$ref` resolution policy. External refs are off by default. */
  refs?: RefPolicy;
}

/**
 * Load, resolve and (optionally) validate a spec into a real document.
 *
 * Two things changed here relative to the naive two-call form and both matter:
 * the parse and the dereference run on ONE parser instance with the source URI
 * retained, so a relative external `$ref` resolves against the spec's own
 * directory rather than `process.cwd()`; and every `$ref` leaving the root
 * document is ruled on by policy BEFORE resolution starts, so a blocked ref is
 * reported as a policy decision and no file is opened and no request is sent.
 */
async function loadDocument(
  source: string | object,
  options: ParseSpecOptions,
): Promise<OpenAPI.Document> {
  const policy = resolveRefPolicy(options.refs);
  // Per call, never module-scoped: parallel `openapi()` calls under
  // `Promise.all` would otherwise read each other's diagnostics.
  const refDiagnostics = new Map<string, string>();
  const refOptions = buildRefParserOptions(options.refs, refDiagnostics);
  const strict = options.strict === true;
  const derefOptions = {
    ...refOptions,
    validate: { schema: strict, spec: strict },
  };
  const parser = new SwaggerParser();

  let raw: OpenAPI.Document;
  let baseUrl: string | undefined;
  if (typeof source === "string") {
    // Read the root document only — `parse` resolves nothing, which is what
    // lets the policy rule on its refs before any of them are followed.
    raw = await parser.parse(source, refOptions);
    baseUrl = source;
  } else if (isOpenApiDocument(source)) {
    raw = structuredClone(source);
  } else {
    throw new Error(
      "Invalid OpenAPI spec: must be a string path or an OpenAPI document object",
    );
  }

  // Order matters: root `x-*` extensions are stripped precisely because they
  // may carry `$ref`s to things that are not schemas (markdown, changelogs).
  // Scanning before the strip would reject specs that parse fine today.
  stripRootExtensions(raw);
  ensurePathsKey(raw);

  const blocked: string[] = [];
  for (const ref of collectUnresolvedRefs(raw)) {
    const verdict = checkRef(ref, policy);
    if (!verdict.allowed) blocked.push(`${ref} (${verdict.reason})`);
  }
  if (blocked.length > 0) throw externalRefBlocked(blocked, source);

  // MUST run before dereference: it is the last moment a `oneOf` branch is
  // still a `$ref` string and can be paired with its `mapping` entry.
  markDiscriminatorValues(raw);

  const api = await dereferenceDocument(
    parser,
    baseUrl,
    raw,
    derefOptions,
    strict,
    source,
    refDiagnostics,
  );
  markDereferencedDiscriminatorValues(api, parser.$refs.values());

  // Defence in depth for refs reached through a nested document: only
  // reachable once external resolution is on, and skipping the walk otherwise
  // keeps multi-megabyte specs off a second full traversal.
  if (policy.external) {
    const residual = collectUnresolvedRefs(api);
    if (residual.length > 0) throw externalRefBlocked(residual, source);
  }

  return api;
}

/**
 * Resolve each `oneOf` reference to its explicit discriminator mapping key or
 * implicit component name, then record the answers index-aligned.
 *
 * Why a marker rather than resolving in the normalizer: dereference replaces
 * every `$ref` branch with the component object, at which point NOTHING on the
 * branch says which mapping key pointed at it — the old code guessed by
 * position, so a mapping declared in a different order than the branches
 * stamped every branch with the wrong discriminator value. Object identity
 * cannot rescue it either, because `normalizeSchema` `structuredClone`s its
 * input before walking it.
 *
 * The `x-` prefix keeps the marker inside OAS's own extension namespace, which
 * is the only key space a document may legally carry — verified to survive
 * `strict: true` validation, which is what the marker has to clear. It is NOT
 * stripped before it can be read: `normalizeNode` strips `x-*` keys per node,
 * and this one lives one level down, inside `discriminator`; it then leaves with
 * the whole `discriminator` object.
 */
const DISCRIMINATOR_VALUES_MARKER = "x-schmock-discriminator-values";

/**
 * The mapping keys naming `ref`, in declaration order.
 *
 * Both spellings OAS allows are accepted: a full pointer
 * (`#/components/schemas/Dog`) and the bare component name (`Dog`).
 */
function mappingKeysForRef(
  mapping: Record<string, unknown>,
  ref: string,
): string[] {
  const keys: string[] = [];
  const bareName = schemaNameForRef(ref);
  for (const [key, value] of Object.entries(mapping)) {
    if (typeof value !== "string") continue;
    if (value === ref || (bareName !== null && value === bareName)) {
      keys.push(key);
    }
  }
  return keys;
}

function schemaNameForRef(ref: string): string | null {
  const hash = ref.indexOf("#");
  if (hash === -1) return null;
  const pointer = ref.slice(hash + 1);
  if (!pointer.startsWith("/")) return null;
  const encoded = pointer.slice(pointer.lastIndexOf("/") + 1);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
  } catch {
    return null;
  }
}

function markDiscriminatorValues(root: unknown): void {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== "object" || node === null) continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (!isRecord(node)) continue;

    const disc = node.discriminator;
    if (isRecord(disc) && Array.isArray(node.oneOf)) {
      const mapping = isRecord(disc.mapping) ? disc.mapping : {};
      const values = node.oneOf.map((branch) =>
        discriminatorValuesForBranch(mapping, branch),
      );
      if (values.some((value) => value !== null)) {
        disc[DISCRIMINATOR_VALUES_MARKER] = values;
      }
    }

    for (const child of Object.values(node)) stack.push(child);
  }
}

function discriminatorValuesForBranch(
  mapping: Record<string, unknown>,
  branch: unknown,
): string[] | null {
  if (!isRecord(branch) || typeof branch.$ref !== "string") return null;
  const explicit = mappingKeysForRef(mapping, branch.$ref);
  if (explicit.length > 0) return explicit;
  const implicit = schemaNameForRef(branch.$ref);
  return implicit ? [implicit] : null;
}

interface SchemaIdentity {
  documentUri: string;
  pointer: string;
  name?: string;
}

function canonicalDocumentUri(uri: string): string {
  const normalized = uri.replaceAll("\\", "/");
  try {
    if (/^[A-Za-z]:\//.test(normalized)) {
      return new URL(`file:///${normalized}`).href;
    }
    if (normalized.startsWith("/")) {
      return new URL(`file://${normalized}`).href;
    }
    return new URL(normalized).href;
  } catch {
    return normalized;
  }
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function identityRef(identity: SchemaIdentity): string {
  return `${identity.documentUri}#${identity.pointer}`;
}

function addSchemaIdentity(
  identities: WeakMap<object, SchemaIdentity[]>,
  schema: unknown,
  identity: SchemaIdentity,
): void {
  if (!isRecord(schema)) return;
  const existing = identities.get(schema);
  if (existing) {
    if (
      !existing.some(
        (candidate) => identityRef(candidate) === identityRef(identity),
      )
    ) {
      existing.push(identity);
    }
  } else {
    identities.set(schema, [identity]);
  }
}

function addSchemaContainer(
  identities: WeakMap<object, SchemaIdentity[]>,
  container: unknown,
  documentUri: string,
  pointer: string,
): void {
  if (!isRecord(container)) return;
  for (const [name, schema] of Object.entries(container)) {
    addSchemaIdentity(identities, schema, {
      documentUri,
      pointer: `${pointer}/${escapePointerSegment(name)}`,
      name,
    });
  }
}

function collectNamedSchemas(
  identities: WeakMap<object, SchemaIdentity[]>,
  uri: string,
  document: unknown,
): void {
  if (!isRecord(document)) return;
  const documentUri = canonicalDocumentUri(uri);
  addSchemaIdentity(identities, document, { documentUri, pointer: "" });
  if (isRecord(document.components)) {
    addSchemaContainer(
      identities,
      document.components.schemas,
      documentUri,
      "/components/schemas",
    );
  }
  addSchemaContainer(
    identities,
    document.definitions,
    documentUri,
    "/definitions",
  );
  addSchemaContainer(identities, document.$defs, documentUri, "/$defs");

  if (!("openapi" in document) && !("swagger" in document)) {
    addSchemaContainer(identities, document, documentUri, "");
  }
}

function isBareMappingTarget(target: string): boolean {
  return !/[#/:\\]/.test(target) && !target.startsWith(".");
}

function mappingTargetRef(target: string, documentUri: string): string | null {
  const hash = target.indexOf("#");
  const path = hash === -1 ? target : target.slice(0, hash);
  const rawPointer = hash === -1 ? "" : target.slice(hash + 1);
  let pointer = rawPointer;
  try {
    pointer = decodeURIComponent(rawPointer);
  } catch {
    // Keep the literal fragment: malformed encoding cannot match a real pointer.
  }

  try {
    const resolvedDocument = path
      ? new URL(path, documentUri).href
      : documentUri;
    return `${resolvedDocument}#${pointer}`;
  } catch {
    return null;
  }
}

function mappingTargetsBranch(
  target: unknown,
  ownerIdentities: SchemaIdentity[],
  branchIdentities: SchemaIdentity[],
): boolean {
  if (typeof target !== "string") return false;
  const ownerDocuments = new Set(
    ownerIdentities.map((identity) => identity.documentUri),
  );
  if (isBareMappingTarget(target)) {
    return branchIdentities.some(
      (identity) =>
        identity.name === target && ownerDocuments.has(identity.documentUri),
    );
  }

  const targets = new Set<string>();
  for (const documentUri of ownerDocuments) {
    const resolved = mappingTargetRef(target, documentUri);
    if (resolved) targets.add(resolved);
  }
  return branchIdentities.some((identity) =>
    targets.has(identityRef(identity)),
  );
}

function valuesForDereferencedBranch(
  mapping: Record<string, unknown>,
  owner: Record<string, unknown>,
  branch: unknown,
  identities: WeakMap<object, SchemaIdentity[]>,
): string[] | null {
  if (!isRecord(branch)) return null;
  const branchIdentities = identities.get(branch) ?? [];
  if (branchIdentities.length === 0) return null;
  const ownerIdentities = identities.get(owner) ?? [];

  const explicit = Object.entries(mapping)
    .filter(([, target]) =>
      mappingTargetsBranch(target, ownerIdentities, branchIdentities),
    )
    .map(([key]) => key);
  if (explicit.length > 0) return explicit;
  const implicit = branchIdentities.find((identity) => identity.name)?.name;
  return implicit ? [implicit] : null;
}

/** Fill markers on discriminator schemas that originated in external documents. */
function markDereferencedDiscriminatorValues(
  root: unknown,
  resolvedValues: unknown,
): void {
  const identities = new WeakMap<object, SchemaIdentity[]>();
  if (isRecord(resolvedValues)) {
    for (const [uri, document] of Object.entries(resolvedValues)) {
      collectNamedSchemas(identities, uri, document);
    }
  }

  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (!isRecord(node)) continue;

    const disc = node.discriminator;
    if (isRecord(disc) && Array.isArray(node.oneOf)) {
      const existingRaw = disc[DISCRIMINATOR_VALUES_MARKER];
      const existing = Array.isArray(existingRaw) ? existingRaw : [];
      const mapping = isRecord(disc.mapping) ? disc.mapping : {};
      const values = node.oneOf.map((branch, index) => {
        const marked = existing[index];
        return Array.isArray(marked) && marked.length > 0
          ? marked
          : valuesForDereferencedBranch(mapping, node, branch, identities);
      });
      if (values.some((value) => value !== null)) {
        disc[DISCRIMINATOR_VALUES_MARKER] = values;
      }
    }

    for (const child of Object.values(node)) stack.push(child);
  }
}

async function dereferenceDocument(
  parser: SwaggerParser,
  baseUrl: string | undefined,
  raw: OpenAPI.Document,
  derefOptions: SwaggerParser.Options,
  strict: boolean,
  source: string | object,
  diagnostics: Map<string, string>,
): Promise<OpenAPI.Document> {
  // Ref-free object sources keep their fast path: no resolver, no clone, no
  // validator. `browser-compat.test.ts` pins it.
  const hasRefs =
    baseUrl !== undefined || JSON.stringify(raw).includes('"$ref"');
  if (!hasRefs && !strict) return raw;

  try {
    // `validate()` dereferences first and only then runs the validators, which
    // are disabled unless strict. The 3-argument form is what retains the
    // source URI.
    const validated =
      baseUrl !== undefined
        ? await parser.validate(baseUrl, raw, derefOptions)
        : await parser.validate(raw, derefOptions);
    return validated as OpenAPI.Document;
  } catch (rawError) {
    // BOTH branches, not just the SchmockError one: `strict` is off by default,
    // so the non-strict rethrow is the path a real consumer hits.
    const error = enrichResolverError(rawError, diagnostics);
    if (!strict) throw error;
    throw new SchmockError(
      `OpenAPI spec failed validation: ${error instanceof Error ? error.message : String(error)}`,
      "OPENAPI_INVALID_SPEC",
      { spec: typeof source === "string" ? source : undefined },
    );
  }
}

/**
 * Put the resolver's own message back on a ref-parser `ResolverError`.
 *
 * ref-parser wraps a resolver throw as `{ plugin, error }` — an object with no
 * `message` — and `ResolverError` then falls back to
 * `Error reading file "<url>"`. The size, timeout and status detail the ref
 * policy produced is gone by the time it reaches us, so `readHttpRef` records
 * each message in `diagnostics` on its way out and it is re-attached here.
 *
 * Matching is by the error's `source` first, then by any recorded url appearing
 * in its message; anything else is returned untouched.
 */
export function enrichResolverError(
  error: unknown,
  diagnostics: Map<string, string>,
): unknown {
  if (diagnostics.size === 0 || !(error instanceof Error)) return error;
  const carrier = error as Error & { code?: unknown; source?: unknown };
  if (carrier.code !== "ERESOLVER") return error;

  let detail: string | undefined;
  if (typeof carrier.source === "string") {
    detail = diagnostics.get(carrier.source);
  }
  if (detail === undefined) {
    for (const [url, message] of diagnostics) {
      if (error.message.includes(url)) {
        detail = message;
        break;
      }
    }
  }
  if (detail === undefined) return error;

  error.message = `${error.message}: ${detail}`;
  return error;
}

function externalRefBlocked(
  refs: string[],
  source: string | object,
): SchmockError {
  const shown = refs.slice(0, 5).join(", ");
  const more = refs.length > 5 ? `, and ${refs.length - 5} more` : "";
  return new SchmockError(
    `OpenAPI spec contains ${refs.length} external $ref(s) that were not resolved: ${shown}${more}. ` +
      "Enable them with refs: { external: true } (and refs: { allowHttp: true } for http(s) refs).",
    "OPENAPI_EXTERNAL_REF_BLOCKED",
    { refs, spec: typeof source === "string" ? source : undefined },
  );
}

/**
 * Parse an OpenAPI/Swagger spec into a normalized internal model.
 * Supports Swagger 2.0, OpenAPI 3.0, and 3.1.
 */
export async function parseSpec(
  source: string | object,
  options: ParseSpecOptions = {},
): Promise<ParsedSpec> {
  const api = await loadDocument(source, options);
  const warnings: string[] = [];
  const normalizeParsedSchema = createSchemaNormalizer();

  const isSwagger2 = "swagger" in api && typeof api.swagger === "string";
  const title = api.info?.title ?? "Untitled";
  const version = api.info?.version ?? "0.0.0";

  // Swagger 2.0 `basePath` and OAS3 `servers[].url` pathnames are intentionally
  // ignored: routes register at the spec's own path templates. Mount the mock
  // under a prefix with the adapter's `baseUrl` option instead.

  const rootDocument: Record<string, unknown> = isRecord(api) ? api : {};
  const rootConsumes = isSwagger2
    ? getStringArray(rootDocument.consumes)
    : undefined;
  const rootProduces = isSwagger2
    ? getStringArray(rootDocument.produces)
    : undefined;

  // Extract security schemes
  const securitySchemes = extractSecuritySchemes(api, isSwagger2);
  const globalSecurityRaw = "security" in api ? api.security : undefined;
  const globalSecurity = extractSecurityRequirements(
    Array.isArray(globalSecurityRaw) ? globalSecurityRaw : undefined,
  );

  const paths: ParsedPath[] = [];
  const rawPaths =
    "paths" in api && isRecord(api.paths) ? api.paths : undefined;

  if (!rawPaths) {
    return { title, version, paths, securitySchemes, globalSecurity, warnings };
  }

  for (const [pathTemplate, pathItemRaw] of Object.entries(rawPaths)) {
    if (!isRecord(pathItemRaw)) {
      warnings.push(`path ${pathTemplate}: not an object, skipped`);
      continue;
    }
    const pathItem = pathItemRaw;

    // Extract path-level parameters
    const pathLevelParams = extractParameters(
      Array.isArray(pathItem.parameters) ? pathItem.parameters : undefined,
      isSwagger2,
      normalizeParsedSchema,
      warnings,
      `path ${pathTemplate}`,
    );

    for (const methodKey of Object.keys(pathItem)) {
      if (!HTTP_METHOD_KEYS.has(methodKey)) {
        if (
          !NON_METHOD_PATH_ITEM_KEYS.has(methodKey) &&
          !isExtensionKey(methodKey)
        ) {
          warnings.push(
            `path ${pathTemplate}: "${methodKey}" is not an HTTP method, skipped`,
          );
        }
        continue;
      }

      const operation = pathItem[methodKey];
      const label = `${methodKey.toUpperCase()} ${pathTemplate}`;
      if (!isRecord(operation)) {
        warnings.push(`${label}: operation is not an object, skipped`);
        continue;
      }

      const method = toHttpMethod(methodKey.toUpperCase());

      // Merge path-level + operation-level parameters (operation wins)
      const operationParams = extractParameters(
        Array.isArray(operation.parameters) ? operation.parameters : undefined,
        isSwagger2,
        normalizeParsedSchema,
        warnings,
        label,
      );
      const mergedParams = mergeParameters(pathLevelParams, operationParams);

      // Extract request body
      let requestBody: JSONSchema7 | undefined;
      let requestBodyRequired = false;
      let requestContent: Map<string, JSONSchema7 | undefined> | undefined;
      if (isSwagger2) {
        requestBody = extractSwagger2RequestBody(mergedParams);
        requestBodyRequired =
          mergedParams.find((parameter) => parameter.in === "body")?.required ??
          false;
        requestContent = buildSwagger2RequestContent(
          getStringArray(operation.consumes) ?? rootConsumes,
          requestBody,
        );
      } else {
        const rawRequestBody = isRecord(operation.requestBody)
          ? operation.requestBody
          : undefined;
        requestBody = extractOpenApi3RequestBody(
          rawRequestBody,
          normalizeParsedSchema,
        );
        requestBodyRequired = rawRequestBody
          ? getBoolean(rawRequestBody.required, false)
          : false;
        requestContent = extractOpenApi3RequestContent(
          rawRequestBody,
          normalizeParsedSchema,
        );
      }

      // Extract responses
      const responses = extractResponses(
        isRecord(operation.responses) ? operation.responses : undefined,
        isSwagger2,
        normalizeParsedSchema,
        getStringArray(operation.produces) ?? rootProduces,
        warnings,
        label,
      );

      // Convert path template: {petId} -> :petId
      const expressPath = convertPathTemplate(pathTemplate);

      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((t): t is string => typeof t === "string")
        : [];

      // Extract per-operation security
      const operationSecurity = Array.isArray(operation.security)
        ? extractSecurityRequirements(operation.security)
        : undefined;

      // Extract OAS3 callbacks
      const callbacks =
        !isSwagger2 && isRecord(operation.callbacks)
          ? extractCallbacks(operation.callbacks, normalizeParsedSchema)
          : undefined;

      // Filter out body parameters from the final parameter list (Swagger 2.0)
      const filteredParams = mergedParams.filter(isNotBodyParam);

      paths.push({
        path: expressPath,
        method,
        operationId: getString(operation.operationId),
        parameters: filteredParams,
        requestBody,
        requestBodyRequired,
        requestContent,
        responses,
        tags,
        security: operationSecurity,
        callbacks,
      });
    }
  }

  return { title, version, paths, securitySchemes, globalSecurity, warnings };
}

interface InternalParameter {
  name: string;
  in: "path" | "query" | "header" | "body";
  required: boolean;
  schema?: JSONSchema7;
}

function isValidParamLocation(
  location: string,
  isSwagger2: boolean,
): location is "path" | "query" | "header" | "body" {
  const validLocations = isSwagger2
    ? ["path", "query", "header", "body"]
    : ["path", "query", "header"];
  return validLocations.includes(location);
}

function isNotBodyParam(param: InternalParameter): param is ParsedParameter {
  return param.in !== "body";
}

function extractParameters(
  params: unknown[] | undefined,
  isSwagger2: boolean,
  normalizeParsedSchema: SchemaNormalizer,
  warnings?: string[],
  label?: string,
): InternalParameter[] {
  if (!params || !Array.isArray(params)) return [];

  return params
    .filter((p): p is Record<string, unknown> => isRecord(p))
    .map((p): InternalParameter | null => {
      const location = getString(p.in);
      if (!location || !isValidParamLocation(location, isSwagger2)) {
        warnings?.push(
          `${label}: parameter "${getString(p.name) ?? "?"}" has unsupported location "${location ?? "(none)"}", skipped`,
        );
        return null;
      }

      let schema: JSONSchema7 | undefined;
      if (isSwagger2) {
        // Swagger 2.0: schema is inline on the parameter (type, format, etc.)
        if (location === "body") {
          schema = isRecord(p.schema)
            ? normalizeParsedSchema(p.schema, "request")
            : undefined;
        } else {
          schema = p.type
            ? normalizeParsedSchema(
                { type: p.type, format: p.format, enum: p.enum },
                "request",
              )
            : undefined;
        }
      } else {
        // OpenAPI 3.x: schema is nested
        schema = isRecord(p.schema)
          ? normalizeParsedSchema(p.schema, "request")
          : undefined;
      }

      const name = getString(p.name);
      if (!name) {
        warnings?.push(`${label}: parameter without a name, skipped`);
        return null;
      }

      return {
        name,
        in: location,
        required: getBoolean(p.required, false),
        schema,
      };
    })
    .filter((p): p is InternalParameter => p !== null);
}

function mergeParameters(
  pathLevel: InternalParameter[],
  operationLevel: InternalParameter[],
): InternalParameter[] {
  const merged = new Map<string, InternalParameter>();

  // Path-level first
  for (const p of pathLevel) {
    merged.set(`${p.in}:${p.name}`, p);
  }
  // Operation-level overwrites
  for (const p of operationLevel) {
    merged.set(`${p.in}:${p.name}`, p);
  }

  return [...merged.values()];
}

function extractSwagger2RequestBody(
  params: InternalParameter[],
): JSONSchema7 | undefined {
  const bodyParam = params.find((p) => p.in === "body");
  return bodyParam?.schema;
}

function extractOpenApi3RequestBody(
  requestBody: Record<string, unknown> | undefined,
  normalizeParsedSchema: SchemaNormalizer,
): JSONSchema7 | undefined {
  if (!requestBody) return undefined;

  const content = isRecord(requestBody.content)
    ? requestBody.content
    : undefined;
  if (!content) return undefined;

  const jsonEntry = findJsonContent(content);
  if (!jsonEntry) return undefined;

  const schema = isRecord(jsonEntry.schema) ? jsonEntry.schema : undefined;
  if (!schema) return undefined;

  return normalizeParsedSchema(schema, "request");
}

/**
 * Every declared request media type with its own schema.
 *
 * Distinct from {@link extractOpenApi3RequestBody}, which collapses the whole
 * `content` map to one JSON-ish schema — the reason a JSON+XML operation used
 * to validate an XML body against the JSON contract. Distinct source schemas
 * remain distinct; repeated refs share one normalized identity per direction
 * and compile once in the pipeline's validator cache.
 */
function extractOpenApi3RequestContent(
  requestBody: Record<string, unknown> | undefined,
  normalizeParsedSchema: SchemaNormalizer,
): Map<string, JSONSchema7 | undefined> | undefined {
  const content = isRecord(requestBody?.content)
    ? requestBody.content
    : undefined;
  if (!content) return undefined;

  const result = new Map<string, JSONSchema7 | undefined>();
  for (const [mediaType, entry] of Object.entries(content)) {
    const schema =
      isRecord(entry) && isRecord(entry.schema)
        ? normalizeParsedSchema(entry.schema, "request")
        : undefined;
    result.set(normalizeMediaType(mediaType), schema);
  }

  return result.size > 0 ? result : undefined;
}

/**
 * Swagger 2.0 has one body parameter and a list of media types it may arrive
 * as, so every declared type maps to that same schema. No `consumes` means no
 * declared surface at all: stay lenient and never answer 415.
 */
function buildSwagger2RequestContent(
  consumes: string[] | undefined,
  requestBody: JSONSchema7 | undefined,
): Map<string, JSONSchema7 | undefined> | undefined {
  if (!consumes || consumes.length === 0) return undefined;

  const result = new Map<string, JSONSchema7 | undefined>();
  for (const mediaType of consumes) {
    result.set(normalizeMediaType(mediaType), requestBody);
  }
  return result.size > 0 ? result : undefined;
}

function extractResponses(
  responses: Record<string, unknown> | undefined,
  isSwagger2: boolean,
  normalizeParsedSchema: SchemaNormalizer,
  produces?: string[],
  warnings?: string[],
  label?: string,
): Map<ResponseStatusKey, ParsedResponseEntry> {
  const result = new Map<ResponseStatusKey, ParsedResponseEntry>();

  if (!responses) return result;

  for (const [statusCode, response] of Object.entries(responses)) {
    if (!isRecord(response)) {
      warnings?.push(
        `${label}: response "${statusCode}" is not an object, skipped`,
      );
      continue;
    }

    const code = parseResponseStatusKey(statusCode);
    if (code === undefined) {
      warnings?.push(
        `${label}: response status key "${statusCode}" is not recognized, skipped`,
      );
      continue;
    }

    const description = getString(response.description) ?? "";

    let schema: JSONSchema7 | undefined;
    let examples: Map<string, unknown> | undefined;
    let contentTypes: string[] | undefined;
    let responseContent: Map<string, ParsedResponseContent> | undefined;

    if (isSwagger2) {
      if (isRecord(response.schema)) {
        schema = normalizeParsedSchema(response.schema, "response");
      }
      // Swagger 2.0 single example
      if (response.examples !== undefined && isRecord(response.examples)) {
        examples = new Map();
        for (const [key, value] of Object.entries(response.examples)) {
          examples.set(key, value);
        }
      }
      // `produces` gives Swagger 2.0 the media types negotiation needs.
      // Deliberately NOT a `content` map: `validateResponse` treats a populated
      // `content` as the authoritative per-media-type contract, and Swagger 2.0
      // declares exactly one schema for all of them.
      if (produces && produces.length > 0) {
        contentTypes = produces.map(normalizeMediaType);
      }
    } else {
      const content = isRecord(response.content) ? response.content : undefined;
      if (content) {
        contentTypes = Object.keys(content);
        responseContent = extractResponseContent(
          content,
          normalizeParsedSchema,
        );
        const jsonEntry = findJsonContent(content);
        if (jsonEntry && isRecord(jsonEntry.schema)) {
          schema = normalizeParsedSchema(jsonEntry.schema, "response");
        }
        // OAS3 named examples
        if (jsonEntry) {
          examples = extractExamples(jsonEntry);
        }
      }
    }

    const headers = extractResponseHeaders(
      response,
      isSwagger2,
      normalizeParsedSchema,
    );
    result.set(code, {
      schema,
      description,
      headers,
      examples,
      contentTypes,
      content: responseContent,
    });
  }

  return result;
}

function extractResponseContent(
  content: Record<string, unknown>,
  normalizeParsedSchema: SchemaNormalizer,
): Map<string, ParsedResponseContent> | undefined {
  const result = new Map<string, ParsedResponseContent>();

  for (const [mediaType, entryRaw] of Object.entries(content)) {
    if (!isRecord(entryRaw)) continue;

    const schema = isRecord(entryRaw.schema)
      ? normalizeParsedSchema(entryRaw.schema, "response")
      : undefined;
    const examples = extractExamples(entryRaw);
    result.set(mediaType, { schema, examples });
  }

  return result.size > 0 ? result : undefined;
}

function extractExamples(
  contentEntry: Record<string, unknown>,
): Map<string, unknown> | undefined {
  const result = new Map<string, unknown>();

  // Single `example` value
  if ("example" in contentEntry && contentEntry.example !== undefined) {
    result.set("default", contentEntry.example);
  }

  // Named `examples` map
  if (isRecord(contentEntry.examples)) {
    for (const [name, exampleObj] of Object.entries(contentEntry.examples)) {
      if (isRecord(exampleObj) && "value" in exampleObj) {
        result.set(name, exampleObj.value);
      }
    }
  }

  return result.size > 0 ? result : undefined;
}

function extractResponseHeaders(
  response: Record<string, unknown>,
  isSwagger2: boolean,
  normalizeParsedSchema: SchemaNormalizer,
): Record<string, Schmock.ResponseHeaderDef> | undefined {
  const rawHeaders = isRecord(response.headers) ? response.headers : undefined;
  if (!rawHeaders) return undefined;

  const headers: Record<string, Schmock.ResponseHeaderDef> = {};
  let hasHeaders = false;

  for (const [name, headerRaw] of Object.entries(rawHeaders)) {
    if (!isRecord(headerRaw)) continue;

    const desc = getString(headerRaw.description) ?? "";
    let headerSchema: JSONSchema7 | undefined;

    if (isSwagger2) {
      // Swagger 2.0: type/format/enum are inline on the header
      if (headerRaw.type) {
        headerSchema = normalizeParsedSchema(
          {
            type: headerRaw.type,
            format: headerRaw.format,
            enum: headerRaw.enum,
          },
          "response",
        );
      }
    } else {
      // OpenAPI 3.x: schema is nested
      if (isRecord(headerRaw.schema)) {
        headerSchema = normalizeParsedSchema(headerRaw.schema, "response");
      }
    }

    headers[name] = { schema: headerSchema, description: desc };
    hasHeaders = true;
  }

  return hasHeaders ? headers : undefined;
}

/**
 * Find the best JSON-like content type entry from an OpenAPI content map.
 * Prefers application/json, then any *+json or *json* type.
 */
function findJsonContent(
  content: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // Prefer exact application/json
  if (isRecord(content["application/json"])) {
    return content["application/json"];
  }
  // Try any JSON-like content type (application/problem+json, etc.)
  for (const [type, value] of Object.entries(content)) {
    if (type.includes("json") && isRecord(value)) {
      return value;
    }
  }
  // Fallback to first content type
  return Object.values(content).find((v): v is Record<string, unknown> =>
    isRecord(v),
  );
}

/**
 * Rewrite an OpenAPI path template into the Express form the router uses:
 * `/pets/{petId}` → `/pets/:petId`.
 *
 * Exported so `options.schemas` keys can be normalized with the SAME function
 * that produced `ParsedPath.path`. A second copy would be a silent mismatch
 * waiting to happen — the exact drift that made a spec-native override key
 * report "the spec declares no ... operation" about an operation it declares.
 */
export function convertPathTemplate(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

function extractSecuritySchemes(
  api: OpenAPI.Document,
  isSwagger2: boolean,
): Map<string, SecurityScheme> | undefined {
  const schemes = new Map<string, SecurityScheme>();

  let rawSchemes: Record<string, unknown> | undefined;

  if (isSwagger2) {
    // Swagger 2.0: securityDefinitions
    if ("securityDefinitions" in api) {
      const defs = api.securityDefinitions;
      if (isRecord(defs)) {
        rawSchemes = defs;
      }
    }
  } else {
    // OpenAPI 3.x: components.securitySchemes
    if ("components" in api && isRecord(api.components)) {
      const comp = api.components;
      if ("securitySchemes" in comp && isRecord(comp.securitySchemes)) {
        rawSchemes = comp.securitySchemes;
      }
    }
  }

  if (!rawSchemes) return schemes.size > 0 ? schemes : undefined;

  for (const [name, schemeDef] of Object.entries(rawSchemes)) {
    if (!isRecord(schemeDef)) continue;

    const type = getString(schemeDef.type);
    if (!type) continue;

    const scheme = toSecurityScheme(type, schemeDef, isSwagger2);
    if (scheme) {
      schemes.set(name, scheme);
    }
  }

  return schemes.size > 0 ? schemes : undefined;
}

const SECURITY_SCHEME_TYPES = new Set([
  "apiKey",
  "http",
  "oauth2",
  "openIdConnect",
]);
const API_KEY_LOCATIONS = new Set(["header", "query", "cookie"]);

function toSecurityScheme(
  type: string,
  def: Record<string, unknown>,
  isSwagger2: boolean,
): SecurityScheme | undefined {
  // Handle Swagger 2.0 basic auth
  if (isSwagger2 && type === "basic") {
    return { type: "http", scheme: "basic" };
  }

  if (!SECURITY_SCHEME_TYPES.has(type)) return undefined;

  const scheme: SecurityScheme = {
    type:
      type === "apiKey"
        ? "apiKey"
        : type === "http"
          ? "http"
          : type === "oauth2"
            ? "oauth2"
            : "openIdConnect",
  };

  if (type === "apiKey") {
    const location = getString(def.in);
    if (location && API_KEY_LOCATIONS.has(location)) {
      scheme.in =
        location === "header"
          ? "header"
          : location === "query"
            ? "query"
            : "cookie";
    }
    scheme.name = getString(def.name);
  } else if (type === "http") {
    scheme.scheme = getString(def.scheme)?.toLowerCase();
  }

  return scheme;
}

/**
 * Extract security requirements from a security array.
 * Each entry in the array is an OR condition (any can match).
 * Each entry is an object where keys are scheme names (AND within).
 * Returns array of string arrays: [[schemeA, schemeB], [schemeC]] means (A AND B) OR C.
 * An empty array entry means "no auth required" (public).
 */
function extractSecurityRequirements(
  security: unknown[] | undefined,
): string[][] | undefined {
  if (!security) return undefined;
  if (security.length === 0) return [];

  const result: string[][] = [];
  for (const entry of security) {
    if (!isRecord(entry)) continue;
    result.push(Object.keys(entry));
  }

  return result.length > 0 ? result : undefined;
}

/**
 * Extract OAS3 callbacks from an operation.
 * Callbacks structure: { callbackName: { urlExpression: { method: { requestBody, ... } } } }
 */
function extractCallbacks(
  callbacks: Record<string, unknown>,
  normalizeParsedSchema: SchemaNormalizer,
): ParsedCallback[] | undefined {
  const result: ParsedCallback[] = [];

  for (const callbackObj of Object.values(callbacks)) {
    if (!isRecord(callbackObj)) continue;

    // Each key is a URL expression like "{$request.body#/callbackUrl}"
    for (const [urlExpression, pathItem] of Object.entries(callbackObj)) {
      if (!isRecord(pathItem)) continue;

      for (const methodKey of Object.keys(pathItem)) {
        if (!HTTP_METHOD_KEYS.has(methodKey)) continue;

        const operation = pathItem[methodKey];
        if (!isRecord(operation)) continue;

        let reqBody: JSONSchema7 | undefined;
        if (isRecord(operation.requestBody)) {
          reqBody = extractOpenApi3RequestBody(
            operation.requestBody,
            normalizeParsedSchema,
          );
        }

        result.push({
          urlExpression,
          method: toHttpMethod(methodKey.toUpperCase()),
          requestBody: reqBody,
        });
      }
    }
  }

  return result.length > 0 ? result : undefined;
}
