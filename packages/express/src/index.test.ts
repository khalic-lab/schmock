import type { CallableMockInstance } from "@schmock/core";
import { ROUTE_NOT_FOUND_CODE, SchmockError } from "@schmock/core";
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
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.set).toHaveBeenCalledWith("Content-Type", "application/json");
    expect(res.json).toHaveBeenCalledWith({ message: "Hello" });
    expect(next).not.toHaveBeenCalled();
  });

  it("handles string responses with res.send", async () => {
    const mock = createMock(() =>
      Promise.resolve({ status: 200, body: "Plain text", headers: {} }),
    );
    const res = createRes();
    const next = vi.fn() as NextFunction;

    await toExpress(mock)(createReq(), res, next);

    expect(res.send).toHaveBeenCalledWith("Plain text");
    expect(res.json).not.toHaveBeenCalled();
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
      expect(res.send).toHaveBeenCalledWith("modified");
      expect(res.set).toHaveBeenCalledWith("x-modified", "true");
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
      expect(res.json).toHaveBeenCalledWith({ data: true });
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
      expect(res.json).toHaveBeenCalledWith({
        custom: true,
        msg: "Test error",
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
      expect(res.json).toHaveBeenCalledWith({
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

      expect(res.json).toHaveBeenCalledWith({
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

      expect(res.json).toHaveBeenCalledWith({
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
    it("sends status 0 when status is explicitly 0", async () => {
      const mock = createMock(() =>
        Promise.resolve({ status: 0, body: "ok", headers: {} }),
      );
      const res = createRes();
      const next = vi.fn() as NextFunction;

      await toExpress(mock)(createReq(), res, next);

      expect(res.status).toHaveBeenCalledWith(0);
      expect(res.send).toHaveBeenCalledWith("ok");
    });

    it("skips non-string header values in response", async () => {
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

      expect(res.set).toHaveBeenCalledWith("valid", "yes");
      expect(res.set).toHaveBeenCalledTimes(1);
    });

    it("transforms undefined header values to empty string", async () => {
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
          headers: { "x-missing": "" },
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
      expect(res.send).toHaveBeenCalledWith("Not found string");
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
