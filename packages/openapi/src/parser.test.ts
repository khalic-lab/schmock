import { resolve } from "node:path";
import { SchmockError } from "@schmock/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichResolverError, parseSpec } from "./parser";

const fixturesDir = resolve(import.meta.dirname, "__fixtures__");
const externalDir = `${fixturesDir}/external`;

/** The code on a SchmockError, or the message when something else was thrown. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "(resolved)";
  } catch (error) {
    return error instanceof SchmockError ? error.code : String(error);
  }
}

describe("parseSpec", () => {
  describe("Swagger 2.0", () => {
    it("parses Swagger 2.0 Petstore spec", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);

      expect(spec.title).toBe("Petstore");
      expect(spec.version).toBe("1.0.0");
      expect(spec.paths.length).toBeGreaterThan(0);
    });

    it("extracts path parameters from Swagger 2.0", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const getPet = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets/:petId",
      );

      expect(getPet).toBeDefined();
      expect(getPet?.parameters).toContainEqual(
        expect.objectContaining({
          name: "petId",
          in: "path",
          required: true,
        }),
      );
    });

    it("extracts query parameters", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const listPets = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets",
      );

      expect(listPets).toBeDefined();
      expect(listPets?.parameters).toContainEqual(
        expect.objectContaining({
          name: "limit",
          in: "query",
        }),
      );
    });

    it("extracts request body from Swagger 2.0 body parameter", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const createPet = spec.paths.find(
        (p) => p.method === "POST" && p.path === "/pets",
      );

      expect(createPet).toBeDefined();
      expect(createPet?.requestBody).toBeDefined();
      expect(createPet?.requestBody?.type).toBe("object");
      expect(createPet?.requestBodyRequired).toBe(true);
    });

    it("extracts response schemas with multiple status codes", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const listPets = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets",
      );

      expect(listPets).toBeDefined();
      expect(listPets?.responses.has(200)).toBe(true);
      expect(listPets?.responses.get(200)?.schema?.type).toBe("array");
    });

    it("converts {param} to :param in paths", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const getPet = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets/:petId",
      );
      expect(getPet).toBeDefined();
    });
  });

  describe("OpenAPI 3.0", () => {
    it("parses OpenAPI 3.0 spec", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);

      expect(spec.title).toBe("Petstore");
      expect(spec.version).toBe("2.0.0");
    });

    it("extracts request body from OpenAPI 3.x requestBody", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      const createPet = spec.paths.find(
        (p) => p.method === "POST" && p.path === "/pets",
      );

      expect(createPet).toBeDefined();
      expect(createPet?.requestBody).toBeDefined();
      expect(createPet?.requestBodyRequired).toBe(true);
    });

    it("preserves an explicit empty operation security override", async () => {
      const parsed = await parseSpec({
        openapi: "3.0.3",
        info: { title: "Security", version: "1.0.0" },
        security: [{ bearerAuth: [] }],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
          },
        },
        paths: {
          "/health": {
            get: {
              security: [],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      });

      expect(parsed.globalSecurity).toEqual([["bearerAuth"]]);
      expect(parsed.paths[0].security).toEqual([]);
    });

    it("preserves schemas for every declared response media type", async () => {
      const parsed = await parseSpec({
        openapi: "3.0.3",
        info: { title: "Media", version: "1.0.0" },
        paths: {
          "/result": {
            get: {
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": { schema: { type: "string" } },
                    "application/problem+json": {
                      schema: { type: "object", required: ["error"] },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const response = parsed.paths[0].responses.get(200);
      expect(response?.content?.get("application/json")?.schema?.type).toBe(
        "string",
      );
      expect(
        response?.content?.get("application/problem+json")?.schema?.type,
      ).toBe("object");
    });

    it("resolves $ref pointers via dereference", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      const getPet = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets/:petId",
      );

      // Should be fully resolved, no $ref
      expect(getPet?.responses.get(200)?.schema).toBeDefined();
      expect(getPet?.responses.get(200)?.schema).not.toHaveProperty("$ref");
    });

    it("merges path-level and operation-level parameters", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      const getPet = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets/:petId",
      );

      // petId is defined at path level, should be merged into operation
      expect(getPet?.parameters).toContainEqual(
        expect.objectContaining({
          name: "petId",
          in: "path",
        }),
      );
    });

    it("extracts tags", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-openapi3.json`);
      const listPets = spec.paths.find(
        (p) => p.method === "GET" && p.path === "/pets",
      );
      expect(listPets?.tags).toContain("pets");
    });
  });

  describe("OpenAPI 3.1", () => {
    it("parses OpenAPI 3.1 spec", async () => {
      const spec = await parseSpec(`${fixturesDir}/openapi31.json`);

      expect(spec.title).toBe("Simple API");
      expect(spec.version).toBe("3.1.0");
    });
  });

  describe("inline spec objects", () => {
    it("accepts inline spec object", async () => {
      const spec = await parseSpec({
        openapi: "3.0.3",
        info: { title: "Inline", version: "1.0.0" },
        paths: {
          "/hello": {
            get: {
              responses: {
                "200": {
                  description: "Hello",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { msg: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      expect(spec.title).toBe("Inline");
      expect(spec.paths).toHaveLength(1);
      expect(spec.paths[0].method).toBe("GET");
      expect(spec.paths[0].path).toBe("/hello");
    });
  });

  describe("error handling", () => {
    it("throws on invalid spec", async () => {
      await expect(parseSpec({ invalid: true })).rejects.toThrow();
    });
  });

  describe("external reference policy", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("resolves a relative external ref against the spec directory", async () => {
      const spec = await parseSpec(`${externalDir}/spec.json`, {
        refs: { external: true },
      });

      const schema = spec.paths[0].responses.get(200)?.schema;
      expect(schema).toMatchObject({
        type: "object",
        properties: { label: { type: "string" } },
      });
    });

    it("rejects external refs by default", async () => {
      const failure = parseSpec(`${externalDir}/spec.json`);

      await expect(failure).rejects.toThrow(/\.\/models\.json/);
      expect(await codeOf(parseSpec(`${externalDir}/spec.json`))).toBe(
        "OPENAPI_EXTERNAL_REF_BLOCKED",
      );
    });

    it("blocks http refs unless allowHttp is set, without calling fetch", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const httpRefSpec = {
        openapi: "3.0.3",
        info: { title: "Remote", version: "1.0.0" },
        paths: {
          "/a": {
            get: {
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: { $ref: "https://example.com/x.json#/A" },
                    },
                  },
                },
              },
            },
          },
        },
      };

      expect(
        await codeOf(parseSpec(httpRefSpec, { refs: { external: true } })),
      ).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("blocks hosts outside allowedHosts and unsafe hosts inside it", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const specFor = (url: string) => ({
        openapi: "3.0.3",
        info: { title: "Remote", version: "1.0.0" },
        paths: {
          "/a": {
            get: {
              responses: {
                "200": {
                  description: "OK",
                  content: { "application/json": { schema: { $ref: url } } },
                },
              },
            },
          },
        },
      });

      expect(
        await codeOf(
          parseSpec(specFor("https://blocked.test/models.json#/A"), {
            refs: {
              external: true,
              allowHttp: true,
              allowedHosts: ["allowed.test"],
            },
          }),
        ),
      ).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");

      // Explicitly allow-listing a loopback address must not get past the
      // unsafe-host block: our own canRead replaces the library's.
      expect(
        await codeOf(
          parseSpec(specFor("http://127.0.0.1/models.json#/A"), {
            refs: {
              external: true,
              allowHttp: true,
              allowedHosts: ["127.0.0.1"],
            },
          }),
        ),
      ).toBe("OPENAPI_EXTERNAL_REF_BLOCKED");

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("fetches an allowed http ref and inlines it", async () => {
      // The only test that reaches the custom http reader: every other ref test
      // blocks before the network, so without this the read contract with
      // ref-parser (a Promise<string> its JSON parser then consumes) is unpinned.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            Thing: { type: "object", properties: { id: { type: "string" } } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const spec = await parseSpec(
        {
          openapi: "3.0.3",
          info: { title: "Remote", version: "1.0.0" },
          paths: {
            "/things": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          $ref: "https://schemas.example.test/models.json#/Thing",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        {
          refs: {
            external: true,
            allowHttp: true,
            allowedHosts: ["schemas.example.test"],
          },
        },
      );

      expect(spec.paths[0].responses.get(200)?.schema).toMatchObject({
        type: "object",
        properties: { id: { type: "string" } },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe(
        "https://schemas.example.test/models.json",
      );
    });
  });

  describe("startup validation", () => {
    const parameterWithoutSchema = {
      openapi: "3.0.3",
      info: { title: "Lenient", version: "1.0.0" },
      paths: {
        "/items/{itemId}": {
          get: {
            parameters: [{ name: "itemId", in: "path", required: true }],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    it("tolerates an incomplete spec by default", async () => {
      const spec = await parseSpec(parameterWithoutSchema);
      expect(spec.paths).toHaveLength(1);
    });

    it("rejects the same spec with OPENAPI_INVALID_SPEC under strict", async () => {
      expect(
        await codeOf(parseSpec(parameterWithoutSchema, { strict: true })),
      ).toBe("OPENAPI_INVALID_SPEC");
    });
  });

  describe("warnings", () => {
    it("reports every silently skipped construct without failing", async () => {
      const spec = await parseSpec({
        openapi: "3.0.3",
        info: { title: "Warned", version: "1.0.0" },
        paths: {
          "/broken": "not-an-object",
          "/ok": {
            get: {
              parameters: [
                { name: "sid", in: "cookie", schema: { type: "string" } },
              ],
              responses: {
                "2xxx": { description: "unparseable status" },
                "200": {
                  description: "OK",
                  content: {
                    "application/json": { schema: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      });

      expect(spec.warnings).toHaveLength(3);
      expect(spec.warnings.join("\n")).toContain("/broken");
      expect(spec.warnings.join("\n")).toContain("2xxx");
      expect(spec.warnings.join("\n")).toContain("sid");
      // Control flow is unchanged: the valid operation still parses.
      expect(spec.paths).toHaveLength(1);
      expect(spec.paths[0].path).toBe("/ok");
    });
  });

  describe("request content maps", () => {
    it("keeps one schema per declared media type", async () => {
      const spec = await parseSpec({
        openapi: "3.0.3",
        info: { title: "Media", version: "1.0.0" },
        paths: {
          "/items": {
            post: {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["a"],
                      properties: { a: { type: "string" } },
                    },
                  },
                  "application/xml": {
                    schema: {
                      type: "object",
                      required: ["b"],
                      properties: { b: { type: "string" } },
                    },
                  },
                  "text/csv": {
                    schema: { type: "string" },
                  },
                },
              },
              responses: { "201": { description: "Created" } },
            },
          },
        },
      });

      const content = spec.paths[0].requestContent;
      expect([...(content?.keys() ?? [])]).toEqual([
        "application/json",
        "application/xml",
        "text/csv",
      ]);
      expect(content?.get("application/json")?.required).toEqual(["a"]);
      expect(content?.get("application/xml")?.required).toEqual(["b"]);
      expect(content?.get("text/csv")?.type).toBe("string");
      // Each media type owns its schema object, so the pipeline's identity-keyed
      // validator cache cannot serve one for another.
      expect(content?.get("application/json")).not.toBe(
        content?.get("application/xml"),
      );
      // The JSON-ish default stays as the no-Content-Type fallback.
      expect(spec.paths[0].requestBody?.required).toEqual(["a"]);
    });

    it("maps a media type declared without a schema to undefined", async () => {
      const spec = await parseSpec({
        openapi: "3.0.3",
        info: { title: "Media", version: "1.0.0" },
        paths: {
          "/upload": {
            post: {
              requestBody: { content: { "image/png": {} } },
              responses: { "201": { description: "Created" } },
            },
          },
        },
      });

      const content = spec.paths[0].requestContent;
      expect(content?.has("image/png")).toBe(true);
      expect(content?.get("image/png")).toBeUndefined();
    });
  });

  describe("Swagger 2.0 consumes and produces", () => {
    const swagger2 = {
      swagger: "2.0",
      info: { title: "Consumed", version: "1.0.0" },
      consumes: ["application/json", "application/xml"],
      produces: ["application/json"],
      paths: {
        "/items": {
          post: {
            parameters: [
              {
                name: "body",
                in: "body",
                required: true,
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            ],
            responses: { "201": { description: "Created" } },
          },
          get: {
            consumes: ["text/csv"],
            produces: ["application/xml"],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    it("maps root consumes onto the body schema and produces onto contentTypes", async () => {
      const spec = await parseSpec(swagger2);
      const post = spec.paths.find((p) => p.method === "POST");

      expect([...(post?.requestContent?.keys() ?? [])]).toEqual([
        "application/json",
        "application/xml",
      ]);
      expect(post?.requestContent?.get("application/xml")).toBe(
        post?.requestBody,
      );
      expect(post?.responses.get(201)?.contentTypes).toEqual([
        "application/json",
      ]);
      // Swagger 2.0 declares one schema for all media types, so no per-media
      // content map is built — that map is what makes validateResponse strict.
      expect(post?.responses.get(201)?.content).toBeUndefined();
    });

    it("lets an operation override the root consumes and produces", async () => {
      const spec = await parseSpec(swagger2);
      const get = spec.paths.find((p) => p.method === "GET");

      expect([...(get?.requestContent?.keys() ?? [])]).toEqual(["text/csv"]);
      expect(get?.responses.get(200)?.contentTypes).toEqual([
        "application/xml",
      ]);
    });

    it("leaves requestContent undefined when nothing is consumed", async () => {
      const spec = await parseSpec(`${fixturesDir}/petstore-swagger2.json`);
      const createPet = spec.paths.find(
        (p) => p.method === "POST" && p.path === "/pets",
      );

      expect(createPet?.requestContent).toBeUndefined();
    });
  });
});

describe("discriminator mapping", () => {
  /** `oneOf` $refs Cat first, but the mapping declares dog first. */
  function specWithMapping(
    mapping: Record<string, string> | undefined,
    options: {
      includeInlineBranch?: boolean;
      leadingBooleanBranch?: boolean;
      useAllOfBranches?: boolean;
    } = {},
  ): Record<string, unknown> {
    const animalSchema = (sound: "meow" | "bark") => {
      const schema = {
        type: "object",
        properties: {
          petType: { type: "string" },
          [sound]: { type: "boolean" },
        },
      };
      return options.useAllOfBranches ? { allOf: [schema] } : schema;
    };
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
      components: {
        schemas: {
          Pet: {
            oneOf: [
              ...(options.leadingBooleanBranch ? [false] : []),
              { $ref: "#/components/schemas/Cat" },
              { $ref: "#/components/schemas/Dog" },
              ...(options.includeInlineBranch
                ? [
                    {
                      type: "object",
                      properties: {
                        petType: { type: "string" },
                        scales: { type: "boolean" },
                      },
                    },
                  ]
                : []),
            ],
            discriminator: {
              propertyName: "petType",
              ...(mapping ? { mapping } : {}),
            },
          },
          Cat: animalSchema("meow"),
          Dog: animalSchema("bark"),
        },
      },
    };
  }

  async function branchEnums(
    spec: Record<string, unknown>,
  ): Promise<Array<{ marker: string; petType: unknown }>> {
    const parsed = await parseSpec(spec);
    const schema = parsed.paths[0]?.responses.get(200)?.schema;
    const branches = (schema?.oneOf ?? []) as Record<string, unknown>[];
    return branches.map((branch) => {
      const props = branch.properties as Record<
        string,
        Record<string, unknown>
      >;
      return {
        marker: "meow" in props ? "cat" : "bark" in props ? "dog" : "inline",
        petType: props.petType?.enum,
      };
    });
  }

  it("pairs a mapping with its $ref target, not with branch position", async () => {
    const enums = await branchEnums(
      specWithMapping({
        dog: "#/components/schemas/Dog",
        cat: "#/components/schemas/Cat",
      }),
    );

    expect(enums).toEqual([
      { marker: "cat", petType: ["cat"] },
      { marker: "dog", petType: ["dog"] },
    ]);
  });

  it("accepts a bare component name as the mapping target", async () => {
    const enums = await branchEnums(
      specWithMapping({ dog: "Dog", cat: "Cat" }),
    );

    expect(enums).toEqual([
      { marker: "cat", petType: ["cat"] },
      { marker: "dog", petType: ["dog"] },
    ]);
  });

  it("uses implicit component names when no mapping is declared", async () => {
    const enums = await branchEnums(specWithMapping(undefined));

    expect(enums).toEqual([
      { marker: "cat", petType: ["Cat"] },
      { marker: "dog", petType: ["Dog"] },
    ]);
  });

  it("uses explicit keys for mapped refs and implicit names for unmapped refs", async () => {
    const enums = await branchEnums(
      specWithMapping({ canine: "#/components/schemas/Dog" }),
    );

    expect(enums).toEqual([
      { marker: "cat", petType: ["Cat"] },
      { marker: "dog", petType: ["canine"] },
    ]);
  });

  it("leaves inline branches without a derivable name unconstrained", async () => {
    const enums = await branchEnums(
      specWithMapping(
        {
          dog: "#/components/schemas/Dog",
          cat: "#/components/schemas/Cat",
          reptile: "#/components/schemas/Reptile",
        },
        { includeInlineBranch: true },
      ),
    );

    expect(enums).toEqual([
      { marker: "cat", petType: ["cat"] },
      { marker: "dog", petType: ["dog"] },
      { marker: "inline", petType: undefined },
    ]);
  });

  it("keeps every mapping key that targets the same branch", async () => {
    const enums = await branchEnums(
      specWithMapping({
        dog: "#/components/schemas/Dog",
        canine: "#/components/schemas/Dog",
        cat: "#/components/schemas/Cat",
      }),
    );

    expect(enums).toEqual([
      { marker: "cat", petType: ["cat"] },
      { marker: "dog", petType: ["dog", "canine"] },
    ]);
  });

  it("adds discriminator constraints to allOf branches", async () => {
    const parsed = await parseSpec(
      specWithMapping(undefined, { useAllOfBranches: true }),
    );
    const branches = parsed.paths[0]?.responses.get(200)?.schema?.oneOf ?? [];

    expect(branches[0]).toMatchObject({
      required: ["petType"],
      properties: { petType: { enum: ["Cat"] } },
    });
    expect(branches[1]).toMatchObject({
      required: ["petType"],
      properties: { petType: { enum: ["Dog"] } },
    });
  });

  it("preserves boolean oneOf branches without shifting discriminator values", async () => {
    const parsed = await parseSpec(
      specWithMapping(undefined, { leadingBooleanBranch: true }),
    );
    const branches = parsed.paths[0]?.responses.get(200)?.schema?.oneOf ?? [];

    expect(branches[0]).toBe(false);
    expect(branches[1]).toMatchObject({
      properties: { petType: { enum: ["Cat"] } },
    });
    expect(branches[2]).toMatchObject({
      properties: { petType: { enum: ["Dog"] } },
    });
  });

  it("recovers named discriminator refs from external documents only", async () => {
    const parsed = await parseSpec(`${externalDir}/discriminator-spec.json`, {
      refs: { external: true },
    });
    const branches = parsed.paths[0]?.responses.get(200)?.schema?.oneOf ?? [];

    expect(branches[0]).toMatchObject({
      properties: { petType: { enum: ["Cat"] } },
    });
    expect(branches[1]).toMatchObject({
      properties: { petType: { enum: ["Dog"] } },
    });
    expect(branches[2]).not.toHaveProperty("properties.petType.enum");
    expect(JSON.stringify(branches[2])).not.toContain("anonymous-cat.json");
  });

  it("distinguishes equal schema names from different external documents", async () => {
    const parsed = await parseSpec(`${externalDir}/discriminator-spec.json`, {
      refs: { external: true },
    });
    const path = parsed.paths.find(
      (candidate) => candidate.path === "/colliding-cats",
    );
    const branches = path?.responses.get(200)?.schema?.oneOf ?? [];

    expect(branches[0]).toMatchObject({
      properties: { petType: { enum: ["house"] } },
    });
    expect(branches[1]).toMatchObject({
      properties: { petType: { enum: ["wild"] } },
    });
  });

  it("keeps the marker out of the normalized schema", async () => {
    const parsed = await parseSpec(
      specWithMapping({
        dog: "#/components/schemas/Dog",
        cat: "#/components/schemas/Cat",
      }),
    );
    const schema = parsed.paths[0]?.responses.get(200)?.schema;
    expect(JSON.stringify(schema)).not.toContain("x-schmock");
  });

  it("survives strict validation", async () => {
    const parsed = await parseSpec(
      specWithMapping({
        dog: "#/components/schemas/Dog",
        cat: "#/components/schemas/Cat",
      }),
      { strict: true },
    );
    const schema = parsed.paths[0]?.responses.get(200)?.schema;
    const branches = (schema?.oneOf ?? []) as Record<string, unknown>[];
    const first = branches[0]?.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(first.petType?.enum).toEqual(["cat"]);
  });
});

