import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchmockError } from "@schmock/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadDocument } from "./load-document";
import { openapi } from "./plugin";

/**
 * `loadDocument` end to end: what reaches the resolvers, what they are kept
 * from, and what the caller is told.
 */

const MARKER = "x-schmock-discriminator-values";

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function codeOf(error: unknown): string | undefined {
  return error instanceof SchmockError ? error.code : undefined;
}

function isPolluted(): boolean {
  return Object.hasOwn(Object.prototype, MARKER);
}

/**
 * A spec whose unused `Poisoned` schema has a discriminator that is a bare
 * `$ref` to `pointer`, and a `oneOf` branch that IS the `Dog` component — a
 * shared object, as a JS-built spec or a YAML alias produces. The branch is
 * not a `$ref`, so the pre-dereference pass writes no marker and the
 * discriminator reaches the resolver as a bare `$ref`.
 */
function specWithDiscriminatorRef(pointer: string): Record<string, unknown> {
  const dog = {
    type: "object",
    required: ["petType"],
    properties: { petType: { type: "string" } },
  };
  return {
    openapi: "3.0.3",
    info: { title: "Proto", version: "1.0.0" },
    paths: {
      "/ping": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: {} } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Dog: dog,
        Alias: { $ref: "#/components/schemas/Dog" },
        Poisoned: { oneOf: [dog], discriminator: { $ref: pointer } },
      },
    },
  };
}

/**
 * `depth` nested `"a/a"` keys under `components.schemas.Deep`, and a response
 * schema reaching the `leaf` inside the innermost one through a pointer that
 * leaves every slash unescaped: 2 * depth + 4 tokens, each `a/a` pair
 * re-joined into one key.
 */
function specWithSlashChain(depth: number): Record<string, unknown> {
  let deep: Record<string, unknown> = {
    leaf: { type: "string", maxLength: 7 },
  };
  for (let i = 0; i < depth; i++) deep = { "a/a": deep };
  return {
    openapi: "3.0.3",
    info: { title: "Slashes", version: "1.0.0" },
    paths: {
      "/x": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    $ref: `#/components/schemas/Deep${"/a/a".repeat(depth)}/leaf`,
                  },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Deep: deep } },
  };
}

describe("loadDocument", () => {
  describe("pointer length", () => {
    it("refuses a pointer of more than 64 tokens before either resolver runs", async () => {
      // ref-parser re-joins slash-split keys by trying every run of tokens
      // from the longest down: this spec held the event loop for seconds.
      const started = performance.now();
      const error = await failureOf(loadDocument(specWithSlashChain(1000), {}));

      expect(codeOf(error)).toBe("OPENAPI_INVALID_REF");
      expect((error as Error).message).toContain("more than the 64");
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it("re-joins many pointers into one slash-keyed container in linear time", async () => {
      // The preflight walks every internal pointer before ref-parser runs, so
      // a scan of the container's keys on every re-join made the Node build
      // quadratic in the number of such pointers too.
      const count = 50_000;
      const keyed: Record<string, unknown> = {};
      const properties: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        keyed[`a/${i}`] = { type: "integer", const: i };
        properties[`p${i}`] = { $ref: `#/components/schemas/Keyed/a/${i}` };
      }
      const spec = specWithResponseSchema(
        { type: "object", properties },
        { Keyed: keyed },
      );

      const started = performance.now();
      const api = (await loadDocument(spec, {})) as unknown as {
        paths: Record<string, any>;
      };
      const elapsed = performance.now() - started;

      const schema =
        api.paths["/x"].get.responses["200"].content["application/json"].schema;
      expect(schema.properties[`p${count - 1}`]).toEqual({
        type: "integer",
        const: count - 1,
      });
      expect(elapsed).toBeLessThan(4000);
    });

    it("still resolves a pointer of exactly 64 tokens", async () => {
      const api = (await loadDocument(
        specWithSlashChain(30),
        {},
      )) as unknown as {
        paths: Record<string, any>;
      };

      expect(
        api.paths["/x"].get.responses["200"].content["application/json"].schema,
      ).toEqual({ type: "string", maxLength: 7 });
    });
  });

  describe("pointers through inherited names", () => {
    afterEach(() => {
      // A regression must not poison every later test in this worker.
      Reflect.deleteProperty(Object.prototype, MARKER);
    });

    for (const pointer of [
      "#/__proto__",
      "#/components/__proto__",
      "#/constructor/prototype",
      "#/components/schemas/Alias/__proto__",
    ]) {
      it(`refuses ${pointer} without touching Object.prototype`, async () => {
        const error = await failureOf(
          loadDocument(specWithDiscriminatorRef(pointer), {}),
        );

        expect(codeOf(error)).toBe("OPENAPI_INVALID_REF");
        expect(isPolluted()).toBe(false);
      });
    }

    it("refuses one through the public openapi() entry point", async () => {
      const error = await failureOf(
        openapi({ spec: specWithDiscriminatorRef("#/__proto__") }),
      );

      expect(codeOf(error)).toBe("OPENAPI_INVALID_REF");
      expect(isPolluted()).toBe(false);
    });

    it("still resolves a schema the document genuinely names constructor", async () => {
      const spec = specWithDiscriminatorRef("#/components/schemas/constructor");
      const schemas = (spec.components as Record<string, unknown>)
        .schemas as Record<string, unknown>;
      schemas.constructor = { propertyName: "petType" };

      const api = (await loadDocument(spec, {})) as unknown as {
        components: { schemas: { Poisoned: { discriminator: unknown } } };
      };

      expect(api.components.schemas.Poisoned.discriminator).toMatchObject({
        propertyName: "petType",
      });
      expect(isPolluted()).toBe(false);
    });

    describe("in an external document", () => {
      let dir: string;

      beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "schmock-proto-"));
        writeFileSync(join(dir, "other.json"), JSON.stringify({ a: 1 }));
      });

      afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
      });

      it("never writes the discriminator marker onto a built-in prototype", async () => {
        // The preflight only sees the root document; ref-parser resolves a
        // pointer into another file on its own, so the write site has to hold.
        const spec = specWithDiscriminatorRef(
          `${join(dir, "other.json")}#/__proto__`,
        );

        await loadDocument(spec, { refs: { external: true } }).catch(
          () => undefined,
        );

        expect(isPolluted()).toBe(false);
      });
    });
  });
});
