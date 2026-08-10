import { EventEmitter } from "node:events";
import type { CallableMockInstance } from "@schmock/core";
import { ROUTE_NOT_FOUND_CODE, SchmockError, schmock } from "@schmock/core";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { toExpress } from "./index";

function createMock(handleFn: (...args: any[]) => any): CallableMockInstance {
  return { handle: vi.fn(handleFn), pipe: vi.fn() } as any;
}

function createReq(
  overrides: Partial<{
    method: string;
    path: string;
    headers: any;
    body: any;
    query: any;
  }> = {},
): Request {
  return {
    method: "GET",
    path: "/",
    headers: {},
    body: undefined,
    query: {},
    ...overrides,
  } as unknown as Request;
}

function createRes() {
  return {
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    json: vi.fn(),
    send: vi.fn(),
    end: vi.fn(),
  } as unknown as Response;
}

function endedBody(res: Response): Buffer {
  const body: unknown = vi.mocked(res.end).mock.calls.at(-1)?.[0];
  if (!Buffer.isBuffer(body)) {
    throw new Error("Expected Express to end with a Buffer body");
  }
  return body;
}

function endedText(res: Response): string {
  return endedBody(res).toString("utf8");
}

function endedJson(res: Response): unknown {
  const parsed: unknown = JSON.parse(endedText(res));
  return parsed;
}

/** A core-synthesized exception 500, marked exactly as the builder marks it. */
function markedException(message = "route blew up") {
  const response = {
    status: 500,
    body: { error: message, code: "INTERNAL_ERROR" },
    headers: { "content-type": "application/json" } as Record<string, string>,
  };
  Object.defineProperty(response, Symbol.for("@schmock/core.response-origin"), {
    configurable: true,
    value: { kind: "exception", error: new Error(message) },
  });
  return response;
}

function arrayBufferViewCases(): Array<[string, ArrayBufferView]> {
  const buffer = Uint8Array.from({ length: 32 }, (_, index) => index).buffer;
  const sharedBytes = new Uint8Array(new SharedArrayBuffer(4));
  sharedBytes.set([31, 32, 33, 34]);

  return [
    ["DataView", new DataView(buffer, 1, 5)],
    ["Int8Array", new Int8Array(buffer, 1, 5)],
    ["Uint8Array", new Uint8Array(buffer, 1, 5)],
    ["Uint8ClampedArray", new Uint8ClampedArray(buffer, 1, 5)],
    ["Int16Array", new Int16Array(buffer, 2, 2)],
    ["Uint16Array", new Uint16Array(buffer, 2, 2)],
    ["Int32Array", new Int32Array(buffer, 4, 2)],
    ["Uint32Array", new Uint32Array(buffer, 4, 2)],
    ["Float32Array", new Float32Array(buffer, 4, 2)],
    ["Float64Array", new Float64Array(buffer, 8, 1)],
    ["BigInt64Array", new BigInt64Array(buffer, 8, 1)],
    ["BigUint64Array", new BigUint64Array(buffer, 8, 1)],
    ["SharedArrayBuffer view", sharedBytes],
  ];
}

