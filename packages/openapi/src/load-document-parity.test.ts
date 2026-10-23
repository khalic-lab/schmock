import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `loadDocument` run through each resolver, from source.
 *
 * `scripts/build.ts` swaps `resolver.ts` for `resolver.browser.ts` in the
 * browser build, and `deref-parity.test.ts` only compares the two
 * dereferencers in isolation. What `loadDocument` does around them — the
 * preflight, the discriminator passes, the error mapping — is where a spec can
 * still load one way under Node and another in a browser, so this swaps the
 * module the same way the build does and runs the whole function. Unlike
 * `entry-parity.test.ts` it needs no build.
 */

type LoadDocument = typeof import("./load-document").loadDocument;

const BUILDS = ["node", "browser"] as const;

async function loadDocumentFor(
  build: (typeof BUILDS)[number],
): Promise<LoadDocument> {
  vi.resetModules();
  if (build === "browser") {
    vi.doMock("./resolver.js", () => import("./resolver.browser"));
  } else {
    vi.doUnmock("./resolver.js");
  }
  return (await import("./load-document")).loadDocument;
}

/** Each build's error, reduced to what a caller can branch on. */
async function failureFor(
  build: (typeof BUILDS)[number],
  spec: object,
): Promise<{ name: string; code: unknown }> {
  const loadDocument = await loadDocumentFor(build);
  try {
    await loadDocument(structuredClone(spec), {});
  } catch (error) {
    // `resetModules` gives each build its own `SchmockError` class, so the
    // name and code are compared rather than the constructor.
    return {
      name: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: unknown }).code,
    };
  }
  throw new Error(`expected the ${build} build to reject`);
}

function specWithResponseSchema(
  schema: object,
  schemas: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "Parity", version: "1.0.0" },
    paths: {
      "/x": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema } },
            },
          },
        },
      },
    },
    components: { schemas },
  };
}

afterEach(() => {
  vi.doUnmock("./resolver.js");
  vi.resetModules();
});

describe("loadDocument agrees under the Node and browser resolvers", () => {
  it("swaps the resolver it claims to", async () => {
    // Without this, every case below could pass by testing Node twice.
    const loadDocument = await loadDocumentFor("browser");
    const failure = await loadDocument("./petstore.yaml", {}).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: unknown }).code).toBe("OPENAPI_NODE_ONLY");
  });

  it("refuses a $ref to nothing with the same code", async () => {
    const spec = specWithResponseSchema({
      $ref: "#/components/schemas/Missing",
    });

    const [node, browser] = [
      await failureFor("node", spec),
      await failureFor("browser", spec),
    ];

    expect(node).toEqual({ name: "SchmockError", code: "OPENAPI_INVALID_REF" });
    expect(browser).toEqual(node);
  });
});
