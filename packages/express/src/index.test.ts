import type { MockInstance } from "@schmock/builder";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { toExpress } from "./index";

describe("toExpress", () => {
  it("converts Schmock mock to Express middleware", () => {
    const mockInstance: MockInstance = {
      handle: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    const middleware = toExpress(mockInstance);

    expect(middleware).toBeTypeOf("function");
    expect(middleware.length).toBe(3); // req, res, next
  });

  it("calls mock.handle with correct parameters", async () => {
    const mockResponse = {
      status: 200,
      body: { message: "Hello" },
      headers: { "Content-Type": "application/json" },
    };

    const mockInstance: MockInstance = {
      handle: vi.fn().mockResolvedValue(mockResponse),
      on: vi.fn(),
      off: vi.fn(),
    };

    const req = {
      method: "GET",
      path: "/api/test",
      headers: { authorization: "Bearer token" },
      body: undefined,
      query: { page: "1" },
    } as unknown as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn(),
      send: vi.fn(),
      end: vi.fn(),
    } as unknown as Response;

    const next = vi.fn() as NextFunction;

    const middleware = toExpress(mockInstance);
    await middleware(req, res, next);

    expect(mockInstance.handle).toHaveBeenCalledWith("GET", "/api/test", {
      headers: { authorization: "Bearer token" },
      body: undefined,
      query: { page: "1" },
    });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.set).toHaveBeenCalledWith("Content-Type", "application/json");
    expect(res.json).toHaveBeenCalledWith({ message: "Hello" });
    expect(next).not.toHaveBeenCalled();
  });

  it("handles string responses", async () => {
    const mockInstance: MockInstance = {
      handle: vi.fn().mockResolvedValue({
        status: 200,
        body: "Plain text response",
        headers: {},
      }),
      on: vi.fn(),
      off: vi.fn(),
    };

    const req = {
      method: "GET",
      path: "/",
      headers: {},
      query: {},
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    const middleware = toExpress(mockInstance);
    await middleware(req, res, next);

    expect(res.send).toHaveBeenCalledWith("Plain text response");
    expect(res.json).not.toHaveBeenCalled();
  });

  it("passes errors to next()", async () => {
    const error = new Error("Mock error");
    const mockInstance: MockInstance = {
      handle: vi.fn().mockRejectedValue(error),
      on: vi.fn(),
      off: vi.fn(),
    };

    const req = {
      method: "GET",
      path: "/",
      headers: {},
      query: {},
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    const middleware = toExpress(mockInstance);
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
