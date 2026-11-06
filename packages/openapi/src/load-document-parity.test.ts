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

function animal(sound: string): Record<string, unknown> {
  return {
    type: "object",
    required: ["petType", sound],
    properties: { petType: { type: "string" }, [sound]: { type: "boolean" } },
  };
}

/**
 * `Pet`'s `oneOf` branches ARE the `Cat` and `Dog` component objects, as a
 * JS-built spec or a YAML alias produces, not `$ref`s to them. With
 * `unrelatedRef`, the response reaches `Pet` through a `$ref`, which is what
 * used to send the Node build through the resolver and change its answer.
 */
function aliasedDiscriminatorSpec(
  unrelatedRef: boolean,
): Record<string, unknown> {
  const cat = animal("meow");
  const dog = animal("bark");
  const pet = { oneOf: [cat, dog], discriminator: { propertyName: "petType" } };
  return specWithResponseSchema(
    unrelatedRef ? { $ref: "#/components/schemas/Pet" } : pet,
    { Pet: pet, Cat: cat, Dog: dog },
  );
}

const MARKER = "x-schmock-discriminator-values";

async function discriminatorValuesFor(
  build: (typeof BUILDS)[number],
  spec: object,
): Promise<unknown> {
  const loadDocument = await loadDocumentFor(build);
  const api = (await loadDocument(spec, {})) as unknown as {
    components: {
      schemas: { Pet: { discriminator: Record<string, unknown> } };
    };
  };
  return api.components.schemas.Pet.discriminator[MARKER];
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

  for (const [version, ref] of [
    ["3.0.3", "#components/schemas/Pet"],
    ["3.1.0", "#nope"],
  ] as const) {
    it(`refuses the fragment $ref ${ref}, which names nothing, with the same code`, async () => {
      const spec = {
        ...specWithResponseSchema({ $ref: ref }, { Pet: { type: "object" } }),
        openapi: version,
      };

      const [node, browser] = [
        await failureFor("node", spec),
        await failureFor("browser", spec),
      ];

      expect(node).toEqual({
        name: "SchmockError",
        code: "OPENAPI_INVALID_REF",
      });
      expect(browser).toEqual(node);
    });
  }

  it("loads an anchor $ref whose anchor the document declares", async () => {
    const spec = {
      ...specWithResponseSchema(
        { $ref: "#pet" },
        { Pet: { $anchor: "pet", type: "object" } },
      ),
      openapi: "3.1.0",
    };

    for (const build of BUILDS) {
      const loadDocument = await loadDocumentFor(build);
      await expect(loadDocument(structuredClone(spec), {})).resolves.toEqual(
        expect.objectContaining({ openapi: "3.1.0" }),
      );
    }
  });

  for (const unrelatedRef of [true, false]) {
    it(`names discriminator branches that are component objects ${unrelatedRef ? "with" : "without"} a $ref elsewhere`, async () => {
      const spec = aliasedDiscriminatorSpec(unrelatedRef);

      const node = await discriminatorValuesFor("node", spec);
      const browser = await discriminatorValuesFor("browser", spec);

      expect(node).toEqual([["Cat"], ["Dog"]]);
      expect(browser).toEqual(node);
    });
  }
});
