import { describe, expect, it } from "vitest";
import { version as packageVersion } from "../package.json";
import { validationPlugin } from "./index";

async function runBeforeRequest(
  plugin: Schmock.Plugin,
  context: Schmock.PluginContext,
): Promise<Schmock.PluginResult> {
  if (!plugin.beforeRequest) {
    throw new Error("Expected validation plugin to define beforeRequest");
  }
  const result = await plugin.beforeRequest(context);
  if (!result) {
    throw new Error("Expected beforeRequest to return a plugin result");
  }
  return result;
}

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
    const context: Schmock.PluginContext = {
      path: "/test",
      route: {},
      method: "GET",
      params: {},
      query: {},
      headers: {},
      state: new Map(),
    };
    const preflight = await runBeforeRequest(plugin, context);
    const result = await plugin.process(preflight.context, "original response");

    expect(result.response).toBe("original response");
  });

  it("rejects an absent required body without requiring a body schema", async () => {
    const plugin = validationPlugin({
      request: { bodyRequired: true },
    });

    const result = await runBeforeRequest(plugin, {
      path: "/test",
      route: {},
      method: "POST",
      params: {},
      query: {},
      headers: {},
      state: new Map(),
    });

    expect(result.response).toEqual(
      expect.objectContaining({
        status: 400,
        body: expect.objectContaining({
          code: "REQUEST_VALIDATION_ERROR",
        }),
      }),
    );
  });

  it("does not response-validate a request short-circuit", async () => {
    const plugin = validationPlugin({
      response: {
        body: {
          type: "object",
          required: ["created"],
          properties: { created: { type: "boolean" } },
        },
      },
    });
    const rejection = {
      status: 400,
      body: {
        error: "Request validation failed",
        code: "REQUEST_VALIDATION_ERROR",
      },
    };

    const result = await plugin.process(
      {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        state: new Map(),
        requestShortCircuited: true,
      },
      rejection,
    );

    expect(result.response).toBe(rejection);
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

    const result = await runBeforeRequest(plugin, {
      path: "/test",
      route: {},
      method: "POST",
      params: {},
      query: {},
      headers: {},
      body: { age: 25 },
      state: new Map(),
    });

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

    const result = await runBeforeRequest(plugin, {
      path: "/test",
      route: {},
      method: "POST",
      params: {},
      query: {},
      headers: {},
      body: {},
      state: new Map(),
    });

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

      const preflight = await runBeforeRequest(plugin, {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: {},
        headers: {},
        state: new Map(),
      });
      const result = await plugin.process(preflight.context, {
        id: 1,
        name: "Alice",
      });

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

    it("unwraps a structured response object for response validation", async () => {
      const plugin = validationPlugin({
        response: {
          body: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "number" } },
          },
        },
      });
      const response = {
        status: 201,
        body: { id: 42 },
        headers: { location: "/items/42" },
      };

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
        response,
      );

      expect(result.response).toBe(response);
    });

    it("validates an undefined semantic response body", async () => {
      const plugin = validationPlugin({
        response: { body: { type: "null" } },
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
        undefined,
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

      const result = await runBeforeRequest(plugin, {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: {},
        headers: { "X-Api-Key": "secret-123" },
        state: new Map(),
      });

      // Header validation passes because mixed-case is normalized
      expect(result.response).toBeUndefined();
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

      const result = await runBeforeRequest(plugin, {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        body: { wrong: "field" },
        state: new Map(),
      });

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

  describe("schmock schema markers", () => {
    // PRE-EXISTING strict-mode fix: draft-07 Ajv defaults to strictSchema:true
    // and threw "unknown keyword: schmockNullable" on any @schmock/openapi
    // normalized schema handed to this plugin.
    it("compiles schemas carrying schmock generation markers", async () => {
      const plugin = validationPlugin({
        response: {
          body: {
            type: ["string", "null"],
            schmockNullable: true,
          } as Schmock.JSONSchema7,
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
        null,
      );

      expect(result.response).toBeNull();
    });
  });

  describe("failure modes", () => {
    it("throws when schema cannot be compiled by AJV", () => {
      expect(() =>
        validationPlugin({
          request: {
            body: {
              type: "object",
              patternProperties: {
                "[": { type: "string" },
              },
            },
          },
        }),
      ).toThrow();
    });
  });
});
