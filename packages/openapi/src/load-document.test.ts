import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchmockError, schmock } from "@schmock/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MAX_HTTP_REF_DOCUMENTS } from "./limits";
import { loadDocument } from "./load-document";
import { openapi } from "./plugin";
import { type RefFetch, resolveReference } from "./ref-policy";

/**
 * `loadDocument` end to end: what reaches the resolvers, what they are kept
 * from, and what the caller is told.
 */

const MARKER = "x-schmock-discriminator-values";

/** What `promise` rejected with, or `undefined` when it resolved. */
async function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

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

    // 1e300 is finite, but above the 2^53 - 1 AbortSignal.timeout accepts.
    for (const timeoutMs of [Number.POSITIVE_INFINITY, -1, Number.NaN, 1e300]) {
      it(`refuses timeoutMs ${timeoutMs} as an invalid option before any request`, async () => {
        const fetchRef = stubTransport(SPEC_BODY);

        const error = await failureOf(
          loadDocument(SPEC_URL, {
            refs: { external: true, allowHttp: true, timeoutMs },
            fetchRef,
          }),
        );

        expect(codeOf(error)).toBe("OPENAPI_INVALID_OPTION");
        expect((error as SchmockError).context).toEqual({
          option: "refs",
          field: "timeoutMs",
        });
        expect((error as Error).message).toContain("refs.timeoutMs");
        expect(fetchRef).not.toHaveBeenCalled();
      });
    }

    // NaN makes every `>`/`>=` against the limit false, so the size and
    // redirect limits silently vanished.
    for (const field of ["redirects", "maxBytes"] as const) {
      for (const value of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
        it(`refuses ${field} ${value} as an invalid option before any request`, async () => {
          const fetchRef = stubTransport(SPEC_BODY);

          const error = await failureOf(
            loadDocument(SPEC_URL, {
              refs: { external: true, allowHttp: true, [field]: value },
              fetchRef,
            }),
          );

          expect(codeOf(error)).toBe("OPENAPI_INVALID_OPTION");
          expect((error as SchmockError).context).toEqual({
            option: "refs",
            field,
          });
          expect(fetchRef).not.toHaveBeenCalled();
        });
      }
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

  describe("http refs not spelled http(s)://", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    for (const ref of [
      "//169.254.169.254/latest/meta-data",
      "\\\\169.254.169.254\\latest\\meta-data",
      "http:/169.254.169.254/latest/meta-data",
      "http:169.254.169.254/latest/meta-data",
      "HTTP:169.254.169.254/latest/meta-data",
    ]) {
      for (const [refs, reason] of [
        [{ external: true }, "http(s) reference resolution is disabled"],
        [
          { external: true, allowHttp: true },
          "loopback, link-local or private",
        ],
      ] as const) {
        it(`refuses ${ref} with the policy's code${refs.allowHttp ? " under allowHttp" : ""}`, async () => {
          // ref-parser reads every one of these as http(s)://169.254.169.254;
          // the pre-scan used to wave them through as file paths.
          const fetchRef = vi.fn<RefFetch>();
          vi.spyOn(globalThis, "fetch").mockRejectedValue(
            new Error("global fetch must not be reached"),
          );

          const error = await failureOf(
            loadDocument(specWithResponseSchema({ $ref: ref }), {
              refs,
              fetchRef,
            }),
          );

          expect(codeOf(error)).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");
          expect((error as Error).message).toContain(reason);
          expect(fetchRef).not.toHaveBeenCalled();
        });
      }
    }
  });

  describe("a chain of http $ref documents", () => {
    it("stops after a bounded number of documents per load", async () => {
      // Each document refers to the next, past the limit: a misbehaving
      // allowed host. Finite only so the test ends if the limit is missing.
      const length = MAX_HTTP_REF_DOCUMENTS + 10;
      const fetchRef = vi.fn<RefFetch>(async (url) => {
        const n = Number(/\/d\/(\d+)\.json$/.exec(url)?.[1]);
        const next = `https://schemas.example.test/d/${n + 1}.json`;
        return new Response(
          JSON.stringify(
            n < length
              ? { type: "object", properties: { next: { $ref: next } } }
              : { type: "string" },
          ),
          { status: 200 },
        );
      });

      const error = await settle(
        loadDocument(
          specWithResponseSchema({
            $ref: "https://schemas.example.test/d/1.json",
          }),
          {
            refs: {
              external: true,
              allowHttp: true,
              allowedHosts: ["schemas.example.test"],
            },
            fetchRef,
          },
        ),
      );

      expect(fetchRef).toHaveBeenCalledTimes(MAX_HTTP_REF_DOCUMENTS);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `limit of ${MAX_HTTP_REF_DOCUMENTS} http documents`,
      );
    });

    it("counts a document whose read failed against the same limit", async () => {
      // More sibling refs than the limit, every one answered 404: a failed
      // read still spent a request, so it has to spend the budget too.
      const count = MAX_HTTP_REF_DOCUMENTS + 10;
      const fetchRef = vi.fn<RefFetch>(
        async () => new Response("missing", { status: 404 }),
      );
      const properties: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        properties[`p${i}`] = {
          $ref: `https://schemas.example.test/missing/${i}.json`,
        };
      }

      const error = await settle(
        loadDocument(specWithResponseSchema({ type: "object", properties }), {
          refs: {
            external: true,
            allowHttp: true,
            allowedHosts: ["schemas.example.test"],
          },
          fetchRef,
        }),
      );
      // ref-parser starts every sibling read before the first rejection
      // settles the load; let the ones still in flight reach the transport.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(error).toBeInstanceOf(Error);
      expect(fetchRef).toHaveBeenCalledTimes(MAX_HTTP_REF_DOCUMENTS);
    });
  });

  describe("refs.timeoutMs on a spec without http refs", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    for (const [label, refs] of [
      ["allowHttp", { external: true, allowHttp: true, timeoutMs: 10 }],
      ["external refs alone", { external: true, timeoutMs: 10 }],
      ["external refs off", { timeoutMs: 10 }],
    ] as const) {
      it(`does not cap how long dereferencing local refs may take under ${label}`, async () => {
        const schemas: Record<string, unknown> = {
          Leaf: { type: "string" },
        };
        for (let i = 0; i < 50; i++) {
          schemas[`S${i}`] = {
            type: "object",
            properties: { leaf: { $ref: "#/components/schemas/Leaf" } },
          };
        }
        const spec = specWithResponseSchema(
          { $ref: "#/components/schemas/S0" },
          schemas,
        );
        // A slow machine, made deterministic: every clock read is 50 ms on.
        let now = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => {
          now += 50;
          return now;
        });

        // timeoutMs is per http request; there is none here, so it bounds
        // nothing. It used to become ref-parser's whole-dereference budget.
        const api = await loadDocument(spec, { refs });

        expect(Object.keys(api.paths ?? {})).toEqual(["/x"]);
      });
    }
  });

  describe("a $ref ending in a long whitespace run", () => {
    it("is refused by the policy pre-scan in linear time", async () => {
      // 100k spaces before one other character: a backtracking `\s*$` scan
      // took seconds on this before the refusal was reached.
      const ref = `${" ".repeat(100_000)}x`;
      const started = performance.now();

      const error = await failureOf(
        loadDocument(specWithResponseSchema({ $ref: ref }), {}),
      );

      expect(codeOf(error)).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");
      expect(performance.now() - started).toBeLessThan(1_000);
    }, 30_000);

    it("keeps the trailing whitespace ref-parser keeps", () => {
      expect(resolveReference("/specs/api.yaml", "pet.json \t\n")).toBe(
        "/specs/pet.json \t\n",
      );
      expect(
        resolveReference(
          "https://schemas.example.com/v1/api.json",
          "pet.json  ",
        ),
      ).toBe("https://schemas.example.com/v1/pet.json  ");
      // URL drops leading whitespace from the reference; the trailing run
      // is still measured from the end of the ref as spelled.
      expect(resolveReference("/specs/api.yaml", "  pet.json \t")).toBe(
        "/specs/pet.json \t",
      );
    });
  });

  describe("an http $ref inside a nested local document", () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "schmock-nested-http-"));
      writeFileSync(
        join(dir, "root.json"),
        JSON.stringify(specWithResponseSchema({ $ref: "./pet.json" })),
      );
      writeFileSync(
        join(dir, "pet.json"),
        JSON.stringify({
          type: "object",
          properties: { owner: { $ref: "https://127.0.0.1/owner.json" } },
        }),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    for (const [label, refs, reason] of [
      [
        "external refs alone",
        { external: true },
        "http(s) reference resolution is disabled",
      ],
      [
        "allowHttp, for a loopback host",
        { external: true, allowHttp: true },
        "loopback, link-local or private",
      ],
      [
        "allowHttp, for a host outside allowedHosts",
        { external: true, allowHttp: true, allowedHosts: ["example.com"] },
        'host "127.0.0.1" is not allowed',
      ],
    ] as const) {
      it(`is refused with the policy's code under ${label}`, async () => {
        // The pre-scan sees only the root document; this ref is reached
        // through pet.json and used to fail as ref-parser's uncoded
        // "Unable to resolve $ref pointer".
        const fetchRef = vi.fn<RefFetch>();
        vi.spyOn(globalThis, "fetch").mockRejectedValue(
          new Error("global fetch must not be reached"),
        );

        const error = await failureOf(
          loadDocument(join(dir, "root.json"), { refs, fetchRef }),
        );

        expect(codeOf(error)).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");
        expect((error as Error).message).toContain(
          "https://127.0.0.1/owner.json",
        );
        expect((error as Error).message).toContain(reason);
        expect((error as SchmockError).context).toMatchObject({
          refs: ["https://127.0.0.1/owner.json"],
        });
        expect(fetchRef).not.toHaveBeenCalled();
      });
    }
  });

  describe("an empty $ref", () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "schmock-empty-ref-"));
      writeFileSync(
        join(dir, "root.json"),
        JSON.stringify(specWithResponseSchema({ $ref: "./pet.json" })),
      );
      writeFileSync(
        join(dir, "pet.json"),
        JSON.stringify({
          type: "object",
          properties: { owner: { $ref: "" } },
        }),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    for (const [label, refs] of [
      ["the default policy", undefined],
      ["external refs", { external: true }],
    ] as const) {
      it(`is refused as an invalid ref, not an external one, under ${label}`, async () => {
        // It used to be reported as an external ref with a blank name, and
        // under external: true the error advised enabling external: true.
        const error = await failureOf(
          loadDocument(specWithResponseSchema({ $ref: "" }), { refs }),
        );

        expect(codeOf(error)).toBe("OPENAPI_INVALID_REF");
        expect((error as Error).message).toContain("empty $ref");
        expect((error as Error).message).not.toContain("Enable them");
      });
    }

    it("is refused the same way inside a nested document", async () => {
      const error = await failureOf(
        loadDocument(join(dir, "root.json"), { refs: { external: true } }),
      );

      expect(codeOf(error)).toBe("OPENAPI_INVALID_REF");
      expect((error as Error).message).toContain("empty $ref");
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

  describe("a spec object that is already dereferenced", () => {
    it("serves a schema that holds itself as an object cycle", async () => {
      // What `SwaggerParser.dereference` hands back for a recursive spec.
      const node: Record<string, any> = {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          children: { type: "array", maxItems: 0, items: {} },
        },
      };
      node.properties.children.items = node;
      const spec = specWithResponseSchema(node, { Node: node });

      const mock = schmock();
      mock.pipe(await openapi({ spec }));
      const response = await mock.handle("GET", "/x");

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("name");
    });
  });

  describe("siblings beside an external $ref", () => {
    let dir: string;
    const name = { type: "string", maxLength: 50, description: "orig" };
    const extended = (ref: string) => ({
      $ref: ref,
      maxLength: 3,
      description: "over",
    });
    /** `first` names the target bare and comes before `second`. */
    const pair = (ref: string) => ({
      type: "object",
      properties: { first: { $ref: ref }, second: extended(ref) },
    });

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "schmock-siblings-"));
      writeFileSync(join(dir, "name.json"), JSON.stringify(name));
      writeFileSync(
        join(dir, "pair.json"),
        JSON.stringify(pair("./name.json")),
      );
      writeFileSync(
        join(dir, "root.json"),
        JSON.stringify(specWithResponseSchema(pair("./name.json"))),
      );
      writeFileSync(
        join(dir, "nested.json"),
        JSON.stringify(specWithResponseSchema({ $ref: "./pair.json" })),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    for (const file of ["root.json", "nested.json"]) {
      it(`lets them win after a bare $ref to the same file (${file})`, async () => {
        const api = (await loadDocument(join(dir, file), {
          refs: { external: true },
        })) as unknown as { paths: Record<string, any> };

        const schema =
          api.paths["/x"].get.responses["200"].content["application/json"]
            .schema;
        expect(schema.properties.first).toEqual(name);
        expect(schema.properties.second).toEqual({
          type: "string",
          maxLength: 3,
          description: "over",
        });
      });
    }
  });

  describe("literal data in another document", () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "schmock-literal-"));
      const literal = { doc: { $ref: "#/definitions/Whatever" } };
      writeFileSync(
        join(dir, "openapi.json"),
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Split", version: "1.0.0" },
          paths: { "/pets": { $ref: "./pets.json#/PetsPath" } },
        }),
      );
      writeFileSync(
        join(dir, "pets.json"),
        JSON.stringify({
          PetsPath: {
            get: {
              "x-codeSamples": [
                { lang: "js", source: { $ref: "./missing-sample.js" } },
              ],
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { type: "object", default: literal },
                      example: literal,
                    },
                  },
                },
              },
            },
          },
        }),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("keeps a $ref-shaped example, default and x-* value as data", async () => {
      const api = (await loadDocument(join(dir, "openapi.json"), {
        refs: { external: true },
      })) as unknown as { paths: Record<string, any> };

      const get = api.paths["/pets"].get;
      const media = get.responses["200"].content["application/json"];
      expect(media.example).toEqual({
        doc: { $ref: "#/definitions/Whatever" },
      });
      expect(media.schema.default).toEqual({
        doc: { $ref: "#/definitions/Whatever" },
      });
      expect(get["x-codeSamples"][0].source).toEqual({
        $ref: "./missing-sample.js",
      });
    });

    it("reads another document's examples by the root's Swagger 2.0 rules", async () => {
      // The sub-file has no `swagger` key of its own. Read as OAS 3, its
      // `examples` would be a map of Reference Objects and the `$ref` would
      // be followed to a file that does not exist.
      writeFileSync(
        join(dir, "swagger.json"),
        JSON.stringify({
          swagger: "2.0",
          info: { title: "Split", version: "1.0.0" },
          paths: { "/pets": { $ref: "./pets2.json#/PetsPath" } },
        }),
      );
      writeFileSync(
        join(dir, "pets2.json"),
        JSON.stringify({
          PetsPath: {
            get: {
              produces: ["application/json"],
              responses: {
                "200": {
                  description: "ok",
                  schema: { type: "object" },
                  examples: {
                    "application/json": { $ref: "./missing-example.json" },
                  },
                },
              },
            },
          },
        }),
      );

      const api = (await loadDocument(join(dir, "swagger.json"), {
        refs: { external: true },
      })) as unknown as { paths: Record<string, any> };

      expect(
        api.paths["/pets"].get.responses["200"].examples["application/json"],
      ).toEqual({ $ref: "./missing-example.json" });
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

      for (const pointer of [
        "#/__proto__",
        "#/a/constructor/prototype",
        "#/a/constructor",
      ]) {
        it(`refuses ${pointer} without writing onto a built-in`, async () => {
          // The preflight only sees the root document; ref-parser resolves a
          // pointer into another file on its own, so the result is checked.
          const spec = specWithDiscriminatorRef(
            `${join(dir, "other.json")}${pointer}`,
          );

          const error = await failureOf(
            loadDocument(spec, { refs: { external: true } }),
          );

          expect(codeOf(error)).toBe("OPENAPI_INVALID_REF");
          expect(isPolluted()).toBe(false);
          expect(Object.hasOwn(Number.prototype, MARKER)).toBe(false);
        });
      }

      it("refuses one through the public openapi() entry point", async () => {
        const error = await failureOf(
          openapi({
            spec: specWithDiscriminatorRef(
              `${join(dir, "other.json")}#/__proto__`,
            ),
            refs: { external: true },
          }),
        );

        expect(codeOf(error)).toBe("OPENAPI_INVALID_REF");
      });
    });
  });

  describe("discriminators beside anyOf", () => {
    const animal = (sound: "meow" | "bark") => ({
      type: "object",
      required: ["petType", sound],
      properties: {
        petType: { type: "string" },
        [sound]: { type: "boolean" },
      },
    });

    /** `anyOf` lists Cat first; a mapping, when given, lists dog first. */
    function anyOfPetSpec(
      pet: Record<string, unknown>,
      schemas: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        openapi: "3.0.3",
        info: { title: "Pets", version: "1.0.0" },
        paths: {
          "/pet": {
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
        components: { schemas: { Pet: pet, ...schemas } },
      };
    }

    const refBranches = [
      { $ref: "#/components/schemas/Cat" },
      { $ref: "#/components/schemas/Dog" },
    ];

    async function markerOf(
      spec: Record<string, unknown>,
      keyword = "anyOf",
    ): Promise<unknown> {
      const api = (await loadDocument(spec, {})) as unknown as {
        components: {
          schemas: { Pet: { discriminator: Record<string, unknown> } };
        };
      };
      expect(api.components.schemas.Pet).toHaveProperty(keyword);
      return api.components.schemas.Pet.discriminator[MARKER];
    }

    it("names $ref branches by their mapping keys", async () => {
      const spec = anyOfPetSpec(
        {
          anyOf: refBranches,
          discriminator: {
            propertyName: "petType",
            mapping: {
              dog: "#/components/schemas/Dog",
              cat: "#/components/schemas/Cat",
            },
          },
        },
        { Cat: animal("meow"), Dog: animal("bark") },
      );

      expect(await markerOf(spec)).toEqual([["cat"], ["dog"]]);
    });

    it("names $ref branches by their component names without a mapping", async () => {
      const spec = anyOfPetSpec(
        { anyOf: refBranches, discriminator: { propertyName: "petType" } },
        { Cat: animal("meow"), Dog: animal("bark") },
      );

      expect(await markerOf(spec)).toEqual([["Cat"], ["Dog"]]);
    });

    it("names branches that are the component objects themselves", async () => {
      const cat = animal("meow");
      const dog = animal("bark");
      const spec = anyOfPetSpec(
        { anyOf: [cat, dog], discriminator: { propertyName: "petType" } },
        { Cat: cat, Dog: dog },
      );

      expect(await markerOf(spec)).toEqual([["Cat"], ["Dog"]]);
    });

    it("names component-object branches of an inline owner by its mapping", async () => {
      // The owner sits inline in a response, so it has no name of its own to
      // resolve the mapping against; the mapping still holds.
      const cat = animal("meow");
      const dog = animal("bark");
      const owner = {
        anyOf: [cat, dog],
        discriminator: {
          propertyName: "petType",
          mapping: {
            dog: "#/components/schemas/Dog",
            cat: "#/components/schemas/Cat",
          },
        },
      };
      const spec = specWithResponseSchema(owner, { Cat: cat, Dog: dog });

      const api = (await loadDocument(spec, {})) as unknown as {
        paths: Record<string, any>;
      };
      const loaded =
        api.paths["/x"].get.responses["200"].content["application/json"].schema;
      expect(loaded.discriminator[MARKER]).toEqual([["cat"], ["dog"]]);
    });

    it("names thousands of component-object branches in linear time", async () => {
      // Each branch used to filter the whole mapping, resolving every target
      // as a URL again: 2,000 branches took seconds.
      const count = 3000;
      const schemas: Record<string, unknown> = {};
      const branches: unknown[] = [];
      const mapping: Record<string, string> = {};
      for (let i = 0; i < count; i++) {
        const schema = { type: "object" };
        schemas[`S${i}`] = schema;
        branches.push(schema);
        mapping[`v${i}`] = `#/components/schemas/S${i}`;
      }
      const spec = anyOfPetSpec(
        { oneOf: branches, discriminator: { propertyName: "kind", mapping } },
        schemas,
      );

      const started = performance.now();
      const marker = (await markerOf(spec, "oneOf")) as string[][];
      const elapsed = performance.now() - started;

      expect(marker[0]).toEqual(["v0"]);
      expect(marker[count - 1]).toEqual([`v${count - 1}`]);
      expect(elapsed).toBeLessThan(1500);
    });

    it("aligns the marker with oneOf when a node declares both", async () => {
      const spec = anyOfPetSpec(
        {
          oneOf: [{ $ref: "#/components/schemas/Dog" }],
          anyOf: [{ $ref: "#/components/schemas/Cat" }],
          discriminator: { propertyName: "petType" },
        },
        { Cat: animal("meow"), Dog: animal("bark") },
      );

      expect(await markerOf(spec, "oneOf")).toEqual([["Dog"]]);
    });

    it("generates each branch with its own discriminator value", async () => {
      const spec = anyOfPetSpec(
        {
          anyOf: refBranches,
          discriminator: {
            propertyName: "petType",
            mapping: {
              dog: "#/components/schemas/Dog",
              cat: "#/components/schemas/Cat",
            },
          },
        },
        { Cat: animal("meow"), Dog: animal("bark") },
      );

      const seen = new Set<unknown>();
      for (let fakerSeed = 0; fakerSeed < 12; fakerSeed++) {
        const mock = schmock();
        mock.pipe(await openapi({ spec: structuredClone(spec), fakerSeed }));
        const response = await mock.handle("GET", "/pet");
        const pet = response.body as Record<string, unknown>;
        expect(response.status).toBe(200);
        expect(pet.petType).toBe("meow" in pet ? "cat" : "dog");
        seen.add(pet.petType);
      }
      expect(seen).toEqual(new Set(["cat", "dog"]));
    });
  });
});
