import SwaggerParser from "@apidevtools/swagger-parser";
import { SchmockError } from "@schmock/core";
import type { OpenAPI } from "openapi-types";
import {
  collectUnresolvedRefs,
  isHttpUrl,
  type RefFetch,
  type RefParserOptions,
} from "./ref-policy.js";
import { createGuardedFetch } from "./ref-transport.js";
import { isRecord } from "./utils.js";

/**
 * Everything in this package that needs `@apidevtools/swagger-parser`, behind
 * one interface.
 *
 * The point of the seam is the browser build. swagger-parser is CommonJS and
 * reaches `require("util")`; its `json-schema-ref-parser` dependency reaches
 * `require("path")` in three places and maps only `fs` in its `browser` field.
 * A bundler targeting the browser therefore fails to resolve the graph, and no
 * consumer-side configuration can fix it, because the `require` calls are
 * inside the dependency.
 *
 * A lazy `await import()` does NOT help and was measured, not assumed: esbuild
 * resolves the target of a dynamic import at build time even when the branch
 * holding it can never run. The module has to be physically absent from the
 * browser build, which is what `resolver.browser.ts` and the alias in
 * `scripts/build.ts` accomplish. Keeping the swap at build time rather than
 * behind a runtime flag is why nothing else in this package — tests included —
 * has to know the seam exists.
 *
 * @see resolver.browser.ts for what a browser gets instead.
 */

export interface DereferenceRequest {
  /** The root document, already loaded and policy-checked. */
  document: OpenAPI.Document;
  /**
   * Source URI when the spec came from a path, so a relative external `$ref`
   * resolves against the spec's own directory rather than `process.cwd()`.
   */
  baseUrl: string | undefined;
  /** Ref-resolution options, as built by `buildRefParserOptions`. */
  options: RefParserOptions;
  /** Validate the document against the OpenAPI schema and specification. */
  strict: boolean;
}

export interface SpecResolver {
  /**
   * Read and deserialise a root document from a path or URL, resolving
   * nothing — which is what lets the ref policy rule on its `$ref`s before any
   * of them are followed.
   */
  parse(source: string, options: RefParserOptions): Promise<OpenAPI.Document>;

  /** Replace every `$ref` with its target, validating first when `strict`. */
  dereference(request: DereferenceRequest): Promise<OpenAPI.Document>;

  /**
   * Every document resolution touched, keyed by resolved URI.
   *
   * Used to attribute a dereferenced `oneOf` branch back to the named schema
   * it came from, which object identity alone cannot do once a branch arrives
   * from a different file.
   */
  documents(): unknown;

  /** The transport http `$ref`s are read through; see `ref-transport.ts`. */
  fetchRef: RefFetch;
}

/**
 * The OpenAPI versions swagger-parser 12 accepts. It rejects anything else
 * even with validation off, before a single `$ref` is resolved.
 */
const SWAGGER_PARSER_OPENAPI_VERSIONS = new Set([
  "3.0.0",
  "3.0.1",
  "3.0.2",
  "3.0.3",
  "3.0.4",
  "3.1.0",
  "3.1.1",
  "3.1.2",
]);

/**
 * Hand swagger-parser a version it accepts, for the duration of one
 * non-strict dereference, and put the original back afterwards.
 *
 * Only reached when a document HAS `$ref`s: a ref-free document skips the
 * resolver entirely and the browser resolver never checks a version, so
 * without this an `openapi: 3.2.0` document loaded or failed depending on
 * whether it contained a `$ref` and on which build ran it. Strict mode never
 * gets here with such a version — `parseSpec` rejects it up front.
 */
function pinSupportedVersion(document: OpenAPI.Document): () => void {
  const field = "swagger" in document ? "swagger" : "openapi";
  const original: unknown = Reflect.get(document, field);
  const pinned =
    field === "swagger"
      ? "2.0"
      : typeof original === "string" && original.startsWith("3.0.")
        ? "3.0.4"
        : "3.1.2";
  if (
    original === pinned ||
    (field === "openapi" &&
      typeof original === "string" &&
      SWAGGER_PARSER_OPENAPI_VERSIONS.has(original))
  ) {
    return () => undefined;
  }
  Reflect.set(document, field, pinned);
  return () => {
    Reflect.set(document, field, original);
  };
}

/** swagger-parser's own complaints about a version field, from `parse()`. */
const VERSION_REJECTION =
  /^(Unsupported OpenAPI version|Unrecognized Swagger version|Swagger version number must be|Openapi version number must be)/;

/**
 * Give a version rejection from reading a spec file the same coded form the
 * strict-mode gate in `parseSpec` uses. A file root is read by swagger-parser's
 * `parse()`, which refuses an unknown version before returning the document,
 * so there is nothing to pin; the rejection itself was just uncoded.
 */
