import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchmockError } from "@schmock/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadDocument } from "./load-document";
import { openapi } from "./plugin";
import type { RefFetch } from "./ref-policy";

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

function specWithResponseSchema(
  schema: object,
  schemas: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "Load", version: "1.0.0" },
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

describe("loadDocument", () => {
  describe("a spec given as an http(s) URL", () => {
    const SPEC_URL = "https://specs.example.test/openapi.json";

    /** ref-parser's built-in http resolver reads through global `fetch`. */
    function stubGlobalFetch() {
      return vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("global fetch must not be reached"));
    }

    function stubTransport(body: string): ReturnType<typeof vi.fn<RefFetch>> {
      return vi.fn<RefFetch>(async () => new Response(body, { status: 200 }));
    }

    const SPEC_BODY = JSON.stringify(
      specWithResponseSchema({ type: "string" }),
    );

    afterEach(() => {
      vi.restoreAllMocks();
    });

    for (const [label, refs] of [
      ["the default policy", undefined],
      ["external refs alone", { external: true }],
    ] as const) {
      it(`is refused under ${label} before any request`, async () => {
        const globalFetch = stubGlobalFetch();
        const fetchRef = stubTransport(SPEC_BODY);

        const error = await failureOf(
          loadDocument(SPEC_URL, { refs, fetchRef }),
        );

        expect(codeOf(error)).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");
        expect((error as Error).message).toContain("allowHttp: true");
        expect(globalFetch).not.toHaveBeenCalled();
        expect(fetchRef).not.toHaveBeenCalled();
      });
    }

    // ref-parser resolves the spec path against the working directory, which
    // reads each of these over http as surely as `https://...`.
    for (const spelling of [
      "//specs.example.test/openapi.json",
      "\\\\specs.example.test\\openapi.json",
      "http:specs.example.test/openapi.json",
      "http:/specs.example.test/openapi.json",
      "HTTP:specs.example.test/openapi.json",
    ]) {
      for (const [label, refs] of [
        ["the default policy", undefined],
        ["external refs alone", { external: true }],
      ] as const) {
        it(`refuses ${spelling} under ${label} before any request`, async () => {
          const globalFetch = stubGlobalFetch();
          const fetchRef = stubTransport(SPEC_BODY);

          const error = await failureOf(
            loadDocument(spelling, { refs, fetchRef }),
          );

          expect(codeOf(error)).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");
          expect((error as Error).message).toContain("specs.example.test");
          expect(globalFetch).not.toHaveBeenCalled();
          expect(fetchRef).not.toHaveBeenCalled();
        });
      }
    }

    it("reads //host/x through the guarded transport once http refs are enabled", async () => {
      const globalFetch = stubGlobalFetch();
      const fetchRef = stubTransport(SPEC_BODY);

      await loadDocument("//specs.example.test/openapi.json", {
        refs: { external: true, allowHttp: true },
        fetchRef,
      });

      expect(fetchRef).toHaveBeenCalledTimes(1);
      expect(fetchRef.mock.calls[0][0]).toBe(SPEC_URL);
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("is read through the guarded transport once http refs are enabled", async () => {
      const globalFetch = stubGlobalFetch();
      const fetchRef = stubTransport(SPEC_BODY);

      const api = await loadDocument(SPEC_URL, {
        refs: { external: true, allowHttp: true },
        fetchRef,
      });

      expect(Object.keys(api.paths ?? {})).toEqual(["/x"]);
      expect(fetchRef).toHaveBeenCalledTimes(1);
      expect(fetchRef.mock.calls[0][0]).toBe(SPEC_URL);
      expect(globalFetch).not.toHaveBeenCalled();
    });

    for (const [label, refs, reason] of [
      [
        "a host outside allowedHosts",
        { external: true, allowHttp: true, allowedHosts: ["other.test"] },
        "is not allowed",
      ],
      [
        "a loopback host",
        { external: true, allowHttp: true },
        "loopback, link-local or private",
      ],
    ] as const) {
      it(`refuses ${label} before any request`, async () => {
        const fetchRef = stubTransport(SPEC_BODY);
        const url =
          label === "a loopback host"
            ? "http://127.0.0.1:8080/openapi.json"
            : SPEC_URL;

        const error = await failureOf(loadDocument(url, { refs, fetchRef }));

        expect(codeOf(error)).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");
        expect((error as Error).message).toContain(reason);
        expect(fetchRef).not.toHaveBeenCalled();
      });
    }

    it("is held to maxBytes, and the error names the limit", async () => {
      const fetchRef = stubTransport(SPEC_BODY);

      const error = await failureOf(
        loadDocument(SPEC_URL, {
          refs: { external: true, allowHttp: true, maxBytes: 16 },
          fetchRef,
        }),
      );

      expect((error as Error).message).toContain("above the 16 byte limit");
    });
  });

  describe("$refs to nothing", () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "schmock-missing-"));
      writeFileSync(
        join(dir, "other.json"),
        JSON.stringify({
          type: "object",
          properties: { name: { type: "string" } },
        }),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("refuses an internal one with OPENAPI_INVALID_REF, as the browser build does", async () => {
      // It used to escape as ref-parser's uncoded MissingPointerError.
      const error = await failureOf(
        loadDocument(
          specWithResponseSchema({ $ref: "#/components/schemas/Missing" }),
          {},
        ),
      );

      expect(codeOf(error)).toBe("OPENAPI_INVALID_REF");
      expect((error as Error).message).toContain('has no "Missing"');
    });

    it("refuses an internal one with the same code under strict", async () => {
      const error = await failureOf(
        loadDocument(
          specWithResponseSchema({ $ref: "#/components/schemas/Missing" }),
          { strict: true },
        ),
      );

      expect(codeOf(error)).toBe("OPENAPI_INVALID_REF");
    });

    it("refuses one into another document with the same code", async () => {
      const error = await failureOf(
        loadDocument(
          specWithResponseSchema({
            $ref: `${join(dir, "other.json")}#/definitions/Nope`,
          }),
          { refs: { external: true } },
        ),
      );

      expect(codeOf(error)).toBe("OPENAPI_INVALID_REF");
      expect((error as Error).cause).toMatchObject({ code: "EMISSINGPOINTER" });
    });

    it("leaves a pointer through another document to the resolver that reads it", async () => {
      // Nothing under `Ext` exists until ref-parser has read `other.json`, so
      // the walk before resolution must not call `properties` a miss.
      const api = (await loadDocument(
        specWithResponseSchema(
          { $ref: "#/components/schemas/Ext/properties/name" },
          { Ext: { $ref: join(dir, "other.json") } },
        ),
        { refs: { external: true } },
      )) as unknown as { paths: Record<string, any> };

      expect(
        api.paths["/x"].get.responses["200"].content["application/json"].schema,
      ).toEqual({ type: "string" });
    });
  });

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
