import { SchmockError } from "@schmock/core";
import type { OpenAPI } from "openapi-types";
import { assertNoRefRing } from "./deref-internal.js";
import {
  buildRefParserOptions,
  checkRef,
  collectUnresolvedRefs,
  type RefFetch,
  type RefParserOptions,
  type RefPolicy,
  resolveRefPolicy,
} from "./ref-policy.js";
import { createResolver, type SpecResolver } from "./resolver.js";
import { combineRefSiblings, hideLiteralRefs } from "./spec-refs.js";
import { isRecord } from "./utils.js";

/*
 * Turning a spec source into one dereferenced document: reading it, ruling on
 * every `$ref` that leaves it, marking discriminator values while the `$ref`s
 * still say which mapping key names them, and dereferencing. What the parser
 * then reads operations out of lives in `operation-extract.ts`.
 */

function isOpenApiDocument(value: unknown): value is OpenAPI.Document {
  return isRecord(value) && ("swagger" in value || "openapi" in value);
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

export interface LoadDocumentOptions {
  /**
   * Validate the document against the OpenAPI schema and specification at load
   * time. Default `false`: incomplete specs are deliberately tolerated.
   */
  strict?: boolean;
  /** External `$ref` resolution policy. External refs are off by default. */
  refs?: RefPolicy;
  /**
   * Transport for http `$ref`s. Internal: omitted, the resolver's own is used —
   * in the Node build the guarded one in `ref-transport.ts`. The plugin never
   * passes it; tests substitute a stub.
   */
  fetchRef?: RefFetch;
}

/**
 * Refuse, in strict mode, a version the validator cannot validate, with the
 * same code the validator's own failures carry.
 *
 * Non-strict mode tolerates any version on every path: a ref-free document
 * never reaches swagger-parser, the browser resolver never checks, and the
 * Node resolver pins a version it accepts for the duration of a dereference.
 */
function assertStrictVersion(
  raw: OpenAPI.Document,
  source: string | object,
): void {
  const field = "swagger" in raw ? "swagger" : "openapi";
  const version: unknown = Reflect.get(raw, field);
  const supported =
    field === "swagger"
      ? version === "2.0"
      : typeof version === "string" && /^3\.[01]\.\d+$/.test(version);
  if (supported) return;
  throw new SchmockError(
    `OpenAPI spec declares ${field} ${JSON.stringify(version)}, which strict validation does not support ` +
      "(Swagger 2.0 and OpenAPI 3.0.x/3.1.x are). Leave strict off to load it without validation.",
    "OPENAPI_INVALID_SPEC",
    { spec: typeof source === "string" ? source : undefined },
  );
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
export async function loadDocument(
  source: string | object,
  options: LoadDocumentOptions,
): Promise<OpenAPI.Document> {
  const policy = resolveRefPolicy(options.refs);
  const resolver = createResolver();
  // Per call, never module-scoped: parallel `openapi()` calls under
  // `Promise.all` would otherwise read each other's diagnostics.
  const refDiagnostics = new Map<string, string>();
  const refOptions = buildRefParserOptions(
    options.refs,
    refDiagnostics,
    options.fetchRef ?? resolver.fetchRef,
  );
  const strict = options.strict === true;

  let raw: OpenAPI.Document;
  let baseUrl: string | undefined;
  if (typeof source === "string") {
    // Read the root document only — `parse` resolves nothing, which is what
    // lets the policy rule on its refs before any of them are followed.
    raw = await resolver.parse(source, refOptions);
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
  if (strict) assertStrictVersion(raw, source);

  // Before the policy pre-scan, so a `$ref`-shaped example or vendor extension
  // is neither reported as an external ref nor followed; put back below.
  const literalRefs = hideLiteralRefs(raw);

  const blocked: string[] = [];
  for (const ref of collectUnresolvedRefs(raw)) {
    const verdict = checkRef(ref, policy);
    if (!verdict.allowed) blocked.push(`${ref} (${verdict.reason})`);
  }
  if (blocked.length > 0) throw externalRefBlocked(blocked, source);

  // MUST run before dereference: it is the last moment a `oneOf` branch is
  // still a `$ref` string and can be paired with its `mapping` entry.
  markDiscriminatorValues(raw);
  // After the marker, which reads the `$ref` a sibling rewrite would move.
  combineRefSiblings(raw);
  assertNoRefRing(raw);

  const api = await dereferenceDocument({
    resolver,
    baseUrl,
    raw,
    refOptions,
    strict,
    source,
    diagnostics: refDiagnostics,
  });
  markDereferencedDiscriminatorValues(api, resolver.documents());

  // Defence in depth for refs reached through a nested document: only
  // reachable once external resolution is on, and skipping the walk otherwise
  // keeps multi-megabyte specs off a second full traversal.
  if (policy.external) {
    const residual = collectUnresolvedRefs(api);
    if (residual.length > 0) throw externalRefBlocked(residual, source);
  }

  // Dereferencing mutates in place, so the hidden objects are still the ones
  // in `api` — a merged `$ref` target shares them by identity.
  literalRefs.restore();
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

interface DereferenceDocumentArgs {
  resolver: SpecResolver;
  baseUrl: string | undefined;
  raw: OpenAPI.Document;
  refOptions: RefParserOptions;
  strict: boolean;
  source: string | object;
  diagnostics: Map<string, string>;
}

async function dereferenceDocument({
  resolver,
  baseUrl,
  raw,
  refOptions,
  strict,
  source,
  diagnostics,
}: DereferenceDocumentArgs): Promise<OpenAPI.Document> {
  // Ref-free object sources keep their fast path: no resolver, no clone, no
  // validator. `browser-compat.test.ts` pins it.
  const hasRefs =
    baseUrl !== undefined || JSON.stringify(raw).includes('"$ref"');
  if (!hasRefs && !strict) return raw;

  try {
    return await resolver.dereference({
      document: raw,
      baseUrl,
      options: refOptions,
      strict,
    });
  } catch (rawError) {
    // A browser build refusing a Node-only option is answering the caller's
    // question, not reporting a bad spec. Wrapping it as a validation failure
    // would bury the one sentence that says what to do instead.
    // Likewise a policy refusal raised mid-resolution (a local file reached
    // from a remote document): it is a decision, not a validation failure.
    if (
      rawError instanceof SchmockError &&
      (rawError.code === "OPENAPI_NODE_ONLY" ||
        rawError.code === "OPENAPI_EXTERNAL_REF_BLOCKED")
    ) {
      throw rawError;
    }
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
  if (!("code" in error) || error.code !== "ERESOLVER") return error;

  let detail: string | undefined;
  const source = "source" in error ? error.source : undefined;
  if (typeof source === "string") {
    detail = diagnostics.get(source);
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
