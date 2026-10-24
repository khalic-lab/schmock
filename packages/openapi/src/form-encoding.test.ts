import { schmock } from "@schmock/core";
import express from "express";
import type { JSONSchema7 } from "json-schema";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { toExpress } from "../../express/src/index";
import { openapi } from "./plugin";
import { type FormEncoding, normalizeRequestBody } from "./request-body";

const FORM_TYPE = "application/x-www-form-urlencoded";

const formSchema: JSONSchema7 = {
  type: "object",
  properties: {
    tags: { type: "array", items: { type: "string" } },
    ids: { type: "array", items: { type: "integer" } },
    name: { type: "string" },
    filter: {
      type: "object",
      properties: {
        color: { type: "string" },
        sizes: { type: "array", items: { type: "string" } },
      },
    },
  },
};

/**
 * An urlencoded body read the way core hands it over: the last-wins record
 * as `body` and the form itself beside it.
 */
function readForm(
  text: string,
  encoding?: Record<string, FormEncoding>,
  schema: JSONSchema7 = formSchema,
): unknown {
  const form = new URLSearchParams(text);
  return normalizeRequestBody(Object.fromEntries(form), FORM_TYPE, schema, {
    fields: form,
    encoding:
      encoding === undefined ? undefined : new Map(Object.entries(encoding)),
  });
}

function notesSpec(encoding?: Record<string, unknown>) {
  const note = {
    type: "object",
    properties: {
      noteId: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
    },
  };
  const formBody = {
    required: true,
    content: {
      [FORM_TYPE]: {
        schema: {
          type: "object",
          required: ["tags"],
          properties: {
            tags: { type: "array", minItems: 2, items: { type: "string" } },
          },
        },
        ...(encoding === undefined ? {} : { encoding }),
      },
    },
  };
  const noteId = {
    name: "noteId",
    in: "path",
    required: true,
    schema: { type: "integer" },
  };
  return {
    openapi: "3.0.3",
    info: { title: "notes", version: "1.0.0" },
    paths: {
      "/notes": {
        post: {
          requestBody: formBody,
          responses: {
            "201": {
              description: "created",
              content: { "application/json": { schema: note } },
            },
          },
        },
        get: {
          responses: {
            "200": {
              description: "notes",
              content: {
                "application/json": { schema: { type: "array", items: note } },
              },
            },
          },
        },
      },
      "/notes/{noteId}": {
        get: {
          parameters: [noteId],
          responses: {
            "200": {
              description: "one note",
              content: { "application/json": { schema: note } },
            },
          },
        },
        patch: {
          parameters: [noteId],
          requestBody: formBody,
          responses: {
            "200": {
              description: "updated",
              content: { "application/json": { schema: note } },
            },
          },
        },
      },
    },
  };
}

async function notesMock(
  options: {
    encoding?: Record<string, unknown>;
    validateRequests?: boolean;
  } = {},
): Promise<Schmock.CallableMockInstance> {
  const mock = schmock({ state: {} });
  mock.pipe(
    await openapi({
      spec: notesSpec(options.encoding),
      validateRequests: options.validateRequests ?? true,
    }),
  );
  return mock;
}

