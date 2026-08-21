import { SchmockError } from "@schmock/core";
import type { OpenAPI } from "openapi-types";
import { dereferenceInternal } from "./deref-internal.js";
import type { RefParserOptions } from "./ref-policy.js";
import type { DereferenceRequest, SpecResolver } from "./resolver.js";

/**
 * The browser build's stand-in for `resolver.ts`.
 *
 * `scripts/build.ts` swaps this module in wherever `./resolver.js` is imported,
 * so the browser bundle never contains `@apidevtools/swagger-parser` and never
 * reaches the `require("path")` / `require("util")` calls that a browser
 * bundler cannot resolve. `browser-bundle.test.ts` bundles a real consumer with
 * esbuild and fails if any of it comes back.
 *
 * What a browser loses is only what genuinely needs a filesystem or a
 * validator this build does not ship. Each of those throws by name rather than
 * degrading: the original bug was expensive precisely because a browser got
 * silence instead of an error, so a mock that quietly resolved fewer refs than
 * Node would be the same mistake one layer down.
 *
 * Inline specs — including the overwhelmingly common case of a spec whose
 * `$ref`s point inside itself — are fully supported, and
 * `deref-parity.test.ts` pins them to byte-identical output against
 * swagger-parser.
 */

function nodeOnly(what: string, detail: string): SchmockError {
  return new SchmockError(
    `${what} is not available in a browser build of @schmock/openapi. ${detail}`,
    "OPENAPI_NODE_ONLY",
    { feature: what },
  );
}

export function createResolver(): SpecResolver {
  return {
    parse: (source: string): Promise<OpenAPI.Document> => {
      throw nodeOnly(
        "Loading a spec from a file path or URL",
        `Pass the spec as an object instead of "${source}" — bundle it with your app, ` +
          "or fetch it yourself and hand the parsed result to openapi({ spec }).",
      );
    },

    dereference: async ({
      document,
      options,
      strict,
    }: DereferenceRequest): Promise<OpenAPI.Document> => {
      if (strict) {
        throw nodeOnly(
          "strict: true",
          "Validating against the OpenAPI meta-schema needs the Node build. " +
            "Validate the spec in your build or test step and leave strict off at runtime.",
        );
      }
      if ((options as RefParserOptions).resolve.external) {
        throw nodeOnly(
          "refs: { external: true }",
          "External $refs are resolved by swagger-parser, which cannot run in a browser. " +
            "Bundle a spec whose $refs all point inside itself.",
        );
      }
      return dereferenceInternal(document);
    },

    // Only ever consulted to attribute a `oneOf` branch that arrived from
    // another document, and this build resolves no other documents. The
    // pre-dereference `markDiscriminatorValues` pass already covers every
    // branch a single-document spec can have.
    documents: (): unknown => ({}),
  };
}
