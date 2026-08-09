import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidResponseError } from "./errors.js";
import {
  normalizeResponse,
  serializeResponseBody,
} from "./response-normalizer.js";

function createResponse(
  body: unknown,
  overrides: Partial<Schmock.Response> = {},
): Schmock.Response {
  return {
    status: 200,
    body,
    headers: {},
    ...overrides,
  };
}

function captureInvalidResponse(action: () => unknown): InvalidResponseError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidResponseError);
    if (error instanceof InvalidResponseError) return error;
    throw error;
  }

  throw new Error("Expected InvalidResponseError");
}

function serializedText(response: Schmock.Response): string | undefined {
  const bytes = serializeResponseBody(response);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("response normalization", () => {
  describe("status and body semantics", () => {
    it.each([
      200, 201, 299, 300, 599,
    ])("accepts transport-safe status %i", (status) => {
      expect(
        normalizeResponse(createResponse({ ok: true }, { status }), "GET")
          .status,
      ).toBe(status);
    });

    it.each([
      199,
      600,
      200.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])("rejects invalid status %s with a structured error", (status) => {
      const error = captureInvalidResponse(() =>
        normalizeResponse(createResponse("body", { status }), "GET"),
      );

      expect(error.code).toBe("INVALID_RESPONSE");
      expect(error.name).toBe("InvalidResponseError");
      expect(error.context).toMatchObject({
        reason: expect.any(String),
        status,
      });
    });

    it.each([
      ["HEAD", 200],
      ["GET", 204],
      ["GET", 205],
      ["GET", 304],
    ] satisfies Array<
      [Schmock.HttpMethod, number]
    >)("suppresses a body for %s responses with status %i", (method, status) => {
      const normalized = normalizeResponse(
        createResponse({ forbidden: true }, { status }),
        method,
      );

      expect(normalized.body).toBeUndefined();
    });

    it("suppresses prohibited bodies before validating them", () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      expect(
        normalizeResponse(createResponse(Promise.resolve("ignored")), "HEAD")
          .body,
      ).toBeUndefined();
      expect(
        normalizeResponse(createResponse(cyclic, { status: 204 }), "GET").body,
      ).toBeUndefined();
    });

    it("retains an absent body for statuses that permit one", () => {
      expect(normalizeResponse(createResponse(undefined), "GET").body).toBe(
        undefined,
      );
    });

    it.each([
      204, 205,
    ])("removes framing headers from body-forbidden status %i", (status) => {
      const normalized = normalizeResponse(
        createResponse("ignored", {
          status,
          headers: {
            "Content-Length": "7",
            Trailer: "x-checksum",
            "Transfer-Encoding": "chunked",
            "X-Kept": "yes",
          },
        }),
        "GET",
      );

      expect(normalized.headers).toEqual({ "X-Kept": "yes" });
    });

    it("removes stale framing headers from an absent ordinary body", () => {
      const normalized = normalizeResponse(
        createResponse(undefined, {
          headers: {
            "content-length": "10",
            trailer: "x-checksum",
            "transfer-encoding": "chunked",
          },
        }),
        "GET",
      );

      expect(normalized.headers).toEqual({});
    });

    it("preserves HEAD representation length but removes transfer framing", () => {
      const normalized = normalizeResponse(
        createResponse("representation", {
          headers: {
            "Content-Length": "14",
            Trailer: "x-checksum",
            "Transfer-Encoding": "chunked",
          },
        }),
        "HEAD",
      );

      expect(normalized.headers).toEqual({ "Content-Length": "14" });
    });

    it("preserves 304 Content-Length but removes transfer framing", () => {
      // RFC 9110 lets a 304 carry the entity's Content-Length, but Trailer
      // and Transfer-Encoding must go: Node's writeHead throws on them for
      // bodyless responses, killing the socket before any bytes are sent.
      expect(
        normalizeResponse(
          createResponse("ignored", {
            status: 304,
            headers: {
              "Content-Length": "14",
              Trailer: "x-checksum",
              "Transfer-Encoding": "chunked",
            },
          }),
          "GET",
        ).headers,
      ).toEqual({ "Content-Length": "14" });
    });

    it("removes user-supplied framing from body-bearing responses", () => {
      const normalized = normalizeResponse(
        createResponse("a longer body", {
          headers: {
            "Content-Length": "1",
            Trailer: "x-checksum",
            "Transfer-Encoding": "chunked",
            "X-Kept": "yes",
          },
        }),
        "GET",
      );

      expect(normalized.headers).toEqual({ "X-Kept": "yes" });
    });
  });

  describe("headers", () => {
    it("clones and validates headers without changing their names", () => {
      const headers = {
        "Content-Type": " application/json ",
        "X-Request-ID": "request-1",
      };
      const input = createResponse("body", { headers });

      const normalized = normalizeResponse(input, "GET");

      expect(normalized).not.toBe(input);
      expect(normalized.headers).not.toBe(headers);
      expect(normalized.headers).toEqual({
        "Content-Type": "application/json",
        "X-Request-ID": "request-1",
      });
      expect(headers).toEqual({
        "Content-Type": " application/json ",
        "X-Request-ID": "request-1",
      });
    });

    it("rejects non-string header values", () => {
      const headers: Record<string, string> = {};
      Object.defineProperty(headers, "x-count", {
        enumerable: true,
        value: 1,
      });
      const malformed = createResponse("body", { headers });

      const error = captureInvalidResponse(() =>
        normalizeResponse(malformed, "GET"),
      );

      expect(error.code).toBe("INVALID_RESPONSE");
      expect(error.context).toMatchObject({ headerName: "x-count" });
    });

    it.each([
      ["bad header", "value"],
      ["x-valid", "line one\nline two"],
    ])("rejects invalid header %s", (name, value) => {
      const error = captureInvalidResponse(() =>
        normalizeResponse(
          createResponse("body", { headers: { [name]: value } }),
          "GET",
        ),
      );

      expect(error.code).toBe("INVALID_RESPONSE");
      expect(error.context).toMatchObject({ headerName: name });
    });

    it("rejects symbol header names", () => {
      const headers: Record<string, string> = { "x-valid": "value" };
      Object.defineProperty(headers, Symbol("hidden-header"), {
        enumerable: true,
        value: "invalid",
      });

      captureInvalidResponse(() =>
        normalizeResponse(createResponse("body", { headers }), "GET"),
      );
    });

    it.each([
      ["Content-Type", "content-type"],
      ["X-Test", "x-TEST"],
    ])("rejects case-insensitive duplicate headers %s and %s", (first, second) => {
      const error = captureInvalidResponse(() =>
        normalizeResponse(
          createResponse("body", {
            headers: { [first]: "first", [second]: "second" },
          }),
          "GET",
        ),
      );

      expect(error.context).toMatchObject({ headerName: second });
    });

    it.each([
      "\u0001",
      "\u000b",
      "\u001f",
      "\u007f",
    ])("rejects transport-invalid header control %j", (control) => {
      captureInvalidResponse(() =>
        normalizeResponse(
          createResponse("body", {
            headers: { "x-invalid": `before${control}after` },
          }),
          "GET",
        ),
      );
    });

    it("allows an internal horizontal tab in a header value", () => {
      expect(
        normalizeResponse(
          createResponse("body", { headers: { "x-tab": "before\tafter" } }),
          "GET",
        ).headers,
      ).toEqual({ "x-tab": "before\tafter" });
    });

    it("validates and normalizes headers without the platform Headers API", () => {
      vi.stubGlobal("Headers", undefined);

      expect(
        normalizeResponse(
          createResponse("body", {
            headers: { "X-Fallback": " value " },
          }),
          "GET",
        ).headers,
      ).toEqual({ "X-Fallback": "value" });

      captureInvalidResponse(() =>
        normalizeResponse(
          createResponse("body", { headers: { "bad header": "value" } }),
          "GET",
        ),
      );

      for (const control of ["\u0001", "\u000b", "\u001f", "\u007f"]) {
        captureInvalidResponse(() =>
          normalizeResponse(
            createResponse("body", {
              headers: { "x-invalid": `before${control}after` },
            }),
            "GET",
          ),
        );
      }
    });
  });

  describe("body values", () => {
    it("preserves strings exactly", () => {
      const body = " plain text \u0000 with spacing ";

      expect(normalizeResponse(createResponse(body), "GET").body).toBe(body);
    });

    it("copies the visible bytes from top-level binary views", () => {
      const source = new Uint8Array([9, 1, 2, 9]);
      const view = new DataView(source.buffer, 1, 2);

      const normalized = normalizeResponse(createResponse(view), "GET");

      expect(normalized.body).toBeInstanceOf(Uint8Array);
      expect(normalized.body).not.toBe(view);
      if (!(normalized.body instanceof Uint8Array)) {
        throw new Error("Expected normalized binary body");
      }
      expect(Array.from(normalized.body)).toEqual([1, 2]);
      source[1] = 8;
      expect(Array.from(normalized.body)).toEqual([1, 2]);
    });

    it("copies top-level ArrayBuffer bytes", () => {
      const source = new Uint8Array([6, 7, 8]);

      const normalized = normalizeResponse(
        createResponse(source.buffer),
        "GET",
      );

      expect(normalized.body).toBeInstanceOf(Uint8Array);
      if (!(normalized.body instanceof Uint8Array)) {
        throw new Error("Expected normalized binary body");
      }
      source[0] = 0;
      expect(Array.from(normalized.body)).toEqual([6, 7, 8]);
    });

    it("copies binary views backed by SharedArrayBuffer into ArrayBuffer", () => {
      const source = new Uint8Array(new SharedArrayBuffer(3));
      source.set([3, 4, 5]);

      const normalized = normalizeResponse(createResponse(source), "GET");

      expect(normalized.body).toBeInstanceOf(Uint8Array);
      if (!(normalized.body instanceof Uint8Array)) {
        throw new Error("Expected normalized binary body");
      }
      expect(normalized.body.buffer).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(normalized.body)).toEqual([3, 4, 5]);
    });

    it("accepts and clones ordinary JSON-serializable values", () => {
      const body = {
        active: true,
        count: 2,
        createdAt: new Date("2026-08-09T12:00:00.000Z"),
        items: [null, "value"],
      };

      const normalized = normalizeResponse(createResponse(body), "GET");

      expect(normalized.body).toEqual({
        active: true,
        count: 2,
        createdAt: "2026-08-09T12:00:00.000Z",
        items: [null, "value"],
      });
      expect(normalized.body).not.toBe(body);
    });

    it("materializes custom JSON serialization once", () => {
      let calls = 0;
      const body = {
        toJSON() {
          calls += 1;
          return { calls };
        },
      };

      const normalized = normalizeResponse(createResponse(body), "GET");

      expect(normalized.body).toEqual({ calls: 1 });
      expect(serializedText(normalized)).toBe('{"calls":1}');
      expect(calls).toBe(1);
    });

    it.each([
      ["function", () => "value"],
      ["symbol", Symbol("value")],
      ["bigint", 1n],
      ["NaN", Number.NaN],
      ["infinity", Number.POSITIVE_INFINITY],
      ["promise", Promise.resolve("value")],
      ["stream", new ReadableStream()],
      ["map", new Map([["key", "value"]])],
    ] satisfies Array<
      [string, unknown]
    >)("rejects an incompatible top-level %s body", (_label, body) => {
      const error = captureInvalidResponse(() =>
        normalizeResponse(createResponse(body), "GET"),
      );

      expect(error.code).toBe("INVALID_RESPONSE");
    });

    it.each([
      ["function", { value: () => "hidden" }],
      ["symbol", { value: Symbol("hidden") }],
      ["bigint", { value: 1n }],
      ["undefined", { value: undefined }],
      ["non-finite number", { value: Number.NEGATIVE_INFINITY }],
      ["binary", { value: new Uint8Array([1]) }],
    ] satisfies Array<
      [string, unknown]
    >)("rejects a nested %s instead of silently changing it", (_label, body) => {
      captureInvalidResponse(() =>
        normalizeResponse(createResponse(body), "GET"),
      );
    });

    it("rejects circular bodies with a structured error", () => {
      const body: Record<string, unknown> = { value: "kept" };
      body.self = body;

      const error = captureInvalidResponse(() =>
        normalizeResponse(createResponse(body), "GET"),
      );

      expect(error.code).toBe("INVALID_RESPONSE");
    });

    it("rejects sparse arrays instead of silently inserting null", () => {
      const body = new Array<unknown>(1);

      captureInvalidResponse(() =>
        normalizeResponse(createResponse(body), "GET"),
      );
    });
  });
});

