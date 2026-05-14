import { describe, expect, it } from "vitest";
import { version as packageVersion } from "../package.json";
import { validationPlugin } from "./index";

describe("validationPlugin", () => {
  it("creates a plugin with correct name", () => {
    const plugin = validationPlugin({
      request: {
        body: { type: "object" },
      },
    });
    expect(plugin.name).toBe("validation");
    expect(plugin.version).toBe(packageVersion);
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

  describe("edge cases", () => {
    it("skips request body validation when body is undefined (GET request)", async () => {
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
          method: "GET",
          params: {},
          query: {},
          headers: {},
          state: new Map(),
        },
        { id: 1, name: "Alice" },
      );

      // Body validation skipped — response passes through
      expect(result.response).toEqual({ id: 1, name: "Alice" });
    });

    it("unwraps status tuple [201, body] for response validation", async () => {
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
          method: "POST",
          params: {},
          query: {},
          headers: {},
          state: new Map(),
        },
        [201, { id: 42 }],
      );

      // Valid tuple response passes through
      expect(result.response).toEqual([201, { id: 42 }]);
    });

    it("validates null body from status tuple [400, null, {}]", async () => {
      const plugin = validationPlugin({
        response: {
          body: {
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } },
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
        [400, null, {}],
      );

      // null doesn't match required object schema → validation error
      expect(result.response).toEqual(
        expect.objectContaining({
          status: 500,
          body: expect.objectContaining({
            code: "RESPONSE_VALIDATION_ERROR",
          }),
        }),
      );
    });

    it("normalizes mixed-case headers to lowercase before validation", async () => {
      const plugin = validationPlugin({
        request: {
          headers: {
            type: "object",
            required: ["x-api-key"],
            properties: { "x-api-key": { type: "string" } },
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
          headers: { "X-Api-Key": "secret-123" },
          state: new Map(),
        },
        { data: "ok" },
      );

      // Header validation passes because mixed-case is normalized
      expect(result.response).toEqual({ data: "ok" });
    });

    it("returns early on first validation failure without checking later rules", async () => {
      const plugin = validationPlugin({
        request: {
          body: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
          query: {
            type: "object",
            required: ["page"],
            properties: { page: { type: "string" } },
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
          body: { wrong: "field" },
          state: new Map(),
        },
        undefined,
      );

      // Fails on request body first → REQUEST_VALIDATION_ERROR, not QUERY_VALIDATION_ERROR
      expect(result.response).toEqual(
        expect.objectContaining({
          status: 400,
          body: expect.objectContaining({
            code: "REQUEST_VALIDATION_ERROR",
          }),
        }),
      );
    });
  });

  describe("failure modes", () => {
    it("throws when schema cannot be compiled by AJV", () => {
      expect(() =>
        validationPlugin({
          request: {
            body: {
              type: "object",
              properties: {
                name: {
                  // @ts-expect-error — intentionally invalid schema keyword
                  invalidKeyword: true,
                },
              },
              // Use strict-mode violation: additionalProperties on a non-object type
              // AJV with strict mode rejects unknown keywords
            } as any,
          },
        }),
      ).toThrow();
    });
  });
});
