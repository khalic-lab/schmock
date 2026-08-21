import { resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { dereferenceInternal } from "./deref-internal";

/**
 * `deref-internal.ts` exists only to reproduce what
 * `@apidevtools/json-schema-ref-parser` does for pointers inside one document,
 * because that library cannot be bundled for a browser. Anything it does
 * differently is a bug by definition, and would show up as a mock that behaves
 * one way under Node and another in the browser — the same silent divergence
 * that made the original bug so expensive to find.
 *
 * So this file does not assert what dereferencing SHOULD produce. It runs the
 * same document through both implementations and asserts the results are
 * indistinguishable, down to which objects are shared and where the cycles are.
 * Adding a case here covers both paths by construction.
 */

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");

/**
 * Read a fixture into the raw, still-referenced document.
 *
 * `parse()` reads and deserialises — YAML included — and resolves nothing,
 * which is exactly the document `parseSpec` holds when it decides how to
 * dereference. Reading the file is fine here: this test only ever runs on Node.
 */
async function readFixture(name: string): Promise<object> {
  return await new SwaggerParser().parse(resolve(fixturesDir, name), {
    resolve: { external: false },
  });
}

/**
 * A cycle-aware rendering of a value that also records object identity.
 *
 * Deep equality alone would pass a dereferencer that clones a component at
 * every use instead of sharing one object — which is precisely the mistake that
 * breaks the normalizer's identity-based cycle detection. Emitting a back
 * reference the second time an object is seen makes sharing and cycles part of
 * what is compared.
 */
function fingerprint(value: unknown): string {
  const seen = new Map<object, number>();
  let counter = 0;

  const render = (node: unknown): unknown => {
    if (typeof node !== "object" || node === null) {
      return typeof node === "undefined" ? "<undefined>" : node;
    }
    const existing = seen.get(node);
    if (existing !== undefined) return { $sharedWith: existing };
    const id = counter++;
    seen.set(node, id);

    if (Array.isArray(node)) return { $id: id, items: node.map(render) };
    const rendered: Record<string, unknown> = {};
    for (const key of Object.keys(node).sort()) {
      rendered[key] = render((node as Record<string, unknown>)[key]);
    }
    return { $id: id, ...rendered };
  };

  return JSON.stringify(render(value), null, 1);
}

/** Dereference exactly the way `parseSpec` does on the default, non-strict path. */
async function dereferenceWithSwaggerParser(
  document: object,
): Promise<unknown> {
  return await new SwaggerParser().validate(
    structuredClone(document) as never,
    {
      resolve: { external: false },
      validate: { schema: false, spec: false },
    },
  );
}

async function expectParity(document: object): Promise<void> {
  const reference = await dereferenceWithSwaggerParser(document);
  const ours = dereferenceInternal(structuredClone(document));
  expect(fingerprint(ours)).toBe(fingerprint(reference));
}

/** The smallest document that will pass swagger-parser, plus `components`. */
function specWith(
  schemas: Record<string, unknown>,
  paths: unknown = {},
): object {
  return {
    openapi: "3.0.3",
    info: { title: "Parity", version: "1.0.0" },
    paths,
    components: { schemas },
  };
}

describe("internal dereference parity with swagger-parser", () => {
  describe("real specs", () => {
    for (const name of [
      "petstore-openapi3.json",
      "petstore-swagger2.json",
      "openapi31.json",
      "train-travel.yaml",
      "scalar-galaxy.yaml",
      "stripe-spec3.yaml",
      "faker-stress-test.openapi.yaml",
    ]) {
      it(name, async () => {
        await expectParity(await readFixture(name));
      });
    }
  });

  it("resolves a plain component reference", async () => {
    await expectParity(
      specWith(
        { Pet: { type: "object", properties: { id: { type: "integer" } } } },
        {
          "/pets": {
            get: {
              responses: {
                "200": {
                  description: "ok",
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
      ),
    );
  });

  it("shares one object across every use of a component", async () => {
    // A diamond. Cloning per site would pass a deep-equality check and still
    // break the normalizer's identity-keyed memo.
    await expectParity(
      specWith({
        Error: { type: "object", properties: { message: { type: "string" } } },
        A: { properties: { e: { $ref: "#/components/schemas/Error" } } },
        B: { properties: { e: { $ref: "#/components/schemas/Error" } } },
      }),
    );
  });

  it("keeps a direct self-reference as a $ref instead of inlining it", async () => {
    // ref-parser rewrites the pointer to its path from the root and leaves the
    // object in place. Everything downstream has only ever seen this shape.
    await expectParity(
      specWith({
        Node: { $ref: "#/components/schemas/Node" },
      }),
    );
  });

  it("builds a real object cycle for an indirect self-reference", async () => {
    await expectParity(
      specWith({
        Node: {
          type: "object",
          properties: {
            children: {
              type: "array",
              items: { $ref: "#/components/schemas/Node" },
            },
          },
        },
      }),
    );
  });

  it("builds a real object cycle for a mutual reference", async () => {
    await expectParity(
      specWith({
        A: {
          type: "object",
          properties: { b: { $ref: "#/components/schemas/B" } },
        },
        B: {
          type: "object",
          properties: { a: { $ref: "#/components/schemas/A" } },
        },
      }),
    );
  });

  it("drops siblings when the target is caught in a cycle", async () => {
    // Not the same rule as the non-circular case below, which is exactly why it
    // is pinned: once the target is inside a cycle, ref-parser returns the
    // cached circular object as-is — the siblings are DROPPED and identity IS
    // shared, the reverse of both halves of the ordinary behaviour. A reading
    // of the code that assumes one rule throughout gets this backwards.
    await expectParity(
      specWith({
        A: {
          type: "object",
          properties: { b: { $ref: "#/components/schemas/B" } },
        },
        B: {
          type: "object",
          properties: { a: { $ref: "#/components/schemas/A" } },
        },
        Sib: { $ref: "#/components/schemas/A", description: "dropped" },
      }),
    );
  });

  it("merges siblings over the target, siblings winning", async () => {
    await expectParity(
      specWith({
        Base: { type: "object", description: "from target", title: "kept" },
        Extended: {
          $ref: "#/components/schemas/Base",
          description: "from sibling",
        },
      }),
    );
  });

  it("gives each extended $ref its own object rather than sharing one", async () => {
    await expectParity(
      specWith({
        Base: { type: "object" },
        One: { $ref: "#/components/schemas/Base", description: "one" },
        Two: { $ref: "#/components/schemas/Base", description: "two" },
      }),
    );
  });

  it("follows a reference to a reference", async () => {
    await expectParity(
      specWith({
        Target: { type: "string", format: "uuid" },
        Middle: { $ref: "#/components/schemas/Target" },
        Outer: { $ref: "#/components/schemas/Middle" },
      }),
    );
  });

  it("decodes ~1 and ~0 escapes in pointer tokens", async () => {
    await expectParity(
      specWith({
        "A/B": { type: "string" },
        "C~D": { type: "integer" },
        UsesSlash: { $ref: "#/components/schemas/A~1B" },
        UsesTilde: { $ref: "#/components/schemas/C~0D" },
      }),
    );
  });

  it("decodes percent-encoded pointer tokens", async () => {
    await expectParity(
      specWith({
        "a b": { type: "string" },
        Uses: { $ref: "#/components/schemas/a%20b" },
      }),
    );
  });

  it("resolves a pointer into a non-schema part of the document", async () => {
    await expectParity(
      specWith(
        { Pet: { type: "object" } },
        {
          "/pets": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Pet" },
                    },
                  },
                },
              },
            },
            post: {
              responses: {
                "200": {
                  $ref: "#/paths/~1pets/get/responses/200",
                },
              },
            },
          },
        },
      ),
    );
  });

  it("resolves a pointer whose target is null", async () => {
    await expectParity(
      specWith({
        Nulled: { type: "object", example: null },
        Uses: { $ref: "#/components/schemas/Nulled/example" },
      }),
    );
  });

  it("resolves a reference to the whole document", async () => {
    await expectParity(
      specWith({
        Whole: { type: "object", properties: {} },
      }),
    );
  });

  it("reports an unresolvable pointer rather than silently dropping it", async () => {
    // The message differs between implementations; that it throws at all does
    // not, and a resolver that returned `undefined` here would produce a mock
    // that answers with nothing.
    const spec = specWith({ Uses: { $ref: "#/components/schemas/Missing" } });
    await expect(dereferenceWithSwaggerParser(spec)).rejects.toThrow();
    expect(() => dereferenceInternal(structuredClone(spec))).toThrow();
  });
});