describe("response body serialization", () => {
  describe("body representation", () => {
    it("returns undefined for an absent body", () => {
      expect(serializeResponseBody(createResponse(undefined))).toBeUndefined();
    });

    it.each([
      204, 205, 304,
    ])("returns undefined for status %i before validating its body", (status) => {
      const body: Record<string, unknown> = {};
      body.self = body;

      expect(
        serializeResponseBody(createResponse(body, { status })),
      ).toBeUndefined();
    });

    it("emits copied binary bytes without JSON serialization", () => {
      const source = new Uint8Array([0, 1, 255]);

      const serialized = serializeResponseBody(createResponse(source));

      expect(serialized).toEqual(new Uint8Array([0, 1, 255]));
      expect(serialized).not.toBe(source);
      expect(serialized?.buffer).toBeInstanceOf(ArrayBuffer);
    });

    it("preserves the Buffer subclass while copying binary bodies", () => {
      const source = Buffer.from("hello");

      const normalized = normalizeResponse(createResponse(source), "GET");

      expect(Buffer.isBuffer(normalized.body)).toBe(true);
      expect(normalized.body).not.toBe(source);
      expect((normalized.body as Buffer).toString("utf8")).toBe("hello");
      // The copy is isolated: mutating it must not touch the route's value.
      (normalized.body as Buffer)[0] = 0x58;
      expect(source.toString("utf8")).toBe("hello");
    });

    it.each([
      ["no content type", {}, "plain text"],
      ["text content type", { "content-type": "text/plain" }, "Gruezi"],
    ])("emits raw strings for %s", (_label, headers, body) => {
      expect(serializedText(createResponse(body, { headers }))).toBe(body);
    });

    it.each([
      ["application/json", { "content-type": "application/json" }],
      [
        "structured JSON suffix",
        { "Content-Type": "Application/Problem+JSON; charset=utf-8" },
      ],
    ])("emits string bodies verbatim under %s instead of double-encoding", (_label, headers) => {
      // A string body is pre-serialized wire bytes: quoting it would
      // double-encode routes that return JSON.stringify(...) themselves.
      const preSerialized = JSON.stringify({ a: 1 });
      expect(serializedText(createResponse(preSerialized, { headers }))).toBe(
        preSerialized,
      );
    });

    it("emits UTF-8 JSON bytes for non-string values", () => {
      expect(
        serializedText(
          createResponse(
            { message: "Gr\u00fcezi", ok: true },
            { headers: { "content-type": "application/json" } },
          ),
        ),
      ).toBe('{"message":"Gr\u00fcezi","ok":true}');
      expect(serializedText(createResponse(null))).toBe("null");
    });

    it("distinguishes an empty string from an absent body", () => {
      expect(serializeResponseBody(createResponse(""))).toEqual(
        new Uint8Array(),
      );
    });

    it("rejects incompatible bodies with INVALID_RESPONSE", () => {
      const error = captureInvalidResponse(() =>
        serializeResponseBody(createResponse(() => "hidden")),
      );

      expect(error.code).toBe("INVALID_RESPONSE");
    });
  });
});