function codedVersionError(error: unknown, source: string): unknown {
  if (
    !(error instanceof SyntaxError) ||
    !VERSION_REJECTION.test(error.message)
  ) {
    return error;
  }
  return new SchmockError(
    `OpenAPI spec "${source}" has a version this package cannot read: ${error.message}`,
    "OPENAPI_INVALID_SPEC",
    { spec: source },
  );
}

/**
 * The location to hand ref-parser for a root read from `source`.
 *
 * ref-parser decides "file or URL" by sniffing for a `window` global: when one
 * exists — any jsdom or happy-dom test environment — it treats every
 * scheme-less path as relative to `window.location`, so `./petstore.yaml`
 * becomes `http://localhost:3000/petstore.yaml` and is downloaded. An explicit
 * `file://` URL is the one form it resolves the same way under both. Outside a
 * DOM the path is passed through untouched, exactly as before: ref-parser
 * would encode an already-encoded URL a second time there.
 */
async function rootLocation(source: string): Promise<string> {
  if (!("window" in globalThis) || /^[a-z][a-z\d+.-]*:\/\//i.test(source)) {
    return source;
  }
  const { resolve, sep } = await import("node:path");
  const absolute = resolve(source).split(sep).join("/");
  // `encodeURI` plus `?` and `#`: the encoding ref-parser applies to paths.
  const encoded = encodeURI(absolute)
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23");
  return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

/**
 * Whether ref-parser's file resolver would read `url`: no scheme, or `file:`.
 * The same test as its own `isFileSystemPath`, minus the `window` sniffing.
 */
function isLocalLocation(url: string): boolean {
  const protocol = /^(\w{2,}):\/\//i.exec(url)?.[1]?.toLowerCase();
  return protocol === undefined || protocol === "file";
}

/**
 * ref-parser's `url.resolve`, which decides the URL a nested `$ref` is read
 * from. Mirrored exactly — including resolving a relative base against a
 * throwaway host — so the provenance check below compares like with like.
 */
function resolveReference(from: string, to: string): string {
  const toPosix = (path: string): string =>
    path.startsWith("\\\\?\\") ? path : path.split("\\").join("/");
  const fromUrl = new URL(toPosix(from), "https://aaa.nonexistanturl.com");
  const resolved = new URL(toPosix(to), fromUrl);
  const endSpaces = /(\s*)$/.exec(to)?.[1] ?? "";
  if (resolved.hostname === "aaa.nonexistanturl.com") {
    return resolved.pathname + resolved.search + resolved.hash + endSpaces;
  }
  return resolved.toString() + endSpaces;
}

function stripHash(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * Where every external `$ref` in `document`, read from `base`, points. The
 * refs are the ones the policy pre-scan collects, so the two cannot disagree
 * on which refs exist.
 */
function referencedLocations(base: string, document: object): Set<string> {
  const targets = new Set<string>();
  for (const ref of collectUnresolvedRefs(document)) {
    if (ref.length === 0) continue;
    try {
      targets.add(stripHash(resolveReference(base, ref)));
    } catch {
      // Not a URL ref-parser could resolve either; nothing to allow.
    }
  }
  return targets;
}

interface LiveDocuments {
  root: string | undefined;
  documents: Array<{ location: string; value: unknown }>;
}

/**
 * The documents ref-parser has read so far in the current call, from its
 * `$refs` registry. That registry is internal, so it is read defensively: a
 * shape this code does not recognise yields no documents, and the guard then
 * refuses rather than allows.
 */
function liveDocuments(refs: unknown): LiveDocuments {
  if (!isRecord(refs) || !isRecord(refs._$refs)) {
    return { root: undefined, documents: [] };
  }
  const rootRef = refs._root$Ref;
  const root =
    isRecord(rootRef) && typeof rootRef.path === "string"
      ? rootRef.path
      : undefined;
  const documents: LiveDocuments["documents"] = [];
  for (const [location, entry] of Object.entries(refs._$refs)) {
    if (isRecord(entry)) documents.push({ location, value: entry.value });
  }
  return { root, documents };
}

function localFileBlocked(url: string): SchmockError {
  return new SchmockError(
    `OpenAPI spec contains an external $ref that was not resolved: ${url} ` +
      "(a local file may only be referenced from a local document, never from one fetched over http)",
    "OPENAPI_EXTERNAL_REF_BLOCKED",
    { refs: [url] },
  );
}

/**
 * A `canRead` for ref-parser's file resolver, merged over the built-in one so
 * its `read` is kept.
 *
 * Two jobs:
 *
 * - Claim local paths regardless of a `window` global, which is what makes a
 *   path spec load under jsdom (see {@link rootLocation}).
 * - Once http refs are on, refuse a local file that no LOCAL document asked
 *   for. The ref policy used to guard only the http resolver, so a fetched
 *   document could say `$ref: file:///home/me/.aws/credentials` — or bounce
 *   through an opaque `foo:x/../../…` that ref-parser also treats as a path —
 *   and the file resolver read it with no check at all. ref-parser tells a
 *   resolver nothing about which document a ref came from, so this asks the
 *   registry instead: at the moment a nested file is about to be read, the
 *   document that referenced it has already been parsed and recorded.
 *
 * Throwing, rather than returning false, gives a coded error: ref-parser calls
 * `canRead` outside the resolver loop, so the error propagates as thrown.
 */
function fileResolverGuard(parser: SwaggerParser, httpEnabled: boolean) {
  const targetsByDocument = new WeakMap<object, Set<string>>();
  return {
    canRead: (file: { url: string }): boolean => {
      if (!isLocalLocation(file.url)) return false;
      if (!httpEnabled) return true;

      const { root, documents } = liveDocuments(parser.$refs);
      if (file.url === root) return true;
      for (const { location, value } of documents) {
        if (isHttpUrl(location) || !isRecord(value)) continue;
        let targets = targetsByDocument.get(value);
        if (targets === undefined) {
          targets = referencedLocations(location, value);
          targetsByDocument.set(value, targets);
        }
        if (targets.has(file.url)) return true;
      }
      throw localFileBlocked(file.url);
    },
  };
}

function withLocalFiles(
  parser: SwaggerParser,
  options: RefParserOptions,
): SwaggerParser.Options {
  return {
    ...options,
    resolve: {
      ...options.resolve,
      file: fileResolverGuard(parser, typeof options.resolve.http === "object"),
    },
  };
}

type ExtendedRefsByParent = WeakMap<
  object,
  Map<string, Record<string, unknown>>
>;

/**
 * Every internal `$ref` that carries siblings, keyed by the object and key it
 * sits under — which is what ref-parser's `onDereference` reports.
 */
function extendedRefsByParent(document: unknown): ExtendedRefsByParent {
  const byParent: ExtendedRefsByParent = new WeakMap();
  const seen = new WeakSet<object>();
  const stack: unknown[] = [document];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);
    for (const [key, child] of Object.entries(node)) {
      if (
        isRecord(child) &&
        typeof child.$ref === "string" &&
        child.$ref.startsWith("#") &&
        Object.keys(child).length > 1
      ) {
        let entries = byParent.get(node);
        if (entries === undefined) {
          entries = new Map();
          byParent.set(node, entries);
        }
        entries.set(key, child);
      }
      stack.push(child);
    }
  }
  return byParent;
}