/** POST a form through the fetch interceptor, the path React, Vue and the relay use. */
async function interceptedCreate(
  mock: Schmock.CallableMockInstance,
  form: string,
): Promise<{ status: number; body: unknown }> {
  const handle = mock.intercept({ passthrough: false });
  try {
    const response = await fetch("http://localhost/notes", {
      method: "POST",
      body: new URLSearchParams(form),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    handle.restore();
  }
}

describe("urlencoded forms read through their encoding", () => {
  describe("normalizeRequestBody with the submitted form", () => {
    it("gives an array property every value of a repeated name", () => {
      expect(readForm("tags=a&tags=b")).toEqual({ tags: ["a", "b"] });
    });

    it("coerces each value by the array's item type", () => {
      expect(readForm("ids=1&ids=2")).toEqual({ ids: [1, 2] });
    });

    it("keeps the last value of a repeated name not declared as an array", () => {
      expect(readForm("name=a&name=b&extra=x&extra=y")).toEqual({
        name: "b",
        extra: "y",
      });
    });

    it("reads a name sent once exactly as the record alone reads it", () => {
      expect(readForm("tags=a&name=Rex")).toEqual(
        normalizeRequestBody({ tags: "a", name: "Rex" }, FORM_TYPE, formSchema),
      );
    });

    it("splits a form value on commas when the property does not explode", () => {
      const encoding = {
        tags: { style: "form", explode: false },
        ids: { style: "form", explode: false },
      } as const;
      expect(readForm("tags=a,b&ids=1,2", encoding)).toEqual({
        tags: ["a", "b"],
        ids: [1, 2],
      });
    });

    it("splits spaceDelimited and pipeDelimited values on their delimiter", () => {
      expect(
        readForm("tags=a+b&ids=1|2", {
          tags: { style: "spaceDelimited", explode: false },
          ids: { style: "pipeDelimited", explode: false },
        }),
      ).toEqual({ tags: ["a", "b"], ids: [1, 2] });
    });

    it("reads an exploded delimited style by repeated names, not delimiters", () => {
      expect(
        readForm("tags=a+b&tags=c", {
          tags: { style: "spaceDelimited", explode: true },
        }),
      ).toEqual({ tags: ["a b", "c"] });
    });

    it("splits every value of a non-exploded name that is repeated anyway", () => {
      expect(
        readForm("tags=a,b&tags=c", {
          tags: { style: "form", explode: false },
        }),
      ).toEqual({ tags: ["a", "b", "c"] });
    });

    it("reads an empty non-exploded value as the record alone reads it", () => {
      expect(
        readForm("tags=", { tags: { style: "form", explode: false } }),
      ).toEqual(normalizeRequestBody({ tags: "" }, FORM_TYPE, formSchema));
    });

    it("splits only properties declared as arrays", () => {
      expect(
        readForm("name=a,b", { name: { style: "form", explode: false } }),
      ).toEqual({ name: "a,b" });
    });

    it("keeps deepObject bracket keys, with every value for an array leaf", () => {
      expect(
        readForm(
          "filter[color]=red&filter[color]=blue&filter[sizes]=s&filter[sizes]=m",
          { filter: { style: "deepObject", explode: true } },
        ),
      ).toEqual({ filter: { color: "blue", sizes: ["s", "m"] } });
    });

    it("appends every value of a repeated name[] key to its array", () => {
      expect(readForm("tags[]=a&tags[]=b")).toEqual({ tags: ["a", "b"] });
    });

    it("keeps a repeated field named __proto__ as an own array field", () => {
      const read = readForm("__proto__=a&__proto__=b", undefined, {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" } },
      });
      expect(Object.getOwnPropertyDescriptor(read, "__proto__")?.value).toEqual(
        ["a", "b"],
      );
      expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
    });

    it("reads the record alone when no form is passed", () => {
      expect(
        normalizeRequestBody({ tags: "b" }, FORM_TYPE, formSchema, {}),
      ).toEqual({ tags: ["b"] });
    });

    it("reads the record alone when a handle() caller passes no usable form", () => {
      for (const fields of [null, { tags: ["a", "b"] }, "tags=a&tags=b"]) {
        expect(
          normalizeRequestBody({ tags: "b" }, FORM_TYPE, formSchema, {
            fields: fields as unknown as URLSearchParams,
          }),
        ).toEqual({ tags: ["b"] });
      }
    });

    it("reads the record alone when the form no longer describes it", () => {
      const form = new URLSearchParams("tags=a&tags=b");
      expect(
        normalizeRequestBody({ tags: "c" }, FORM_TYPE, formSchema, {
          fields: form,
        }),
      ).toEqual({ tags: ["c"] });
      expect(
        normalizeRequestBody(
          { tags: "b", name: "Rex" },
          FORM_TYPE,
          formSchema,
          {
            fields: form,
          },
        ),
      ).toEqual({ tags: ["b"], name: "Rex" });
    });

    it("reads a form of many fields in one pass over it", () => {
      // getAll() scans the whole form, so calling it per name is quadratic.
      class OnePassForm extends URLSearchParams {
        override getAll(): string[] {
          throw new Error("getAll() scans the whole form");
        }
      }
      const count = 50_000;
      const form = new OnePassForm();
      for (let i = 0; i < count; i++) form.append(`f${i}`, String(i));
      form.append("tags", "a");
      form.append("tags", "b");
      const started = performance.now();
      const body = normalizeRequestBody(
        Object.fromEntries(form),
        FORM_TYPE,
        formSchema,
        { fields: form },
      ) as Record<string, unknown>;
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(body.tags).toEqual(["a", "b"]);
      expect(Object.keys(body)).toHaveLength(count + 1);
      expect(body.f49999).toBe("49999");
    });

    it("ignores the form for a body of any other media type", () => {
      const body = { tags: "b" };
      expect(
        normalizeRequestBody(body, "application/json", formSchema, {
          fields: new URLSearchParams("tags=a&tags=b"),
        }),
      ).toBe(body);
    });
  });

  describe("normalizeRequestBody with the record alone", () => {
    /** A record as Express's parser or a handle() caller hands it over. */
    function readRecord(
      record: Record<string, unknown>,
      encoding?: Record<string, FormEncoding>,
      contentType = FORM_TYPE,
    ): unknown {
      return normalizeRequestBody(record, contentType, formSchema, {
        encoding:
          encoding === undefined
            ? undefined
            : new Map(Object.entries(encoding)),
      });
    }

    it("splits a value on commas when the property's form style does not explode", () => {
      expect(
        readRecord(
          { tags: "a,b", ids: "1,2" },
          {
            tags: { style: "form", explode: false },
            ids: { style: "form", explode: false },
          },
        ),
      ).toEqual({ tags: ["a", "b"], ids: [1, 2] });
    });

    it("splits spaceDelimited and pipeDelimited values on their delimiter", () => {
      expect(
        readRecord(
          { tags: "a b", ids: "1|2" },
          {
            tags: { style: "spaceDelimited", explode: false },
            ids: { style: "pipeDelimited", explode: false },
          },
        ),
      ).toEqual({ tags: ["a", "b"], ids: [1, 2] });
    });

    it("leaves a value whole where the property explodes or names no encoding", () => {
      for (const encoding of [
        undefined,
        {},
        { tags: { style: "form" as const, explode: true } },
        { tags: { style: "spaceDelimited" as const, explode: true } },
        { name: { style: "form" as const, explode: false } },
      ]) {
        expect(readRecord({ tags: "a,b" }, encoding)).toEqual({
          tags: ["a,b"],
        });
      }
    });

    it("splits only properties declared as arrays, and only text values", () => {
      const explodeFalse = { style: "form" as const, explode: false };
      expect(readRecord({ name: "a,b" }, { name: explodeFalse })).toEqual({
        name: "a,b",
      });
      expect(
        readRecord({ tags: ["a,b", "c"] }, { tags: explodeFalse }),
      ).toEqual({ tags: ["a,b", "c"] });
      expect(readRecord({ tags: "" }, { tags: explodeFalse })).toEqual({
        tags: [""],
      });
    });

    it("reads a record the form no longer describes the same way", () => {
      expect(
        normalizeRequestBody({ tags: "c,d" }, FORM_TYPE, formSchema, {
          fields: new URLSearchParams("tags=a,b"),
          encoding: new Map([["tags", { style: "form", explode: false }]]),
        }),
      ).toEqual({ tags: ["c", "d"] });
    });

    it("never splits a multipart record", () => {
      expect(
        readRecord(
          { tags: "a,b" },
          { tags: { style: "form", explode: false } },
          "multipart/form-data",
        ),
      ).toEqual({ tags: ["a,b"] });
    });
  });

  describe("request validation and CRUD storage", () => {
    let mock: Schmock.CallableMockInstance | undefined;

    afterEach(() => {
      mock?.close();
      mock = undefined;
    });

    it("accepts a repeated name against an array schema and stores every value", async () => {
      mock = await notesMock();

      const created = await interceptedCreate(mock, "tags=a&tags=b");

      expect(created).toEqual({
        status: 201,
        body: { noteId: 1, tags: ["a", "b"] },
      });
      const stored = await mock.handle("GET", "/notes/1");
      expect(stored.body).toEqual({ noteId: 1, tags: ["a", "b"] });
    });

    it("updates an array property from a repeated name", async () => {
      mock = await notesMock();
      await interceptedCreate(mock, "tags=a&tags=b");

      const handle = mock.intercept({ passthrough: false });
      try {
        const response = await fetch("http://localhost/notes/1", {
          method: "PATCH",
          body: new URLSearchParams("tags=c&tags=d"),
        });
        expect(response.status).toBe(200);
      } finally {
        handle.restore();
      }

      const stored = await mock.handle("GET", "/notes/1");
      expect(stored.body).toEqual({ noteId: 1, tags: ["c", "d"] });
    });

    it("stores every value with request validation off", async () => {
      mock = await notesMock({ validateRequests: false });

      const created = await interceptedCreate(mock, "tags=a&tags=b&tags=c");

      expect(created.body).toEqual({ noteId: 1, tags: ["a", "b", "c"] });
    });

    it("splits a comma-separated value its encoding does not explode", async () => {
      mock = await notesMock({
        encoding: { tags: { style: "form", explode: false } },
      });

      const created = await interceptedCreate(mock, "tags=a,b");

      expect(created).toEqual({
        status: 201,
        body: { noteId: 1, tags: ["a", "b"] },
      });
    });

    it("reads mock.listen() requests the same way", async () => {
      mock = await notesMock();
      const { port } = await mock.listen(0);

      const response = await fetch(`http://127.0.0.1:${port}/notes`, {
        method: "POST",
        headers: { "content-type": `${FORM_TYPE}; charset=UTF-8` },
        body: "tags=a&tags=b",
      });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({
        noteId: 1,
        tags: ["a", "b"],
      });
    });

    it("still rejects a single value against minItems 2", async () => {
      mock = await notesMock();

      const created = await interceptedCreate(mock, "tags=a");

      expect(created.status).toBe(400);
      expect(created.body).toMatchObject({
        code: "VALIDATION_ERROR",
        details: [
          expect.objectContaining({ path: "/tags", keyword: "minItems" }),
        ],
      });
    });
  });

  describe("Express and the core transports agree", () => {
    it("stores a repeated name parsed by express.urlencoded() as intercept() does", async () => {
      const viaExpress = await notesMock();
      const app = express();
      app.use(express.urlencoded({ extended: false }));
      app.use(toExpress(viaExpress));

      const expressCreated = await request(app)
        .post("/notes")
        .type("form")
        .send("tags=a&tags=b");
      const intercepted = await interceptedCreate(
        await notesMock(),
        "tags=a&tags=b",
      );

      expect(expressCreated.status).toBe(201);
      expect(expressCreated.body).toEqual({ noteId: 1, tags: ["a", "b"] });
      expect(intercepted).toEqual({
        status: expressCreated.status,
        body: expressCreated.body,
      });
    });

    it("splits a value its encoding does not explode under Express as intercept() does", async () => {
      const encoding = { tags: { style: "form", explode: false } };
      for (const extended of [false, true]) {
        const viaExpress = await notesMock({ encoding });
        const app = express();
        app.use(express.urlencoded({ extended }));
        app.use(toExpress(viaExpress));

        const expressCreated = await request(app)
          .post("/notes")
          .type("form")
          .send("tags=a,b");
        const intercepted = await interceptedCreate(
          await notesMock({ encoding }),
          "tags=a,b",
        );

        expect(expressCreated.status).toBe(201);
        expect(expressCreated.body).toEqual({ noteId: 1, tags: ["a", "b"] });
        expect(intercepted).toEqual({
          status: expressCreated.status,
          body: expressCreated.body,
        });
        const stored = await viaExpress.handle("GET", "/notes/1");
        expect(stored.body).toEqual({ noteId: 1, tags: ["a", "b"] });
      }
    });

    it("reads a record a handle() caller passes the way Express's is read", async () => {
      const viaHandle = await notesMock({
        encoding: { tags: { style: "pipeDelimited" } },
      });

      const created = await viaHandle.handle("POST", "/notes", {
        headers: { "content-type": FORM_TYPE },
        body: { tags: "a|b" },
      });

      expect(created.status).toBe(201);
      expect(created.body).toEqual({ noteId: 1, tags: ["a", "b"] });
    });
  });
});
