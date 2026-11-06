/// <reference path="../../core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin.js";
import { parsePreferHeader } from "./prefer.js";

/** One GET declaring a 200 and a `default` error, the shape that matched any code. */
const specWithDefault = {
  openapi: "3.0.3",
  info: { title: "prefer", version: "1.0.0" },
  paths: {
    "/status": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["ok"],
                  properties: { ok: { type: "boolean", enum: [true] } },
                },
              },
            },
          },
          default: {
            description: "error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["message"],
                  properties: { message: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("Prefer code range", () => {
  describe("parsePreferHeader", () => {
    it("ignores a code outside the statuses core can serve", () => {
      for (const value of [
        "0",
        "42",
        "99",
        "100",
        "199",
        "600",
        "999",
        "1000",
      ]) {
        expect(parsePreferHeader(`code=${value}`)).toEqual({});
      }
    });

    it("keeps a code from 200 through 599", () => {
      expect(parsePreferHeader("code=200")).toEqual({ code: 200 });
      expect(parsePreferHeader("code=404")).toEqual({ code: 404 });
      expect(parsePreferHeader("code=599")).toEqual({ code: 599 });
    });

    it("falls through to the next directive when the code is out of range", () => {
      expect(parsePreferHeader("code=999, example=dog")).toEqual({
        example: "dog",
      });
    });
  });

  describe("on an operation that declares default", () => {
    it("answers the normal response for an out-of-range code", async () => {
      const mock = schmock();
      mock.pipe(await openapi({ spec: specWithDefault }));

      for (const code of ["0", "99", "600", "999"]) {
        const response = await mock.handle("GET", "/status", {
          headers: { prefer: `code=${code}` },
        });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true });
      }
    });

    it("still answers a declared-by-default code in range", async () => {
      const mock = schmock();
      mock.pipe(await openapi({ spec: specWithDefault }));

      const response = await mock.handle("GET", "/status", {
        headers: { prefer: "code=503" },
      });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ message: expect.any(String) });
    });
  });
});

describe("Prefer response headers", () => {
  const object = (properties: Record<string, unknown>) => ({
    type: "object",
    properties,
  });
  const specWithHeaders = {
    openapi: "3.0.3",
    info: { title: "prefer headers", version: "1.0.0" },
    paths: {
      "/uploads": {
        post: {
          requestBody: {
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "201": {
              description: "created",
              headers: {
                "X-Rate": { schema: { type: "string", enum: ["5"] } },
              },
              content: {
                "application/json": {
                  schema: object({ ok: { type: "boolean" } }),
                  examples: { one: { value: { ok: true } } },
                },
              },
            },
            "400": {
              description: "bad",
              headers: { "X-Err": { schema: { type: "string", enum: ["e"] } } },
              content: {
                "application/json": {
                  schema: object({ m: { type: "string" } }),
                },
              },
            },
          },
        },
      },
      "/ping": {
        get: {
          responses: {
            "200": {
              description: "ok",
              headers: {
                "X-Rate": { schema: { type: "string", enum: ["5"] } },
              },
              content: {
                "application/json": {
                  schema: object({ ok: { type: "boolean" } }),
                },
              },
            },
          },
        },
      },
    },
  };

  it.each([
    ["POST", "/uploads", "dynamic=true", 201, { "X-Rate": "5" }],
    ["POST", "/uploads", "code=201", 201, { "X-Rate": "5" }],
    ["POST", "/uploads", "example=one", 201, { "X-Rate": "5" }],
    ["POST", "/uploads", "code=400", 400, { "X-Err": "e" }],
    ["GET", "/ping", "dynamic=true", 200, { "X-Rate": "5" }],
  ] as const)(
    "%s %s with Prefer: %s keeps the headers its status declares",
    async (method, path, prefer, status, headers) => {
      const mock = schmock();
      mock.pipe(await openapi({ spec: specWithHeaders }));

      const response = await mock.handle(method, path, {
        body: method === "POST" ? {} : undefined,
        headers: { prefer },
      });

      expect(response.status).toBe(status);
      expect(response.headers).toMatchObject(headers);
    },
  );
});

describe("seeded Prefer response headers", () => {
  const requestId = {
    "X-Request-Id": { schema: { type: "string", format: "uuid" } },
  };
  const item = {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
  };
  const json = (schema: unknown) => ({
    "application/json": { schema },
  });
  const seededSpec = {
    openapi: "3.0.3",
    info: { title: "seeded prefer headers", version: "1.0.0" },
    paths: {
      "/ping": {
        get: {
          responses: {
            "200": {
              description: "ok",
              headers: requestId,
              content: json({ type: "object" }),
            },
          },
        },
      },
      "/items": {
        post: {
          requestBody: { content: json(item) },
          responses: {
            "201": {
              description: "created",
              headers: requestId,
              content: json(item),
            },
          },
        },
      },
      "/items/{id}": {
        get: {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: { "200": { description: "one", content: json(item) } },
        },
      },
    },
  };

  // The seeded header namespace (see response-headers.ts): a fixed prefix,
  // then the seed and the request ordinal.
  const seeded = /^00000000-0000-4000-9000-000042\d{6}$/;

  it.each([
    ["GET", "/ping", "dynamic=true", 200],
    ["GET", "/ping", "code=200", 200],
    ["POST", "/items", "dynamic=true", 201],
    ["POST", "/items", "code=201", 201],
  ] as const)(
    "%s %s with Prefer: %s draws its headers from fakerSeed",
    async (method, path, prefer, status) => {
      const mock = schmock();
      mock.pipe(await openapi({ spec: seededSpec, fakerSeed: 42 }));

      const response = await mock.handle(method, path, {
        body: method === "POST" ? { name: "a" } : undefined,
        headers: { prefer },
      });

      expect(response.status).toBe(status);
      expect(response.headers["X-Request-Id"]).toMatch(seeded);
    },
  );
});

describe("Prefer example under a default or range response", () => {
  const ok = {
    description: "ok",
    content: {
      "application/json": {
        schema: { type: "object", properties: { a: { type: "string" } } },
      },
    },
  };
  const withExample = (name: string, value: unknown) => ({
    description: "error",
    content: {
      "application/json": {
        schema: { type: "object" },
        examples: { [name]: { value } },
      },
    },
  });
  const spec = {
    openapi: "3.1.0",
    info: { title: "prefer examples", version: "1.0.0" },
    paths: {
      "/default": {
        get: {
          responses: {
            "200": ok,
            default: withExample("boom", { error: "boom" }),
          },
        },
      },
      "/range": {
        get: {
          responses: { "200": ok, "4XX": withExample("nf", { error: "nf" }) },
        },
      },
      "/numeric": {
        get: {
          responses: { "200": ok, "404": withExample("nf", { error: "nf" }) },
        },
      },
      "/default-only": {
        get: {
          responses: { default: withExample("boom", { error: "boom" }) },
        },
      },
    },
  };

  it.each([
    ["/default", "boom", 500, { error: "boom" }],
    ["/range", "nf", 400, { error: "nf" }],
    ["/numeric", "nf", 404, { error: "nf" }],
    ["/default-only", "boom", 200, { error: "boom" }],
  ])(
    "GET %s with Prefer: example=%s serves that example",
    async (path, name, status, body) => {
      const mock = schmock();
      mock.pipe(await openapi({ spec, validateResponses: true }));

      const response = await mock.handle("GET", path, {
        headers: { prefer: `example=${name}` },
      });

      expect({ status: response.status, body: response.body }).toEqual({
        status,
        body,
      });
    },
  );
});
