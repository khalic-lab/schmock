import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Node entry and the browser entry must behave identically for everything
 * a browser can do at all.
 *
 * They are different module graphs — `scripts/build.ts` swaps `resolver.ts` and
 * `seed-file.ts` for their `.browser` siblings — so nothing else in this suite
 * compares them. A divergence here would surface as a mock that answers one way
 * in a test run and another in the browser, which is the failure mode that made
 * the original bug take a whole BDD suite going dark to find.
 *
 * `deref-parity.test.ts` covers dereferencing in isolation; this covers the
 * built entries end to end, including the parts of `parseSpec` that read what
 * dereferencing produced.
 */

const packageRoot = resolve(import.meta.dirname, "..");

type OpenApiFn = (options: Record<string, unknown>) => Promise<unknown>;

async function loadEntry(file: string): Promise<OpenApiFn> {
  const { openapi } = (await import(resolve(packageRoot, file))) as {
    openapi: OpenApiFn;
  };
  return openapi;
}

const ENTRIES = [
  ["node", "dist/index.js"],
  ["browser", "dist/index.browser.js"],
] as const;

function animal(sound: string): Record<string, unknown> {
  return {
    type: "object",
    required: ["petType", sound],
    properties: {
      petType: { type: "string" },
      [sound]: { type: "boolean" },
    },
  };
}

/**
 * A `oneOf` with a `discriminator` carrying NO explicit `mapping`.
 *
 * This is the case that pins `resolver.browser.ts`'s `documents: () => ({})`.
 * The Node entry hands `parser.$refs.values()` to
 * `markDereferencedDiscriminatorValues`, which attributes a dereferenced branch
 * back to the component name it came from; the browser entry hands it nothing,
 * on the reasoning that the pre-dereference `markDiscriminatorValues` pass
 * already covers every branch a single-document spec can have. If that
 * reasoning is wrong, the implicit `petType` values differ between the entries
 * and this test says so.
 */
const DISCRIMINATOR_SPEC = {
  openapi: "3.0.3",
  info: { title: "Entry Parity", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        oneOf: [
          { $ref: "#/components/schemas/Cat" },
          { $ref: "#/components/schemas/Dog" },
        ],
        discriminator: { propertyName: "petType" },
      },
      Cat: animal("meow"),
      Dog: animal("bark"),
    },
  },
};

/** One component referenced from two places, so identity sharing is exercised. */
const SHARED_SPEC = {
  openapi: "3.0.3",
  info: { title: "Entry Parity", version: "1.0.0" },
  paths: {
    "/nodes": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Node" },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Node: {
        type: "object",
        required: ["id", "label", "title"],
        properties: {
          id: { type: "integer" },
          label: { $ref: "#/components/schemas/Label" },
          title: { $ref: "#/components/schemas/Label" },
        },
      },
      Label: { type: "string", maxLength: 12 },
    },
  },
};

/**
 * A schema that references itself through a property.
 *
 * `@schmock/faker` refuses to generate from a cycle, so the mock answers 500.
 * That refusal is the behaviour under test: it depends on the dereferenced
 * document containing a REAL object cycle, which only happens if the
 * dereferencer shares one object across every use rather than cloning per site.
 * A browser entry that cloned instead would quietly answer 200 here and hand
 * back data the Node build would have rejected.
 */
const CYCLIC_SPEC = {
  ...SHARED_SPEC,
  components: {
    schemas: {
      Node: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "integer" },
          child: { $ref: "#/components/schemas/Node" },
        },
      },
    },
  },
};

/**
 * Same spec, same seed, both entries — so any difference is the resolver's,
 * not the generator's.
 */
async function responseFrom(
  entry: string,
  spec: object,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const { schmock } = await import("@schmock/core");
  const openapi = await loadEntry(entry);
  const mock = schmock({ state: {} });
  mock.pipe((await openapi({ spec, fakerSeed: 424_242 })) as never);
  return await mock.handle("GET", path);
}

describe("Node and browser entries agree", () => {
  it("both entries load", async () => {
    for (const [, file] of ENTRIES) {
      expect(typeof (await loadEntry(file))).toBe("function");
    }
  });

  it("resolve an implicit discriminator to the same values", async () => {
    const [node, browser] = await Promise.all(
      ENTRIES.map(([, file]) =>
        responseFrom(file, DISCRIMINATOR_SPEC, "/pets"),
      ),
    );

    expect(node.status).toBe(200);
    expect(browser).toEqual(node);
    // Not a vacuous match on two empty bodies: the branch has to have been
    // chosen and stamped with the component's own name.
    const pet = node.body as Record<string, unknown>;
    expect(["Cat", "Dog"]).toContain(pet.petType);
  });

  it("resolve a component used twice to the same response", async () => {
    const [node, browser] = await Promise.all(
      ENTRIES.map(([, file]) => responseFrom(file, SHARED_SPEC, "/nodes")),
    );

    expect(node.status).toBe(200);
    expect(browser).toEqual(node);
    const items = node.body as Array<Record<string, unknown>>;
    expect(Array.isArray(items)).toBe(true);
    for (const item of items) {
      expect(typeof item.id).toBe("number");
      expect(typeof item.label).toBe("string");
      expect(typeof item.title).toBe("string");
    }
  });

  it("reject a self-referencing schema the same way", async () => {
    const [node, browser] = await Promise.all(
      ENTRIES.map(([, file]) => responseFrom(file, CYCLIC_SPEC, "/nodes")),
    );

    expect(node.status).toBe(500);
    expect(browser).toEqual(node);
  });
});
