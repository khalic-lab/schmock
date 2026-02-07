import { describe, expect, it } from "vitest";
import { validationPlugin } from "./index";

describe("validationPlugin", () => {
  it("creates a plugin with correct name", () => {
    const plugin = validationPlugin({
      request: {
        body: { type: "object" },
      },
    });
    expect(plugin.name).toBe("validation");
    expect(plugin.version).toBe("1.0.0");
  });

  it("passes through non-matching requests", async () => {
    const plugin = validationPlugin({
      request: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    });

    // No body in context — validation skipped
    const result = await plugin.process(
      {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: {},
        headers: {},
        state: new Map(),
      },
      "original response",
    );

    expect(result.response).toBe("original response");
  });

  it("rejects invalid request body", async () => {
    const plugin = validationPlugin({
      request: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    });

    const result = await plugin.process(
      {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        body: { age: 25 },
        state: new Map(),
      },
      undefined,
    );

    expect(result.response).toEqual(
      expect.objectContaining({
        status: 400,
        body: expect.objectContaining({
          code: "REQUEST_VALIDATION_ERROR",
        }),
      }),
    );
  });

  it("validates response body", async () => {
    const plugin = validationPlugin({
      response: {
        body: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "number" } },
        },
      },
    });

    const result = await plugin.process(
      {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: {},
        headers: {},
        state: new Map(),
      },
      { id: "not-a-number" },
    );

    expect(result.response).toEqual(
      expect.objectContaining({
        status: 500,
        body: expect.objectContaining({
          code: "RESPONSE_VALIDATION_ERROR",
        }),
      }),
    );
  });

  it("uses custom error status codes", async () => {
    const plugin = validationPlugin({
      request: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
      requestErrorStatus: 422,
    });

    const result = await plugin.process(
      {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        body: {},
        state: new Map(),
      },
      undefined,
    );

    expect(result.response).toEqual(expect.objectContaining({ status: 422 }));
  });
});
