import { resolve } from "node:path";
import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";
import {
  NORMALIZED_BODY_STATE_KEY,
  normalizeRequestBody,
  readRequestBody,
} from "./request-body";
import {
  createBodyValidatorContext,
  validateRequestBody,
} from "./request-pipeline";

type OpenApiVersion = "3.0.3" | "3.1.0";

function specWithRequestContent(
  content: Record<string, unknown>,
  version: OpenApiVersion = "3.0.3",
) {
  return {
    openapi: version,
    info: { title: "request bodies", version: "1.0.0" },
    paths: {
      "/uploads": {
        post: {
          requestBody: { required: true, content },
          responses: {
            "201": {
              description: "stored",
              content: {
                "application/json": { schema: { type: "object" } },
              },
            },
          },
        },
      },
    },
  };
}

async function validatingMock(
  content: Record<string, unknown>,
  version?: OpenApiVersion,
): Promise<Schmock.CallableMockInstance> {
  const mock = schmock();
  mock.pipe(
    await openapi({
      spec: specWithRequestContent(content, version),
      validateRequests: true,
    }),
  );
  return mock;
}

/** POST through the fetch interceptor, the path React, Vue and the relay use. */
async function interceptedPost(
  mock: Schmock.CallableMockInstance,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const handle = mock.intercept({ passthrough: false });
  try {
    const response = await fetch("http://localhost/uploads", {
      method: "POST",
      ...init,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : text };
  } finally {
    handle.restore();
  }
}

const octetStream = { "content-type": "application/octet-stream" };

describe("request body validation", () => {
  describe("raw binary uploads", () => {
    it.each([
      [
        "3.0 nullable: true",
        "3.0.3" as const,
        { type: "string", format: "binary", nullable: true },
      ],
      [
        "3.1 type: [string, null]",
        "3.1.0" as const,
        { type: ["string", "null"], format: "binary" },
      ],
    ])("accepts bytes for a %s binary schema", async (_, version, schema) => {
      const mock = await validatingMock(
        { "application/octet-stream": { schema } },
        version,
      );

      const direct = await mock.handle("POST", "/uploads", {
        body: new Uint8Array([1, 2, 3]).buffer,
        headers: octetStream,
      });
      expect(direct.status).toBe(201);

      const intercepted = await interceptedPost(mock, {
        body: new Uint8Array([1, 2, 3]),
        headers: octetStream,
      });
      expect(intercepted.status).toBe(201);
    });
  });

  describe("multipart forms", () => {
    const uploadSchema = {
      type: "object",
      required: ["name", "file"],
      properties: {
        name: { type: "string", maxLength: 8 },
        count: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
        file: { type: "string", format: "binary" },
        attachments: {
          type: "array",
          items: { type: "string", format: "binary" },
        },
      },
    };
    const multipart = { "multipart/form-data": { schema: uploadSchema } };

    function upload(fields: Array<[string, string | Blob]>): FormData {
      const form = new FormData();
      for (const [name, value] of fields) {
        if (typeof value === "string") form.append(name, value);
        else form.append(name, value, `${name}.bin`);
      }
      return form;
    }

    const file = () => new Blob([new Uint8Array([1, 2, 3])]);

    it("accepts a valid upload sent through the fetch interceptor", async () => {
      const mock = await validatingMock(multipart);

      const result = await interceptedPost(mock, {
        body: upload([
          ["name", "Rex"],
          ["count", "3"],
          ["file", file()],
        ]),
      });

      expect(result.status).toBe(201);
    });

    it("accepts a valid upload handed to mock.handle() as FormData", async () => {
      const mock = await validatingMock(multipart);

      const response = await mock.handle("POST", "/uploads", {
        body: upload([
          ["name", "Rex"],
          ["file", file()],
        ]),
        headers: { "content-type": "multipart/form-data; boundary=x" },
      });

      expect(response.status).toBe(201);
    });

    it("checks every field's property schema, not only required ones", async () => {
      const mock = await validatingMock({
        "multipart/form-data": {
          schema: { ...uploadSchema, required: [] },
        },
      });

      const result = await interceptedPost(mock, {
        body: upload([
          ["name", "much-too-long"],
          ["count", "not-a-number"],
        ]),
      });

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        code: "VALIDATION_ERROR",
        details: expect.arrayContaining([
          expect.objectContaining({ path: "/name", keyword: "maxLength" }),
          expect.objectContaining({ path: "/count", keyword: "type" }),
        ]),
      });
    });

    it("reports a missing required field by name", async () => {
      const mock = await validatingMock(multipart);

      const result = await interceptedPost(mock, {
        body: upload([["name", "Rex"]]),
      });

      expect(result.status).toBe(400);
      expect(JSON.stringify(result.body)).toContain(
        "must have required property 'file'",
      );
      expect(JSON.stringify(result.body)).not.toContain(
        "must have required property 'name'",
      );
    });

    it("reads a repeated name as an array of its values", async () => {
      const mock = await validatingMock(multipart);

      const result = await interceptedPost(mock, {
        body: upload([
          ["name", "Rex"],
          ["file", file()],
          ["tags", "a"],
          ["tags", "b"],
          ["attachments", file()],
          ["attachments", file()],
        ]),
      });

      expect(result.status).toBe(201);
    });

    it("still rejects a file sent for a field that is not binary", async () => {
      const mock = await validatingMock(multipart);

      const result = await interceptedPost(mock, {
        body: upload([
          ["name", "Rex"],
          ["file", file()],
          ["count", file()],
        ]),
      });

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        details: [expect.objectContaining({ path: "/count" })],
      });
    });

    it.each([
      ["minLength: 1", { minLength: 1 }, 201],
      ["maxLength: 3", { maxLength: 3 }, 201],
      ["maxLength: 2", { maxLength: 2 }, 400],
      ["minLength: 4", { minLength: 4 }, 400],
    ])(
      "checks a 3-byte file against %s by its size",
      async (_, bounds, status) => {
        const mock = await validatingMock({
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: {
                file: { type: "string", format: "binary", ...bounds },
              },
            },
          },
        });

        const result = await interceptedPost(mock, {
          body: upload([["file", file()]]),
        });

        expect(result.status).toBe(status);
      },
    );
  });

  describe("urlencoded forms", () => {
    const formSchema = {
      type: "object",
      properties: {
        qty: { type: "integer" },
        active: { type: "boolean" },
        price: { type: "number" },
        note: { type: "integer", nullable: true },
        tags: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
    };
    const urlencoded = {
      "application/x-www-form-urlencoded": { schema: formSchema },
    };

    it("coerces integer, number and boolean fields by their schema", async () => {
      const mock = await validatingMock(urlencoded);

      const result = await interceptedPost(mock, {
        body: new URLSearchParams("qty=3&active=true&price=9.5&name=007"),
      });

      expect(result.status).toBe(201);
    });

    it("reads one value of an array field as a one-element array", async () => {
      const mock = await validatingMock(urlencoded);

      const result = await interceptedPost(mock, {
        body: new URLSearchParams("tags=a"),
      });

      expect(result.status).toBe(201);
    });

    it("reads an empty value of a nullable field as null", async () => {
      const mock = await validatingMock(urlencoded);

      const result = await interceptedPost(mock, {
        body: new URLSearchParams("note="),
      });

      expect(result.status).toBe(201);
    });

    it.each(["abc", "", "1e3", "0x10", " 7 ", "Infinity", "1.5"])(
      "rejects qty=%j for an integer field",
      async (qty) => {
        const mock = await validatingMock(urlencoded);

        const result = await interceptedPost(mock, {
          body: new URLSearchParams({ qty }),
        });

        expect(result.status).toBe(400);
        expect(result.body).toMatchObject({
          details: [expect.objectContaining({ path: "/qty", keyword: "type" })],
        });
      },
    );

    it("rejects a boolean field spelled other than true or false", async () => {
      const mock = await validatingMock(urlencoded);

      const result = await interceptedPost(mock, {
        body: new URLSearchParams("active=yes"),
      });

      expect(result.status).toBe(400);
    });

    describe("a field that is a number or a restricted string", () => {
      const mixedSchema = {
        type: "object",
        properties: {
          days: {
            anyOf: [{ type: "integer" }, { type: "string", enum: [""] }],
          },
          delay: {
            anyOf: [{ type: "string", enum: ["minimum"] }, { type: "integer" }],
          },
          code: {
            oneOf: [
              { type: "string", pattern: "^[A-Z]+$" },
              { type: "number" },
            ],
          },
          version: {
            anyOf: [{ type: "string", const: "latest" }, { type: "integer" }],
          },
          ids: {
            anyOf: [
              { type: "array", items: { type: "integer" } },
              { type: "string", enum: [""] },
            ],
          },
        },
      };
      const mixed = {
        "application/x-www-form-urlencoded": { schema: mixedSchema },
      };

      it.each([
        "days=30",
        "days=",
        "delay=7",
        "delay=minimum",
        "code=ABC",
        "code=1.5",
        "version=latest",
        "version=3",
        "ids=4",
        "ids=",
      ])("accepts %s", async (form) => {
        const mock = await validatingMock(mixed);

        const result = await interceptedPost(mock, {
          body: new URLSearchParams(form),
        });

        expect(result.status).toBe(201);
      });

      it.each(["days=soon", "delay=later", "code=abc", "version=next"])(
        "rejects %s",
        async (form) => {
          const mock = await validatingMock(mixed);

          const result = await interceptedPost(mock, {
            body: new URLSearchParams(form),
          });

          expect(result.status).toBe(400);
        },
      );
    });
  });

  describe("bracket keys in form fields", () => {
    const stripeLike = {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        metadata: {
          anyOf: [
            { type: "object", additionalProperties: { type: "string" } },
            { type: "string", enum: [""] },
          ],
        },
        expand: { type: "array", items: { type: "string" } },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["price"],
            properties: {
              price: { type: "string" },
              quantity: { type: "integer" },
            },
          },
        },
        label: { type: "string" },
      },
    };
    const urlencoded = {
      "application/x-www-form-urlencoded": { schema: stripeLike },
    };

    it.each([
      "name=Ada&metadata[order]=42",
      "expand[]=sources&expand[]=tax",
      "expand[0]=sources&expand[1]=tax",
      "items[0][price]=p_1&items[0][quantity]=2&items[1][price]=p_2",
    ])("nests %s under its declared property", async (form) => {
      const mock = await validatingMock(urlencoded);

      const result = await interceptedPost(mock, {
        body: new URLSearchParams(form),
      });

      expect(result.status).toBe(201);
    });

    it("validates the nested values against the nested schema", async () => {
      const mock = await validatingMock(urlencoded);

      const result = await interceptedPost(mock, {
        body: new URLSearchParams("items[0][quantity]=many"),
      });

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        details: expect.arrayContaining([
          expect.objectContaining({ path: "/items/0", keyword: "required" }),
          expect.objectContaining({ path: "/items/0/quantity" }),
        ]),
      });
    });

    it.each([
      ["an undeclared base", "other[key]=1"],
      ["a base declared as a string", "label[key]=1"],
    ])("keeps a bracket key on %s literal", async (_, form) => {
      const mock = await validatingMock(urlencoded);

      const result = await interceptedPost(mock, {
        body: new URLSearchParams(form),
      });

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        details: [expect.objectContaining({ keyword: "additionalProperties" })],
      });
    });

    it("accepts Stripe's deepObject metadata and integer fields", {
      timeout: 60_000,
    }, async () => {
      const mock = schmock();
      mock.pipe(
        await openapi({
          spec: resolve(
            import.meta.dirname,
            "__fixtures__",
            "stripe-spec3.yaml",
          ),
          validateRequests: true,
        }),
      );
      const handle = mock.intercept({ passthrough: false });
      try {
        const post = (form: string, path = "/v1/customers") =>
          fetch(`http://localhost${path}`, {
            method: "POST",
            body: new URLSearchParams(form),
          });

        expect((await post("name=Ada&metadata[order]=42")).status).toBe(200);
        expect((await post("balance=100&expand[]=sources")).status).toBe(200);
        expect((await post("balance=lots")).status).toBe(400);
        // `anyOf: [{ type: integer }, { type: string, enum: [""] }]`: an
        // amount, or empty to clear it.
        const quotes = "/v1/quotes";
        expect((await post("application_fee_amount=100", quotes)).status).toBe(
          200,
        );
        expect((await post("application_fee_amount=", quotes)).status).toBe(
          200,
        );
        expect((await post("application_fee_amount=x", quotes)).status).toBe(
          400,
        );
      } finally {
        handle.restore();
      }
    });
  });

  describe("bodies core does not decode", () => {
    const objectSchema = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    };

    it("does not validate XML text against its object schema", async () => {
      const mock = await validatingMock({
        "application/xml": { schema: objectSchema },
      });

      const result = await interceptedPost(mock, {
        body: "<pet><name>Rex</name></pet>",
        headers: { "content-type": "application/xml" },
      });

      expect(result.status).toBe(201);
    });

    it("does not validate CSV text against an object schema behind */*", async () => {
      const mock = await validatingMock({
        "*/*": { schema: { type: "object" } },
      });

      const result = await interceptedPost(mock, {
        body: "a,b",
        headers: { "content-type": "text/csv" },
      });

      expect(result.status).toBe(201);
    });

    it("still validates text against a string schema", async () => {
      const mock = await validatingMock({
        "text/plain": { schema: { type: "string", maxLength: 3 } },
      });

      const accepted = await interceptedPost(mock, {
        body: "abc",
        headers: { "content-type": "text/plain" },
      });
      const rejected = await interceptedPost(mock, {
        body: "abcd",
        headers: { "content-type": "text/plain" },
      });

      expect(accepted.status).toBe(201);
      expect(rejected.status).toBe(400);
    });

    it.each([
      ["no type", { maxLength: 2 }],
      ["no type", { pattern: "^a+$" }],
      ["no type", { enum: ["ok"] }],
      [
        "a string branch",
        { anyOf: [{ type: "object" }, { type: "string", maxLength: 2 }] },
      ],
    ])("still validates text against a schema with %s", async (_, schema) => {
      const mock = await validatingMock({ "text/plain": { schema } });
      const text = { "content-type": "text/plain" };

      const intercepted = await interceptedPost(mock, {
        body: "abcdef",
        headers: text,
      });
      const direct = await mock.handle("POST", "/uploads", {
        body: "abcdef",
        headers: text,
      });

      expect(intercepted.status).toBe(400);
      expect(direct.status).toBe(400);
    });

    it("still validates a parsed object handed over for a non-JSON type", async () => {
      const mock = await validatingMock({
        "application/xml": { schema: objectSchema },
      });

      const response = await mock.handle("POST", "/uploads", {
        body: { other: "value" },
        headers: { "content-type": "application/xml" },
      });

      expect(response.status).toBe(400);
    });
  });
});

