import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPI } from "openapi-types";
import type { RefParserOptions } from "./ref-policy.js";

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
}

/**
 * One resolver per `parseSpec` call, never module-scoped: a swagger-parser
 * instance carries the `$refs` map for the document it resolved, and parallel
 * `openapi()` calls under `Promise.all` would otherwise read each other's.
 */
export function createResolver(): SpecResolver {
  const parser = new SwaggerParser();

  return {
    parse: (source, options) =>
      parser.parse(source, options as SwaggerParser.Options),

    dereference: async ({ document, baseUrl, options, strict }) => {
      // `validate()` dereferences first and only then runs the validators,
      // which are disabled unless strict. The 3-argument form is what retains
      // the source URI.
      const derefOptions = {
        ...options,
        validate: { schema: strict, spec: strict },
      } as SwaggerParser.Options;
      const validated =
        baseUrl !== undefined
          ? await parser.validate(baseUrl, document as never, derefOptions)
          : await parser.validate(document as never, derefOptions);
      return validated as OpenAPI.Document;
    },

    documents: () => parser.$refs.values(),
  };
}
