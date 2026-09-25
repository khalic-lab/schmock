import type { CallableMockInstance } from "@schmock/core";
import { schmock } from "@schmock/core";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { type ExpressAdapterOptions, toExpress } from "./index";

function appFor(mock: CallableMockInstance, options?: ExpressAdapterOptions) {
  const app = express();
  app.use(toExpress(mock, options));
  return app;
}

function throwingMock(): CallableMockInstance {
  const mock = schmock();
  mock("GET /boom", () => {
    throw new Error("boom");
  });
  return mock;
}

describe("Express consumes core's request admission", () => {
  it("renders a malformed admission as INVALID_REQUEST_ADMISSION", async () => {
    // Core's acquireRequestAdmission throws a SchmockError, where the local
    // copy threw a plain Error rendered as INTERNAL_ERROR.
    // A hand-built stub, as in index.test.ts: a real schmock() instance
    // owns the admission symbol as a non-configurable property.
    const mock = {
      handle: vi.fn(async () => ({ status: 200, body: "ok", headers: {} })),
      [Symbol.for("@schmock/core.request-admission")]: () => ({
        notAnAdmission: true,
      }),
    } as unknown as CallableMockInstance;

    const response = await request(
      appFor(mock, { passErrorsToNext: false }),
    ).get("/ok");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "Schmock returned an invalid request admission",
      code: "INVALID_REQUEST_ADMISSION",
    });
  });

  it("routes through the admission's handle and releases it", async () => {
    const release = vi.fn();
    const admittedHandle = vi.fn(async () => ({
      status: 200,
      body: { admitted: true },
      headers: {},
    }));
    const mock = {
      handle: vi.fn(),
      [Symbol.for("@schmock/core.request-admission")]: () => ({
        handle: admittedHandle,
        release,
      }),
    } as unknown as CallableMockInstance;

    const response = await request(appFor(mock)).get("/ok");

    expect(response.body).toEqual({ admitted: true });
    expect(admittedHandle).toHaveBeenCalledTimes(1);
    expect(mock.handle).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("Express consumes core's default content type", () => {
  it("gives a null body from beforeResponse a JSON content type", async () => {
    // Core's withDefaultContentType treats null as JSON (it serializes as
    // "null"); the local copy left it without a content type.
    const mock = schmock();
    mock("GET /empty", "anything");

    const response = await request(
      appFor(mock, {
        beforeResponse: () => ({ status: 200, body: null, headers: {} }),
      }),
    ).get("/empty");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.text).toBe("null");
  });

  it("keeps octet-stream for binary and no default for strings", async () => {
    const mock = schmock();
    mock("GET /bytes", () => [200, new Uint8Array([1, 2, 3])]);
    mock("GET /text", "plain");
    const app = appFor(mock, {
      beforeResponse: (res) =>
        typeof res.body === "string"
          ? { status: 200, body: res.body, headers: {} }
          : res,
    });

    const bytes = await request(app).get("/bytes");
    const text = await request(app).get("/text");

    expect(bytes.headers["content-type"]).toBe("application/octet-stream");
    expect(text.headers["content-type"]).toBeUndefined();
    expect(text.text).toBe("plain");
  });
});

describe("Express consumes core's formatted error builder", () => {
  it("keeps inherited headers, forces JSON and runs the formatter once", async () => {
    const errorFormatter = vi.fn((error: Error) => ({ oops: error.message }));
    const response = await request(
      appFor(throwingMock(), {
        errorFormatter,
        beforeResponse: (res) => ({
          ...res,
          headers: {
            ...res.headers,
            "Content-Type": "text/plain",
            "retry-after": "5",
          },
        }),
      }),
    ).get("/boom");

    expect(errorFormatter).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.body).toEqual({ oops: "boom" });
  });

  it("keeps the formatted body when the inherited headers cannot be sent", async () => {
    const errorFormatter = vi.fn(() => ({ formatted: true }));
    const response = await request(
      appFor(throwingMock(), {
        errorFormatter,
        beforeResponse: (res) => ({
          ...res,
          headers: { ...res.headers, "x-bad": "a\nb" },
        }),
      }),
    ).get("/boom");

    expect(errorFormatter).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
    expect(response.headers["x-bad"]).toBeUndefined();
    expect(response.body).toEqual({ formatted: true });
  });

  it("falls back to the minimal body when the formatter throws", async () => {
    const errorFormatter = vi.fn(() => {
      throw new Error("formatter broke");
    });
    const response = await request(
      appFor(throwingMock(), { errorFormatter }),
    ).get("/boom");

    expect(errorFormatter).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body).toEqual({
      error: "Internal Server Error",
      code: "INTERNAL_ERROR",
    });
  });

  it("passes the Express request to the formatter", async () => {
    const errorFormatter = vi.fn((_error: Error, req: express.Request) => ({
      path: req.path,
    }));
    const response = await request(
      appFor(throwingMock(), { errorFormatter }),
    ).get("/boom");

    expect(response.body).toEqual({ path: "/boom" });
  });
});