describe("normalizeRequestBody", () => {
  const schema = {
    type: "object" as const,
    properties: {
      count: { type: "integer" as const },
      tags: { type: "array" as const, items: { type: "string" as const } },
    },
  };

  it("turns a FormData into a record, repeated names into arrays", () => {
    const form = new FormData();
    form.append("count", "2");
    form.append("tags", "a");
    form.append("tags", "b");
    form.append("free", "x");

    expect(normalizeRequestBody(form, undefined, schema)).toEqual({
      count: 2,
      tags: ["a", "b"],
      free: "x",
    });
  });

  it("keeps file parts as the Blobs they arrived as", () => {
    const form = new FormData();
    form.append("file", new Blob(["bytes"]));

    expect(normalizeRequestBody(form, undefined, schema)).toEqual({
      file: expect.any(Blob),
    });
  });

  it("copies an urlencoded record instead of changing it", () => {
    const body = { count: "2", tags: "a" };

    const normalized = normalizeRequestBody(
      body,
      "application/x-www-form-urlencoded; charset=utf-8",
      schema,
    );

    expect(normalized).toEqual({ count: 2, tags: ["a"] });
    expect(body).toEqual({ count: "2", tags: "a" });
  });

  it("returns every non-form body unchanged", () => {
    const json = { count: "2" };
    const bytes = new Uint8Array([1]);

    expect(normalizeRequestBody(json, "application/json", schema)).toBe(json);
    expect(normalizeRequestBody(json, undefined, schema)).toBe(json);
    expect(normalizeRequestBody("count=2", "text/plain", schema)).toBe(
      "count=2",
    );
    expect(
      normalizeRequestBody(bytes, "application/octet-stream", schema),
    ).toBe(bytes);
  });

  it.each([
    ["the bracket key first", "metadata[a]=1&metadata=x"],
    ["the plain key first", "metadata=x&metadata[a]=1"],
  ])("keeps both a bracket key and its plain base, with %s", (_, form) => {
    const metadataSchema = {
      type: "object" as const,
      properties: {
        metadata: { type: "object" as const },
      },
    };

    const normalized = normalizeRequestBody(
      Object.fromEntries(new URLSearchParams(form)),
      "application/x-www-form-urlencoded",
      metadataSchema,
    );

    expect(normalized).toEqual({ metadata: "x", "metadata[a]": "1" });
  });

  it("keeps a field named after a prototype member as data", () => {
    const normalized = normalizeRequestBody(
      new URLSearchParams("__proto__=x&tags[__proto__]=y&count=1"),
      "application/x-www-form-urlencoded",
      schema,
    );

    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(normalized, "__proto__")).toEqual(
      expect.objectContaining({ value: "x", enumerable: true }),
    );
    expect(({} as Record<string, unknown>).y).toBeUndefined();
  });
});

describe("readRequestBody", () => {
  const schema = {
    type: "object" as const,
    properties: { age: { type: "integer" as const } },
  };
  const formHeaders = { "content-type": "application/x-www-form-urlencoded" };

  it("returns the body request validation normalized", () => {
    const context: Schmock.PluginContext = {
      path: "/uploads",
      route: {
        "openapi:requestContent": new Map([
          ["application/x-www-form-urlencoded", schema],
        ]),
      },
      method: "POST",
      params: {},
      query: {},
      headers: formHeaders,
      body: { age: "4" },
      state: new Map(),
    };

    expect(
      validateRequestBody(context, createBodyValidatorContext()),
    ).toBeUndefined();
    expect(context.state.get(NORMALIZED_BODY_STATE_KEY)).toEqual({ age: 4 });
    expect(
      readRequestBody(
        {
          body: context.body,
          headers: formHeaders,
          pluginState: context.state,
        },
        undefined,
      ),
    ).toEqual({ age: 4 });
  });

  it("normalizes on the spot when validation did not run", () => {
    expect(
      readRequestBody(
        { body: { age: "4" }, headers: formHeaders, pluginState: new Map() },
        schema,
      ),
    ).toEqual({ age: 4 });
  });
});
