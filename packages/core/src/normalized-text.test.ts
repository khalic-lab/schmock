import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveNodeRequest, writeSchmockResponse } from "./http-helpers.js";
import { schmock } from "./index.js";
import {
  normalizeResponse,
  serializeResponseBody,
} from "./response-normalizer.js";

/**
 * A JSON body is validated and serialized once, by `normalizeResponse`. Core's
 * own consumers of a response straight out of `handle()` reuse that text:
 * `listen()`, `intercept()` without a `beforeResponse` hook, and history.
 * Everything a caller can edit in between is serialized again.
 */

const ITEMS = [
  { id: 1, name: "Ada", tags: ["a", "b"] },
  { id: 2, name: "Grace", tags: [] },
];

/** Count the validating serializer's passes: JSON.stringify with a replacer. */
function countValidatingPasses(): { readonly passes: () => number } {
  const stringify = vi.spyOn(JSON, "stringify");
  return {
    passes: () =>
      stringify.mock.calls.filter(
        ([, replacer]) => typeof replacer === "function",
      ).length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listenOn(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalized JSON text reuse", () => {
  describe("intercept()", () => {
    let interception: Schmock.InterceptHandle | undefined;

    afterEach(() => {
      interception?.restore();
      interception = undefined;
    });

    it("serializes a JSON body once per request without a beforeResponse hook", async () => {
      const mock = schmock();
      mock("GET /items", () => ITEMS);
      interception = mock.intercept();
      const { passes } = countValidatingPasses();

      const response = await fetch("http://localhost/items");

      expect(await response.json()).toEqual(ITEMS);
      expect(passes()).toBe(1);
    });

    it("serializes again after a beforeResponse hook, and sends what it edited in place", async () => {
      const mock = schmock();
      mock("GET /items", () => ITEMS);
      interception = mock.intercept({
        beforeResponse: ({ body }) => {
          if (Array.isArray(body) && isRecord(body[0])) body[0].name = "edited";
        },
      });
      const { passes } = countValidatingPasses();

      const response = await fetch("http://localhost/items");

      expect(await response.json()).toEqual([
        { ...ITEMS[0], name: "edited" },
        ITEMS[1],
      ]);
      expect(passes()).toBe(2);
    });

    it("refuses a body a beforeResponse hook made unserializable in place", async () => {
      const mock = schmock();
      mock("GET /items", () => ({ id: 1 }));
      interception = mock.intercept({
        beforeResponse: (response) => {
          if (isRecord(response.body)) response.body.later = undefined;
        },
      });

      await expect(fetch("http://localhost/items")).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    });
  });

  describe("listen()", () => {
    let mock: Schmock.CallableMockInstance | undefined;

    afterEach(() => {
      mock?.close();
      mock = undefined;
    });

    it("serializes a JSON body once per request", async () => {
      mock = schmock();
      mock("GET /items", () => ITEMS);
      const { port } = await mock.listen(0);
      const { passes } = countValidatingPasses();

      const response = await fetch(`http://127.0.0.1:${port}/items`);
      const text = await response.text();

      expect(JSON.parse(text)).toEqual(ITEMS);
      expect(response.headers.get("content-length")).toBe(
        String(new TextEncoder().encode(text).byteLength),
      );
      expect(passes()).toBe(1);
    });
  });

  describe("public serializers", () => {
    it("serializeResponseBody refuses a normalized tree edited to hold undefined", () => {
      const response = normalizeResponse(
        { status: 200, body: { a: 1 } },
        "GET",
      );
      if (isRecord(response.body)) response.body.b = undefined;

      expect(() => serializeResponseBody(response)).toThrow(
        "unsupported undefined value",
      );
    });

    it("writeSchmockResponse writes a normalized tree as it was edited", () => {
      const response = normalizeResponse(
        { status: 200, body: { a: 1 } },
        "GET",
      );
      if (isRecord(response.body)) response.body.a = 2;
      let written: Uint8Array | string | undefined;
      const res = {
        writeHead() {
          return res;
        },
        end(body?: string | Uint8Array) {
          written = body;
          return res;
        },
      };

      writeSchmockResponse(res, response);

      expect(new TextDecoder().decode(written as Uint8Array)).toBe('{"a":2}');
    });

    it("serveNodeRequest serializes what a custom handle edited in place", async () => {
      const mock = schmock();
      mock("GET /items", () => ITEMS);
      const server = createServer((req, res) => {
        void serveNodeRequest(req, res, {
          handle: async (method, path, options) => {
            const response = await mock.handle(method, path, options);
            if (Array.isArray(response.body)) response.body.pop();
            return response;
          },
        });
      });
      try {
        const port = await listenOn(server);

        const response = await fetch(`http://127.0.0.1:${port}/items`);

        expect(await response.json()).toEqual([ITEMS[0]]);
      } finally {
        server.close();
      }
    });
  });

  describe("history", () => {
    it("records a JSON response body without cloning its tree", async () => {
      const mock = schmock();
      mock("GET /items", () => ITEMS);
      const clone = vi.spyOn(globalThis, "structuredClone");

      const response = await mock.handle("GET", "/items");

      expect(clone.mock.calls.some(([value]) => value === response.body)).toBe(
        false,
      );
      expect(mock.lastRequest()?.response.body).toEqual(ITEMS);
    });

    it("returns an equal, independent tree on every read", async () => {
      const mock = schmock();
      mock("GET /items", () => ITEMS);
      const response = await mock.handle("GET", "/items");
      if (Array.isArray(response.body)) response.body.length = 0;

      const first = mock.lastRequest()?.response.body;
      if (Array.isArray(first)) first.push("extra");
      const second = mock.lastRequest()?.response.body;

      expect(second).toEqual(ITEMS);
      expect(second).not.toBe(first);
    });

    it.each([
      ["a string", "plain text", "plain text"],
      ["a number", 42, 42],
      ["a boolean", false, false],
      ["bytes", new Uint8Array([1, 2]), new Uint8Array([1, 2])],
    ])("still records %s body", async (_label, body, expected) => {
      const mock = schmock();
      mock("GET /value", () => [200, body]);

      await mock.handle("GET", "/value");

      expect(mock.lastRequest()?.response.body).toEqual(expected);
    });
  });
});