describe("enrichResolverError", () => {
  /** Shape ref-parser actually throws: the detail is already laundered away. */
  function resolverError(source: string): Error {
    const error = new Error(`Error reading file "${source}"`);
    Object.assign(error, { code: "ERESOLVER", source, name: "ResolverError" });
    return error;
  }

  it("appends the recorded diagnostic for the failing url", () => {
    const diagnostics = new Map([
      [
        "http://schemas.example.com/x.json",
        "external $ref http://schemas.example.com/x.json declares 99999 bytes, above the 1000 byte limit",
      ],
    ]);
    const enriched = enrichResolverError(
      resolverError("http://schemas.example.com/x.json"),
      diagnostics,
    );

    expect((enriched as Error).message).toContain("above the 1000 byte limit");
    expect((enriched as Error).message).toContain("Error reading file");
  });

  it("matches on the message when the error carries no source", () => {
    const error = new Error(
      'Error reading file "http://schemas.example.com/y.json"',
    );
    Object.assign(error, { code: "ERESOLVER" });
    const enriched = enrichResolverError(
      error,
      new Map([["http://schemas.example.com/y.json", "responded with 503"]]),
    );

    expect((enriched as Error).message).toContain("responded with 503");
  });

  it("leaves unrelated errors and empty diagnostics untouched", () => {
    const plain = new Error("boom");
    expect(enrichResolverError(plain, new Map())).toBe(plain);
    expect(enrichResolverError(plain, new Map([["u", "d"]]))).toBe(plain);

    const unknownUrl = resolverError("http://other.example.com/z.json");
    expect(
      (enrichResolverError(unknownUrl, new Map([["u", "d"]])) as Error).message,
    ).toBe('Error reading file "http://other.example.com/z.json"');
  });
});

describe("external $ref failure diagnostics", () => {
  const externalRefSpec = {
    openapi: "3.0.3",
    info: { title: "External", version: "1.0.0" },
    paths: {
      "/p": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "https://schemas.example.com/x.json" },
                },
              },
            },
          },
        },
      },
    },
  };

  const refs = {
    external: true,
    allowHttp: true,
    allowedHosts: ["schemas.example.com"],
    maxBytes: 32,
  };

  it("surfaces the resolver's own message instead of ref-parser's opaque one", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("nope", { status: 503 }));
    try {
      await expect(parseSpec(externalRefSpec, { refs })).rejects.toThrow(
        /responded with 503/,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("surfaces an over-size external $ref the same way", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("x".repeat(200)));
    try {
      await expect(parseSpec(externalRefSpec, { refs })).rejects.toThrow(
        /above the 32 byte limit/,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