describe("toExpress", () => {
  it("converts Schmock mock to Express middleware", () => {
    const middleware = toExpress(createMock(() => ({})));
    expect(middleware).toBeTypeOf("function");
    expect(middleware.length).toBe(3);
  });

  it("calls mock.handle with correct parameters", async () => {
    const mockResponse = {
      status: 200,
      body: { message: "Hello" },
      headers: { "Content-Type": "application/json" },
    };
    const mock = createMock(() => Promise.resolve(mockResponse));
    const req = createReq({
      method: "GET",
      path: "/api/test",
      headers: { authorization: "Bearer token" },
      query: { page: "1" },
    });
    const res = createRes();
    const next = vi.fn() as NextFunction;

    await toExpress(mock)(req, res, next);

    expect(mock.handle).toHaveBeenCalledWith("GET", "/api/test", {
      headers: { authorization: "Bearer token" },
      body: undefined,
      query: { page: "1" },
      signal: expect.any(AbortSignal),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.set).toHaveBeenCalledWith("Content-Type", "application/json");
    expect(endedJson(res)).toEqual({ message: "Hello" });
    expect(next).not.toHaveBeenCalled();
  });

  it("writes string responses as serialized bytes", async () => {
    const mock = createMock(() =>
      Promise.resolve({ status: 200, body: "Plain text", headers: {} }),
    );
    const res = createRes();
    const next = vi.fn() as NextFunction;

    await toExpress(mock)(createReq(), res, next);

    expect(endedText(res)).toBe("Plain text");
    expect(res.json).not.toHaveBeenCalled();
  });

  it("converts ArrayBuffer bodies to Buffer for Express 4 compatibility", async () => {
    const body = new Uint8Array([1, 2, 3]).buffer;
    const mock = createMock(() =>
      Promise.resolve({ status: 200, body, headers: {} }),
    );
    const res = createRes();

    await toExpress(mock)(createReq(), res, vi.fn());

    const sentBody = endedBody(res);
    expect(res.set).toHaveBeenCalledWith(
      "content-type",
      "application/octet-stream",
    );
    expect([...sentBody]).toEqual([1, 2, 3]);
  });

  it.each(
    arrayBufferViewCases(),
  )("converts %s bodies to Buffer for Express 4 compatibility", async (_name, body) => {
    const mock = createMock(() =>
      Promise.resolve({ status: 200, body, headers: {} }),
    );
    const res = createRes();

    await toExpress(mock)(createReq(), res, vi.fn());

    const sentBody = endedBody(res);
    expect(res.set).toHaveBeenCalledWith(
      "content-type",
      "application/octet-stream",
    );
    expect([...sentBody]).toEqual([
      ...new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    ]);
  });

  it("handles empty body with res.end", async () => {
    const mock = createMock(() =>
      Promise.resolve({ status: 204, body: undefined, headers: {} }),
    );
    const res = createRes();
    const next = vi.fn() as NextFunction;

    await toExpress(mock)(createReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it("passes errors to next() by default", async () => {
    const error = new Error("Mock error");
    const mock = createMock(() => Promise.reject(error));
    const res = createRes();
    const next = vi.fn() as NextFunction;

    await toExpress(mock)(createReq(), res, next);

    expect(next).toHaveBeenCalledWith(error);
  });

  describe("ROUTE_NOT_FOUND passthrough", () => {
    it("calls next() when route is not found", async () => {
      const mock = createMock(() =>
        Promise.resolve({
          status: 404,
          body: { error: "Route not found", code: ROUTE_NOT_FOUND_CODE },
          headers: {},
        }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock)(createReq(), res, next);

      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("does NOT call next() for non-ROUTE_NOT_FOUND 404", async () => {
      const mock = createMock(() =>
        Promise.resolve({
          status: 404,
          body: { error: "Custom not found", code: "CUSTOM_404" },
          headers: {},
        }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock)(createReq(), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe("beforeRequest interceptor", () => {
    it("modifies request data before handling", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock, {
        beforeRequest: () => ({ path: "/modified", method: "POST" }),
      })(createReq({ method: "GET", path: "/original" }), res, next);

      expect(mock.handle).toHaveBeenCalledWith(
        "POST",
        "/modified",
        expect.any(Object),
      );
    });

    it("does nothing when interceptor returns undefined", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock, {
        beforeRequest: () => undefined,
      })(createReq({ path: "/original" }), res, next);

      expect(mock.handle).toHaveBeenCalledWith(
        "GET",
        "/original",
        expect.any(Object),
      );
    });

    it("retains the admitted generation across an async adapter hook", async () => {
      const realMock = schmock();
      const uninstall = vi.fn();
      realMock("GET /generation", "old").pipe({
        name: "old-generation",
        process: (context, response) => ({ context, response }),
        uninstall,
      });
      let announceHookStart = () => {};
      let releaseHook = () => {};
      const hookStarted = new Promise<void>((resolve) => {
        announceHookStart = resolve;
      });
      const hookBarrier = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      const res = createRes();
      const staleStart = vi.fn();
      const middleware = toExpress(realMock, {
        async beforeRequest() {
          announceHookStart();
          await hookBarrier;
        },
      });

      const pending = middleware(
        createReq({ path: "/generation" }),
        res,
        vi.fn(),
      );
      await hookStarted;
      realMock.reset();
      expect(uninstall).not.toHaveBeenCalled();
      realMock.on("request:start", staleStart);
      realMock("GET /generation", "new");
      releaseHook();
      await pending;

      expect(endedText(res)).toBe("old");
      expect(uninstall).toHaveBeenCalledOnce();
      expect(staleStart).not.toHaveBeenCalled();
    });
  });

  describe("beforeResponse interceptor", () => {
    it("modifies response before sending", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "original", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock, {
        beforeResponse: () => ({
          status: 201,
          body: "modified",
          headers: { "x-modified": "true" },
        }),
      })(createReq(), res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(endedText(res)).toBe("modified");
      expect(res.set).toHaveBeenCalledWith("x-modified", "true");
    });

    it("drops stale framing when a response hook changes the body", async () => {
      const mock = createMock(() =>
        Promise.resolve({
          status: 200,
          body: "x",
          headers: { "Content-Length": "1" },
        }),
      );
      const res = createRes();

      await toExpress(mock, {
        beforeResponse: (response) => ({
          ...response,
          body: "a longer body",
        }),
      })(createReq(), res, vi.fn());

      expect(endedText(res)).toBe("a longer body");
      expect(res.set).not.toHaveBeenCalledWith("Content-Length", "1");
    });

    it("suppresses a body added to a 204 response", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "original", headers: {} }),
      );
      const res = createRes();

      await toExpress(mock, {
        beforeResponse: () => ({
          status: 204,
          body: { forbidden: true },
          headers: {},
        }),
      })(createReq(), res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(204);
      expect(vi.mocked(res.end).mock.calls[0]?.[0]).toBeUndefined();
    });

    it("does nothing when interceptor returns undefined", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: { data: true }, headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock, {
        beforeResponse: () => undefined,
      })(createReq(), res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(endedJson(res)).toEqual({ data: true });
    });
  });

  describe("error handling options", () => {
    it("uses custom error formatter for SchmockError", async () => {
      const schmockError = new SchmockError("Test error", "TEST_CODE");
      const mock = createMock(() => Promise.reject(schmockError));
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock, {
        errorFormatter: (err) => ({ custom: true, msg: err.message }),
      })(createReq(), res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(endedJson(res)).toEqual({
        custom: true,
        msg: "Test error",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("falls back to a safe 500 when the formatter output is not serializable", async () => {
      const schmockError = new SchmockError("Test error", "TEST_CODE");
      const mock = createMock(() => Promise.reject(schmockError));
      const res = createRes();
      const next = vi.fn() as NextFunction;
      // An embedded Error is rejected by the response normalizer; the
      // adapter must not re-invoke the formatter or escape to Express's
      // default HTML error handler (which leaks a stack trace).
      const errorFormatter = vi.fn((err: Error) => ({ cause: err }));

      await toExpress(mock, { errorFormatter })(createReq(), res, next);

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(endedJson(res)).toEqual({
        error: "Internal Server Error",
        code: "INTERNAL_ERROR",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("sends the safe 500 fallback when the formatter itself throws", async () => {
      const mock = createMock(() => Promise.reject(new Error("boom")));
      const res = createRes();
      const next = vi.fn() as NextFunction;
      // The formatter runs inside the send guard: it must fire exactly once
      // and never escape into Express's default HTML error handler.
      const errorFormatter = vi.fn(() => {
        throw new Error("formatter exploded");
      });

      await toExpress(mock, { errorFormatter })(createReq(), res, next);

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(endedJson(res)).toEqual({
        error: "Internal Server Error",
        code: "INTERNAL_ERROR",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("formats a core exception response once even when the formatter throws", async () => {
      // A resolved 500 marked as a core exception reaches the formatter on
      // the success path; a throw there must not re-invoke the formatter
      // from the outer catch with its own exception.
      const marked = {
        status: 500,
        body: { error: "route blew up", code: "INTERNAL_ERROR" },
        headers: { "content-type": "application/json" },
      };
      Object.defineProperty(
        marked,
        Symbol.for("@schmock/core.response-origin"),
        {
          configurable: true,
          value: { kind: "exception", error: new Error("route blew up") },
        },
      );
      const mock = createMock(() => Promise.resolve(marked));
      const res = createRes();
      const next = vi.fn() as NextFunction;
      const errorFormatter = vi.fn(() => {
        throw new Error("formatter exploded");
      });

      await toExpress(mock, { errorFormatter })(createReq(), res, next);

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(endedJson(res)).toEqual({
        error: "Internal Server Error",
        code: "INTERNAL_ERROR",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("handles errors directly when passErrorsToNext is false", async () => {
      const error = new Error("Direct error");
      const mock = createMock(() => Promise.reject(error));
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock, { passErrorsToNext: false })(
        createReq(),
        res,
        next,
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(endedJson(res)).toEqual({
        error: "Direct error",
        code: "INTERNAL_ERROR",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("includes SchmockError code when passErrorsToNext is false", async () => {
      const schmockError = new SchmockError(
        "Schmock fail",
        "ROUTE_PARSE_ERROR",
      );
      const mock = createMock(() => Promise.reject(schmockError));
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock, { passErrorsToNext: false })(
        createReq(),
        res,
        next,
      );

      expect(endedJson(res)).toEqual({
        error: "Schmock fail",
        code: "ROUTE_PARSE_ERROR",
      });
    });

    it("handles non-Error throws when passErrorsToNext is false", async () => {
      const mock = createMock(() => Promise.reject("string error"));
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock, { passErrorsToNext: false })(
        createReq(),
        res,
        next,
      );

      expect(endedJson(res)).toEqual({
        error: "Internal Server Error",
        code: "INTERNAL_ERROR",
      });
    });
  });

  describe("default transform functions", () => {
    it("transforms array query values", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;
      const req = createReq({ query: { tags: ["a", "b"] } });

      await toExpress(mock)(req, res, next);

      expect(mock.handle).toHaveBeenCalledWith(
        "GET",
        "/",
        expect.objectContaining({ query: { tags: "a" } }),
      );
    });

    it("transforms object query values to string", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;
      const req = createReq({ query: { nested: { a: 1 } } });

      await toExpress(mock)(req, res, next);

      expect(mock.handle).toHaveBeenCalledWith(
        "GET",
        "/",
        expect.objectContaining({ query: { nested: "[object Object]" } }),
      );
    });

    it("transforms array headers to first value", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;
      const req = createReq({
        headers: { "accept-language": ["en", "fr"] },
      });

      await toExpress(mock)(req, res, next);

      expect(mock.handle).toHaveBeenCalledWith(
        "GET",
        "/",
        expect.objectContaining({
          headers: { "accept-language": "en" },
        }),
      );
    });

    it("handles empty array query values", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;
      const req = createReq({ query: { empty: [] } });

      await toExpress(mock)(req, res, next);

      expect(mock.handle).toHaveBeenCalledWith(
        "GET",
        "/",
        expect.objectContaining({ query: { empty: "" } }),
      );
    });
  });

  describe("edge cases", () => {
    it("rejects status 0 before writing an Express response", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 0, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock)(createReq(), res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ code: "INVALID_RESPONSE" }),
      );
      expect(res.status).not.toHaveBeenCalled();
    });

    it("rejects non-string response header values", async () => {
      const mock = createMock(() =>
        Promise.resolve({
          status: 200,
          body: "ok",
          headers: { valid: "yes", invalid: 123 },
        }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock)(createReq(), res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ code: "INVALID_RESPONSE" }),
      );
      expect(res.set).not.toHaveBeenCalled();
    });

    it.each([
      { "Content-Type": "text/plain", "content-type": "application/json" },
      { "x-invalid": "before\u0001after" },
    ])("rejects transport-invalid response headers", async (headers) => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock)(createReq(), res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ code: "INVALID_RESPONSE" }),
      );
      expect(res.status).not.toHaveBeenCalled();
      expect(res.set).not.toHaveBeenCalled();
    });

    it("does not format a deliberate domain 500 as an exception", async () => {
      const mock = createMock(() =>
        Promise.resolve({
          status: 500,
          body: { error: "declined", code: "DOMAIN_DECLINED" },
          headers: { "content-type": "application/json" },
        }),
      );
      const errorFormatter = vi.fn(() => ({ formatted: true }));
      const res = createRes();

      await toExpress(mock, { errorFormatter })(createReq(), res, vi.fn());

      expect(errorFormatter).not.toHaveBeenCalled();
      expect(endedJson(res)).toEqual({
        error: "declined",
        code: "DOMAIN_DECLINED",
      });
    });

    it("formats an exception whose provenance a spreading beforeResponse dropped", async () => {
      // The documented `{...response}` hook copies only own enumerable
      // properties, so the non-enumerable origin symbol is lost. Provenance
      // must therefore be read before the hook runs.
      const mock = createMock(() => Promise.resolve(markedException()));
      const errorFormatter = vi.fn(() => ({ formatted: true }));
      const res = createRes();

      await toExpress(mock, {
        errorFormatter,
        beforeResponse: (response) => ({
          ...response,
          headers: { ...response.headers, "cache-control": "no-cache" },
        }),
      })(createReq(), res, vi.fn());

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(endedJson(res)).toEqual({ formatted: true });
    });

    it("carries the response headers onto the formatted error", async () => {
      const mock = createMock(() => Promise.resolve(markedException()));
      const res = createRes();

      await toExpress(mock, {
        errorFormatter: () => ({ formatted: true }),
        beforeResponse: (response) => ({
          ...response,
          headers: { ...response.headers, "retry-after": "30" },
        }),
      })(createReq(), res, vi.fn());

      expect(res.set).toHaveBeenCalledWith("retry-after", "30");
      expect(res.set).toHaveBeenCalledWith("content-type", "application/json");
      expect(endedJson(res)).toEqual({ formatted: true });
    });

    it("keeps the formatted body when a header value carries a control char", async () => {
      // `err.stack` in a post-hook header is type-legal but not
      // transportable. Dropping the header must not also drop the
      // formatter's body in favour of the minimal fallback.
      const mock = createMock(() => Promise.resolve(markedException()));
      const errorFormatter = vi.fn(() => ({ formatted: true }));
      const res = createRes();

      await toExpress(mock, {
        errorFormatter,
        beforeResponse: (response) => ({
          ...response,
          headers: {
            ...response.headers,
            "x-error": "Error: boom\n    at handler",
          },
        }),
      })(createReq(), res, vi.fn());

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(endedJson(res)).toEqual({ formatted: true });
      // The retry drops every inherited header, not just the bad one.
      expect(vi.mocked(res.set).mock.calls).toEqual([
        ["content-type", "application/json"],
      ]);
    });

    it("keeps the formatted body when post-hook headers duplicate a name", async () => {
      const mock = createMock(() => Promise.resolve(markedException()));
      const errorFormatter = vi.fn(() => ({ formatted: true }));
      const res = createRes();

      await toExpress(mock, {
        errorFormatter,
        beforeResponse: (response) => ({
          ...response,
          headers: {
            ...response.headers,
            "Retry-After": "30",
            "retry-after": "30",
          },
        }),
      })(createReq(), res, vi.fn());

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(endedJson(res)).toEqual({ formatted: true });
      expect(vi.mocked(res.set).mock.calls).toEqual([
        ["content-type", "application/json"],
      ]);
    });

    it("keeps the formatted body when a post-hook header value is not a string", async () => {
      // Plain-JS callers are not protected by the Record<string, string>
      // declaration, so a numeric `retry-after` reaches the normalizer.
      const mock = createMock(() => Promise.resolve(markedException()));
      const errorFormatter = vi.fn(() => ({ formatted: true }));
      const res = createRes();

      await toExpress(mock, {
        errorFormatter,
        beforeResponse: (response) => ({
          ...response,
          headers: {
            ...response.headers,
            "retry-after": 30,
          } as unknown as Record<string, string>,
        }),
      })(createReq(), res, vi.fn());

      expect(errorFormatter).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(endedJson(res)).toEqual({ formatted: true });
      expect(vi.mocked(res.set).mock.calls).toEqual([
        ["content-type", "application/json"],
      ]);
    });

    it("replaces a capitalized Content-Type rather than duplicating it", async () => {
      // Keeping both `Content-Type` and the forced lowercase key makes the
      // pair transport-invalid, which would divert the formatted body into
      // the minimal fallback branch.
      const mock = createMock(() => Promise.resolve(markedException()));
      const res = createRes();

      await toExpress(mock, {
        errorFormatter: () => ({ formatted: true }),
        beforeResponse: (response) => ({
          ...response,
          headers: { "Content-Type": "text/plain" },
        }),
      })(createReq(), res, vi.fn());

      expect(endedJson(res)).toEqual({ formatted: true });
      const contentTypeCalls = vi
        .mocked(res.set)
        .mock.calls.filter(
          ([name]) => String(name).toLowerCase() === "content-type",
        );
      expect(contentTypeCalls).toEqual([["content-type", "application/json"]]);
    });

    it("respects a beforeResponse that rewrites an exception to a non-500", async () => {
      const mock = createMock(() => Promise.resolve(markedException()));
      const errorFormatter = vi.fn(() => ({ formatted: true }));
      const res = createRes();

      await toExpress(mock, {
        errorFormatter,
        beforeResponse: (response) => {
          response.status = 503;
          response.body = { error: "try later" };
          return response;
        },
      })(createReq(), res, vi.fn());

      expect(errorFormatter).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(endedJson(res)).toEqual({ error: "try later" });
    });

    it("respects an in-place status rewrite from a beforeResponse that returns nothing", async () => {
      // The likeliest accidental shape: mutate and forget to return. The
      // pre-hook capture and the post-hook status gate must still agree.
      const mock = createMock(() => Promise.resolve(markedException()));
      const errorFormatter = vi.fn(() => ({ formatted: true }));
      const res = createRes();

      await toExpress(mock, {
        errorFormatter,
        beforeResponse: (response) => {
          response.status = 503;
          response.body = { error: "try later" };
          return undefined;
        },
      })(createReq(), res, vi.fn());

      expect(errorFormatter).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(endedJson(res)).toEqual({ error: "try later" });
    });

    it("resolves and releases listeners when the request admission is malformed", async () => {
      const requestEvents = new EventEmitter();
      const responseEvents = new EventEmitter();
      const req = createReq();
      const res = createRes();
      req.once = requestEvents.once.bind(requestEvents);
      req.off = requestEvents.off.bind(requestEvents);
      res.once = responseEvents.once.bind(responseEvents);
      res.off = responseEvents.off.bind(responseEvents);
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      Object.defineProperty(
        mock,
        Symbol.for("@schmock/core.request-admission"),
        { configurable: true, value: () => ({ notAnAdmission: true }) },
      );
      const next = vi.fn() as NextFunction;

      await expect(toExpress(mock)(req, res, next)).resolves.toBeUndefined();

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Schmock returned an invalid request admission",
        }),
      );
      expect(requestEvents.listenerCount("aborted")).toBe(0);
      expect(responseEvents.listenerCount("close")).toBe(0);
    });

    it("uses a method rewritten to HEAD for formatted errors", async () => {
      const mock = createMock(() => Promise.reject(new Error("failed")));
      const res = createRes();

      await toExpress(mock, {
        beforeRequest: () => ({ method: "HEAD" }),
        errorFormatter: (error) => ({ error: error.message }),
      })(createReq(), res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(500);
      expect(vi.mocked(res.end).mock.calls[0]?.[0]).toBeUndefined();
    });

    it("settles without late work when the request disconnects", async () => {
      const requestEvents = new EventEmitter();
      const responseEvents = new EventEmitter();
      const req = createReq();
      const res = createRes();
      req.once = requestEvents.once.bind(requestEvents);
      req.off = requestEvents.off.bind(requestEvents);
      res.once = responseEvents.once.bind(responseEvents);
      res.off = responseEvents.off.bind(responseEvents);
      let announceHookStart = () => {};
      const hookStarted = new Promise<void>((resolve) => {
        announceHookStart = resolve;
      });
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "late", headers: {} }),
      );
      const middleware = toExpress(mock, {
        async beforeRequest() {
          announceHookStart();
          await new Promise<void>(() => {});
        },
      });

      const pending = middleware(req, res, vi.fn());
      await hookStarted;
      requestEvents.emit("aborted");
      await expect(
        Promise.race([
          pending,
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error("disconnect timed out")), 100);
          }),
        ]),
      ).resolves.toBeUndefined();
      expect(mock.handle).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("drops undefined header values", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;
      const req = createReq({
        headers: { "x-missing": undefined },
      });

      await toExpress(mock)(req, res, next);

      expect(mock.handle).toHaveBeenCalledWith(
        "GET",
        "/",
        expect.objectContaining({
          headers: {},
        }),
      );
    });

    it("skips null query values", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;
      const req = createReq({ query: { present: "yes", missing: null } });

      await toExpress(mock)(req, res, next);

      expect(mock.handle).toHaveBeenCalledWith(
        "GET",
        "/",
        expect.objectContaining({ query: { present: "yes" } }),
      );
    });

    it("handles 404 with non-object body (no passthrough)", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 404, body: "Not found string", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock)(createReq(), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(endedText(res)).toBe("Not found string");
    });

    it("handles 404 with null body (no passthrough)", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 404, body: null, headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock)(createReq(), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe("non-standard HTTP methods", () => {
    it("calls next() for WebDAV methods like PROPFIND", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const req = createReq({ method: "PROPFIND", path: "/resource" });
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock)(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(mock.handle).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("calls next() for LOCK method", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const req = createReq({ method: "LOCK", path: "/resource" });
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock)(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(mock.handle).not.toHaveBeenCalled();
    });
  });

  describe("custom transforms", () => {
    it("uses custom header transform", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock, {
        transformHeaders: () => ({ custom: "header" }),
      })(createReq(), res, next);

      expect(mock.handle).toHaveBeenCalledWith(
        "GET",
        "/",
        expect.objectContaining({ headers: { custom: "header" } }),
      );
    });

    it("uses custom query transform", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 200, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock, {
        transformQuery: () => ({ custom: "query" }),
      })(createReq(), res, next);

      expect(mock.handle).toHaveBeenCalledWith(
        "GET",
        "/",
        expect.objectContaining({ query: { custom: "query" } }),
      );
    });
  });
});