/**
 * Make a `$ref`'s siblings win however the target was reached.
 *
 * ref-parser merges siblings over a freshly resolved target, but when a bare
 * `$ref` to the same target was dereferenced EARLIER it takes a cached branch
 * that lets the target win any key both define — so `maxLength: 3` next to a
 * `$ref` applied or not depending on document order. Re-applying the siblings
 * to the merged copy restores the uncached result. The copy is fresh on every
 * path except a circular cache hit, which hands back the shared target itself;
 * that one is left alone, exactly as `deref-internal.ts` leaves it.
 */
function siblingsWin(parser: SwaggerParser, byParent: ExtendedRefsByParent) {
  return (
    _ref: string,
    value: unknown,
    parent?: unknown,
    key?: string,
  ): void => {
    if (typeof parent !== "object" || parent === null || key === undefined) {
      return;
    }
    const original = byParent.get(parent)?.get(key);
    if (original === undefined || !isRecord(value) || value === original)
      return;
    try {
      if (parser.$refs.get(String(original.$ref)) === value) return;
    } catch {
      return;
    }
    for (const [name, sibling] of Object.entries(original)) {
      if (name !== "$ref") value[name] = sibling;
    }
  };
}

/**
 * One resolver per `parseSpec` call, never module-scoped: a swagger-parser
 * instance carries the `$refs` map for the document it resolved, and parallel
 * `openapi()` calls under `Promise.all` would otherwise read each other's.
 */
export function createResolver(): SpecResolver {
  const parser = new SwaggerParser();

  return {
    fetchRef: createGuardedFetch(),

    parse: async (source, options) => {
      try {
        return await parser.parse(
          await rootLocation(source),
          withLocalFiles(parser, options),
        );
      } catch (error) {
        throw codedVersionError(error, source);
      }
    },

    dereference: async ({ document, baseUrl, options, strict }) => {
      // `validate()` dereferences first and only then runs the validators,
      // which are disabled unless strict. The 3-argument form is what retains
      // the source URI.
      const derefOptions: SwaggerParser.Options = {
        ...withLocalFiles(parser, options),
        dereference: {
          onDereference: siblingsWin(parser, extendedRefsByParent(document)),
        },
        validate: { schema: strict, spec: strict },
      };
      const restoreVersion = strict
        ? () => undefined
        : pinSupportedVersion(document);
      try {
        return baseUrl !== undefined
          ? await parser.validate(
              await rootLocation(baseUrl),
              document,
              derefOptions,
            )
          : await parser.validate(document, derefOptions);
      } finally {
        restoreVersion();
      }
    },

    documents: () => parser.$refs.values(),
  };
}
