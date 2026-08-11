import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { version as packageVersion } from "../package.json";
import { type ValidationPluginOptions, validationPlugin } from "./index";

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

  it("does not response-validate its own request rejection", async () => {
    const plugin = validationPlugin({
      request: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
      response: {
        body: {
          type: "object",
          required: ["created"],
          properties: { created: { type: "boolean" } },
        },
      },
    });
    const context: Schmock.PluginContext = {
      path: "/test",
      route: {},
      method: "POST",
      params: {},
      query: {},
      headers: {},
      body: {},
      state: new Map(),
    };

    const rejection = await runBeforeRequest(plugin, context);
    const result = await plugin.process(
      { ...rejection.context, state: new Map() },
      rejection.response,
    );

    expect(result.response).toBe(rejection.response);
  });

  it("response-validates its rejection after another plugin replaces it", async () => {
    const plugin = validationPlugin({
      request: {
        body: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      response: {
        body: {
          type: "object",
          properties: { created: { const: true } },
          required: ["created"],
        },
      },
    });
    const rejection = await runBeforeRequest(plugin, {
      path: "/test",
      route: {},
      method: "POST",
      params: {},
      query: {},
      headers: {},
      body: {},
      state: new Map(),
    });
    const replacement = {
      status: 400,
      body: { code: "REPLACED_REQUEST_REJECTION" },
    };

    const result = await plugin.process(rejection.context, replacement);

    expect(result.response).toMatchObject({
      status: 500,
      body: { code: "RESPONSE_VALIDATION_ERROR" },
    });
  });

  it("response-validates its exact rejection after in-place mutation", async () => {
    const plugin = validationPlugin({
      request: {
        body: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      response: {
        body: {
          type: "object",
          properties: { created: { const: true } },
          required: ["created"],
        },
      },
    });
    const rejection = await runBeforeRequest(plugin, {
      path: "/test",
      route: {},
      method: "POST",
      params: {},
      query: {},
      headers: {},
      body: {},
      state: new Map(),
    });
    if (typeof rejection.response !== "object" || rejection.response === null) {
      throw new Error("Expected an object request rejection");
    }
    Reflect.set(rejection.response, "body", {
      code: "MUTATED_REQUEST_REJECTION",
    });

    const result = await plugin.process(rejection.context, rejection.response);

    expect(result.response).toMatchObject({
      status: 500,
      body: { code: "RESPONSE_VALIDATION_ERROR" },
    });
  });

  it("consumes unchanged self-rejection provenance after one process call", async () => {
    const plugin = validationPlugin({
      request: { bodyRequired: true },
      response: {
        body: {
          type: "object",
          properties: { created: { const: true } },
          required: ["created"],
        },
      },
    });
    const rejection = await runBeforeRequest(plugin, {
      path: "/test",
      route: {},
      method: "POST",
      params: {},
      query: {},
      headers: {},
      state: new Map(),
    });

    const first = await plugin.process(rejection.context, rejection.response);
    const second = await plugin.process(rejection.context, rejection.response);

    expect(first.response).toBe(rejection.response);
    expect(second.response).toMatchObject({
      status: 500,
      body: { code: "RESPONSE_VALIDATION_ERROR" },
    });
  });

  it("response-validates a request rejection from another plugin", async () => {
    const plugin = validationPlugin({
      response: {
        body: {
          type: "object",
          required: ["created"],
          properties: { created: { type: "boolean" } },
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
        requestShortCircuited: true,
      },
      {
        status: 403,
        body: { code: "REJECTED_BY_OTHER_PLUGIN" },
      },
    );

    expect(result.response).toMatchObject({
      status: 500,
      body: { code: "RESPONSE_VALIDATION_ERROR" },
    });
  });

  it("does not confuse another validation instance's rejection with its own", async () => {
    const rejectingValidator = validationPlugin({
      request: {
        body: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    });
    const responseValidator = validationPlugin({
      response: {
        body: {
          type: "object",
          properties: { created: { const: true } },
          required: ["created"],
        },
      },
    });
    const rejection = await runBeforeRequest(rejectingValidator, {
      path: "/test",
      route: {},
      method: "POST",
      params: {},
      query: {},
      headers: {},
      body: {},
      state: new Map(),
    });
    const firstResult = await rejectingValidator.process(
      rejection.context,
      rejection.response,
    );

    const result = await responseValidator.process(
      firstResult.context,
      firstResult.response,
    );

    expect(result.response).toMatchObject({
      status: 500,
      body: { code: "RESPONSE_VALIDATION_ERROR" },
    });
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

    it("shares valid object-form faker syntax with the faker generator", async () => {
      const schema: Schmock.Schema = {
        type: "integer",
        minimum: 1,
        maximum: 2,
        faker: { "number.int": [{ min: 1, max: 2 }] },
      };
      const plugin = validationPlugin({ response: { body: schema } });
      const context: Schmock.PluginContext = {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: {},
        headers: {},
        state: new Map(),
      };

      const accepted = await plugin.process(context, 2);
      const rejected = await plugin.process(context, 3);
      const { generateFromSchema } = await import("../../faker/src/index");
      const generated = await generateFromSchema({ schema, seed: 42 });

      expect(accepted.response).toBe(2);
      expect(rejected.response).toMatchObject({
        status: 500,
        body: { code: "RESPONSE_VALIDATION_ERROR" },
      });
      expect(generated).toSatisfy(
        (value: unknown) =>
          typeof value === "number" && value >= 1 && value <= 2,
      );
    });

    it("clones a shared schema graph containing ignored faker callbacks", async () => {
      const callback = () => "Ada";
      const sharedField: Schmock.Schema = {
        type: "string",
        faker: { callback: [callback] },
      };
      const schema: Schmock.Schema = {
        type: "object",
        properties: { first: sharedField, second: sharedField },
        required: ["first", "second"],
      };
      const plugin = validationPlugin({
        request: { body: schema },
        response: { body: schema },
      });
      const context: Schmock.PluginContext = {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        body: { first: "Ada", second: "Lovelace" },
        state: new Map(),
      };

      const preflight = await runBeforeRequest(plugin, context);
      const result = await plugin.process(context, {
        first: "Ada",
        second: "Lovelace",
      });

      expect(preflight.response).toBeUndefined();
      expect(result.response).toEqual({ first: "Ada", second: "Lovelace" });
    });

    it("does not require the browser structuredClone global", () => {
      const originalStructuredClone = globalThis.structuredClone;
      Reflect.set(globalThis, "structuredClone", undefined);

      try {
        expect(() =>
          validationPlugin({ response: { body: { type: "string" } } }),
        ).not.toThrow();
      } finally {
        Reflect.set(globalThis, "structuredClone", originalStructuredClone);
      }
    });
  });

  describe("own-property validation", () => {
    const ownershipSchema = {
      type: "object" as const,
      properties: { role: { type: "string" as const } },
      required: ["role"],
      additionalProperties: false,
    };

    it("rejects a required property that only exists on the prototype chain", async () => {
      const plugin = validationPlugin({ request: { body: ownershipSchema } });
      // JSON.stringify emits own enumerable properties only, so this body is
      // delivered as `{}` — validation must judge what the transport sends.
      const body: Record<string, unknown> = Object.create({ role: "admin" });

      const result = await runBeforeRequest(plugin, {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        body,
        state: new Map(),
      });

      expect(result.response).toMatchObject({
        status: 400,
        body: { code: "REQUEST_VALIDATION_ERROR" },
      });
    });

    it("ignores inherited extras under additionalProperties: false", async () => {
      const plugin = validationPlugin({ request: { body: ownershipSchema } });
      const body: Record<string, unknown> = Object.create({ evil: 1 });
      body.role = "admin";

      const result = await runBeforeRequest(plugin, {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        body,
        state: new Map(),
      });

      expect(result.response).toBeUndefined();
    });

    it("judges a header literally named __proto__ like any other header", async () => {
      const plugin = validationPlugin({
        request: {
          headers: {
            type: "object",
            properties: { "x-ok": { type: "string" } },
            additionalProperties: false,
          },
        },
      });
      // Built the way core does (own data property, prototype retained), not as
      // an object literal — a literal `__proto__:` key is a prototype setter.
      const headers = Object.fromEntries([
        ["__proto__", "evil"],
        ["x-ok", "1"],
      ]) as Record<string, string>;
      expect(Object.hasOwn(headers, "__proto__")).toBe(true);

      const result = await runBeforeRequest(plugin, {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: {},
        headers,
        state: new Map(),
      });

      expect(result.response).toMatchObject({
        status: 400,
        body: { code: "HEADER_VALIDATION_ERROR" },
      });
    });

    it("lets a __proto__ header satisfy a required rule", async () => {
      const plugin = validationPlugin({
        request: { headers: { type: "object", required: ["__proto__"] } },
      });
      const headers = Object.fromEntries([["__proto__", "present"]]) as Record<
        string,
        string
      >;

      const result = await runBeforeRequest(plugin, {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: {},
        headers,
        state: new Map(),
      });

      expect(result.response).toBeUndefined();
    });
  });

  describe("schema registry isolation", () => {
    it("resolves a response $ref to a request schema in another slot", async () => {
      const schemaId = "https://example.com/referenced-thing.json";
      const plugin = validationPlugin({
        request: {
          body: {
            $id: schemaId,
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
          },
        },
        response: { body: { $ref: schemaId } },
      });
      const context: Schmock.PluginContext = {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        body: { id: 1 },
        state: new Map(),
      };

      const preflight = await runBeforeRequest(plugin, context);
      const accepted = await plugin.process(preflight.context, { id: 1 });
      const rejected = await plugin.process(preflight.context, { id: "1" });

      expect(preflight.response).toBeUndefined();
      expect(accepted.response).toEqual({ id: 1 });
      expect(rejected.response).toMatchObject({
        status: 500,
        body: { code: "RESPONSE_VALIDATION_ERROR" },
      });
    });

    it("resolves a nested sibling resource without a root $id", async () => {
      const nestedId = "https://example.com/nested-user.json";
      const plugin = validationPlugin({
        request: {
          body: {
            definitions: {
              user: {
                $id: `${nestedId}#`,
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
            $ref: "#/definitions/user",
          },
        },
        response: { body: { $ref: nestedId } },
      });
      const context: Schmock.PluginContext = {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        body: { name: "Ada" },
        state: new Map(),
      };

      const preflight = await runBeforeRequest(plugin, context);
      const accepted = await plugin.process(preflight.context, { name: "Ada" });
      const rejected = await plugin.process(preflight.context, { name: 42 });

      expect(preflight.response).toBeUndefined();
      expect(accepted.response).toEqual({ name: "Ada" });
      expect(rejected.response).toMatchObject({
        status: 500,
        body: { code: "RESPONSE_VALIDATION_ERROR" },
      });
    });

    it("registers nested resources from two rootless sibling schemas", async () => {
      const numberId = "https://example.com/rootless-number.json";
      const stringId = "https://example.com/rootless-string.json";
      const plugin = validationPlugin({
        request: {
          body: {
            definitions: {
              number: { $id: numberId, type: "number" },
            },
          },
          query: {
            definitions: {
              string: { $id: stringId, type: "string" },
            },
          },
        },
        response: {
          body: {
            type: "object",
            properties: {
              count: { $ref: numberId },
              label: { $ref: stringId },
            },
            required: ["count", "label"],
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
        { count: 1, label: "one" },
      );

      expect(result.response).toEqual({ count: 1, label: "one" });
    });

    it("registers a sibling's unique resource when another resource collides", async () => {
      const collisionId = "https://example.com/partial-collision.json";
      const uniqueId = "https://example.com/partial-unique.json";
      const plugin = validationPlugin({
        request: {
          body: {
            definitions: {
              collision: { $id: collisionId, type: "number" },
              unique: { $id: uniqueId, type: "string" },
            },
          },
        },
        response: {
          body: {
            $id: collisionId,
            type: "object",
            properties: { value: { $ref: uniqueId } },
            required: ["value"],
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
        { value: "registered" },
      );

      expect(result.response).toEqual({ value: "registered" });
    });

    it("isolates request and response root IDs that differ only by a trailing hash", async () => {
      const sharedId = "https://example.com/thing.json";
      const context: Schmock.PluginContext = {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        state: new Map(),
      };

      const plugin = validationPlugin({
        request: {
          body: {
            $id: `${sharedId}#`,
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
          },
        },
        response: {
          body: {
            $id: sharedId,
            type: "object",
            properties: { id: { type: "number" }, name: { type: "string" } },
            required: ["id", "name"],
          },
        },
      });

      // Each slot must keep its OWN constraints — a registry that reuses a
      // validator by $id would let the looser request schema accept both.
      const accepted = await runBeforeRequest(plugin, {
        ...context,
        body: { id: 1 },
      });
      expect(accepted.response).toBeUndefined();

      const rejected = await plugin.process(context, { id: 1 });
      expect(rejected.response).toMatchObject({
        status: 500,
        body: { code: "RESPONSE_VALIDATION_ERROR" },
      });
    });

    it("resolves a canonical self-ref after normalizing an equivalent root ID", async () => {
      const canonicalId = "https://example.com/thing.json";
      const plugin = validationPlugin({
        request: {
          body: {
            $id: "https://EXAMPLE.com:443/schemas/../thing.json#",
            definitions: {
              payload: {
                type: "object",
                properties: { requestOnly: { const: true } },
                required: ["requestOnly"],
              },
            },
            $ref: `${canonicalId}#/definitions/payload`,
          },
        },
        response: {
          body: {
            $id: canonicalId,
            type: "object",
            properties: { responseOnly: { const: true } },
            required: ["responseOnly"],
          },
        },
      });
      const context: Schmock.PluginContext = {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        body: { requestOnly: true },
        state: new Map(),
      };

      const preflight = await runBeforeRequest(plugin, context);
      const rejected = await plugin.process(context, { requestOnly: true });

      expect(preflight.response).toBeUndefined();
      expect(rejected.response).toMatchObject({
        status: 500,
        body: { code: "RESPONSE_VALIDATION_ERROR" },
      });
    });

    it("isolates a target nested resource ID from a sibling root ID", async () => {
      const sharedId = "https://example.com/nested-collision.json";
      const plugin = validationPlugin({
        request: {
          body: {
            $id: "https://example.com/request-root.json",
            definitions: {
              payload: {
                $id: `${sharedId}#`,
                type: "object",
                properties: { requestOnly: { const: true } },
                required: ["requestOnly"],
              },
            },
            $ref: "#/definitions/payload",
          },
        },
        response: {
          body: {
            $id: sharedId,
            type: "object",
            properties: { responseOnly: { const: true } },
            required: ["responseOnly"],
          },
        },
      });
      const context: Schmock.PluginContext = {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: {},
        headers: {},
        body: { requestOnly: true },
        state: new Map(),
      };

      const preflight = await runBeforeRequest(plugin, context);
      const rejected = await plugin.process(context, { requestOnly: true });

      expect(preflight.response).toBeUndefined();
      expect(rejected.response).toMatchObject({
        status: 500,
        body: { code: "RESPONSE_VALIDATION_ERROR" },
      });
    });
  });

  describe("response envelope alignment with core", () => {
    const envelopeContext: Schmock.PluginContext = {
      path: "/test",
      route: {},
      method: "GET",
      params: {},
      query: {},
      headers: {},
      state: new Map(),
    };

    function envelopePlugin(): Schmock.Plugin {
      return validationPlugin({
        response: {
          body: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        },
      });
    }

    it("validates a malformed envelope as the payload core delivers", async () => {
      // Non-string header values make core reject the envelope and deliver the
      // whole object as the body, so validation must judge the whole object.
      const response = { status: 200, body: { ok: true }, headers: { n: 5 } };

      const result = await envelopePlugin().process(envelopeContext, response);

      expect(result.response).toMatchObject({
        status: 500,
        body: { code: "RESPONSE_VALIDATION_ERROR" },
      });
    });

    it("unwraps an envelope whose headers core still accepts", async () => {
      const response = {
        status: 200,
        body: { ok: true },
        headers: { "x-shape": "structured" },
      };

      const result = await envelopePlugin().process(envelopeContext, response);

      expect(result.response).toBe(response);
    });

    it("validates an object with array headers as a plain payload", async () => {
      const response = {
        status: 200,
        body: { ok: true },
        headers: ["x-shape"],
      };

      const result = await envelopePlugin().process(envelopeContext, response);

      expect(result.response).toMatchObject({
        status: 500,
        body: { code: "RESPONSE_VALIDATION_ERROR" },
      });
    });

    it("validates an envelope-like array as the whole body core delivers", async () => {
      const envelopeLikeArray: unknown[] = [1, 2];
      Reflect.set(envelopeLikeArray, "status", 202);
      Reflect.set(envelopeLikeArray, "body", { ok: true });
      const plugin = validationPlugin({
        response: {
          body: { type: "array", items: { type: "number" } },
        },
      });

      const result = await plugin.process(envelopeContext, envelopeLikeArray);

      expect(result.response).toBe(envelopeLikeArray);
    });
  });

  describe("semantic response body contract", () => {
    it("validates the semantic body, not the text/plain transport payload", async () => {
      const mock = schmock();
      mock("GET /note", () => ({ id: 1 }), {
        contentType: "text/plain",
      }).pipe(
        validationPlugin({
          response: {
            body: {
              type: "object",
              properties: { id: { type: "number" } },
              required: ["id"],
            },
          },
        }),
      );

      const response = await mock.handle("GET", "/note");

      // The object satisfied the schema; serialization happens afterwards.
      expect(response.status).toBe(200);
      expect(response.body).toBe('{"id":1}');
    });
  });

  describe("configuration snapshots", () => {
    it("keeps schemas, bodyRequired, and statuses fixed after factory creation", async () => {
      const requestBodySchema: Schmock.JSONSchema7 = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      };
      const requestQuerySchema: Schmock.JSONSchema7 = {
        type: "object",
        properties: { page: { type: "string" } },
        required: ["page"],
      };
      const requestHeadersSchema: Schmock.JSONSchema7 = {
        type: "object",
        properties: { "x-token": { type: "string" } },
        required: ["x-token"],
      };
      const responseBodySchema: Schmock.JSONSchema7 = {
        type: "object",
        properties: { created: { type: "boolean" } },
        required: ["created"],
      };
      const request: NonNullable<ValidationPluginOptions["request"]> = {
        body: requestBodySchema,
        bodyRequired: true,
        query: requestQuerySchema,
        headers: requestHeadersSchema,
      };
      const options: ValidationPluginOptions = {
        request,
        response: { body: responseBodySchema },
        requestErrorStatus: 422,
        responseErrorStatus: 502,
      };
      const plugin = validationPlugin(options);

      request.bodyRequired = false;
      requestBodySchema.properties = { changed: { type: "string" } };
      requestBodySchema.required = ["changed"];
      requestQuerySchema.properties = { cursor: { type: "string" } };
      requestQuerySchema.required = ["cursor"];
      requestHeadersSchema.properties = { "x-other": { type: "string" } };
      requestHeadersSchema.required = ["x-other"];
      responseBodySchema.properties = { changed: { type: "string" } };
      responseBodySchema.required = ["changed"];
      options.requestErrorStatus = 409;
      options.responseErrorStatus = 503;

      const baseContext: Schmock.PluginContext = {
        path: "/test",
        route: {},
        method: "POST",
        params: {},
        query: { page: "1" },
        headers: { "x-token": "secret" },
        state: new Map(),
      };
      const missingBody = await runBeforeRequest(plugin, baseContext);
      const changedBody = await runBeforeRequest(plugin, {
        ...baseContext,
        body: { changed: "yes" },
        state: new Map(),
      });
      const changedQuery = await runBeforeRequest(plugin, {
        ...baseContext,
        body: { name: "Ada" },
        query: { cursor: "next" },
        state: new Map(),
      });
      const changedHeaders = await runBeforeRequest(plugin, {
        ...baseContext,
        body: { name: "Ada" },
        headers: { "x-other": "value" },
        state: new Map(),
      });
      const validRequest = await runBeforeRequest(plugin, {
        ...baseContext,
        body: { name: "Ada" },
        state: new Map(),
      });
      const changedResponse = await plugin.process(validRequest.context, {
        changed: "yes",
      });

      expect(missingBody.response).toMatchObject({
        status: 422,
        body: { code: "REQUEST_VALIDATION_ERROR" },
      });
      expect(changedBody.response).toMatchObject({
        status: 422,
        body: { code: "REQUEST_VALIDATION_ERROR" },
      });
      expect(changedQuery.response).toMatchObject({
        status: 422,
        body: { code: "QUERY_VALIDATION_ERROR" },
      });
      expect(changedHeaders.response).toMatchObject({
        status: 422,
        body: { code: "HEADER_VALIDATION_ERROR" },
      });
      expect(validRequest.response).toBeUndefined();
      expect(changedResponse.response).toMatchObject({
        status: 502,
        body: { code: "RESPONSE_VALIDATION_ERROR" },
      });
    });
  });

  describe("status configuration", () => {
    function withRuntimeStatus(
      option: "requestErrorStatus" | "responseErrorStatus",
      value: unknown,
    ): ValidationPluginOptions {
      const options: ValidationPluginOptions = {};
      Reflect.set(options, option, value);
      return options;
    }

    const invalidStatuses: Array<{
      label: string;
      option: "requestErrorStatus" | "responseErrorStatus";
      options: ValidationPluginOptions;
    }> = [
      {
        label: "request status below the supported range",
        option: "requestErrorStatus",
        options: { requestErrorStatus: 199 },
      },
      {
        label: "response status above the supported range",
        option: "responseErrorStatus",
        options: { responseErrorStatus: 600 },
      },
      {
        label: "non-finite request status",
        option: "requestErrorStatus",
        options: { requestErrorStatus: Number.NaN },
      },
      {
        label: "infinite response status",
        option: "responseErrorStatus",
        options: { responseErrorStatus: Number.POSITIVE_INFINITY },
      },
      {
        label: "fractional request status",
        option: "requestErrorStatus",
        options: { requestErrorStatus: 422.5 },
      },
      {
        label: "null request status",
        option: "requestErrorStatus",
        options: withRuntimeStatus("requestErrorStatus", null),
      },
      {
        label: "null response status",
        option: "responseErrorStatus",
        options: withRuntimeStatus("responseErrorStatus", null),
      },
    ];

    for (const { label, option, options } of invalidStatuses) {
      it(`rejects a ${label}`, () => {
        expect(() => validationPlugin(options)).toThrow(
          `${option} must be a finite integer from 200 through 599`,
        );
      });
    }

    it("throws a structured validation configuration error", () => {
      expect.hasAssertions();
      try {
        validationPlugin({ requestErrorStatus: 199 });
      } catch (error) {
        expect(error).toMatchObject({
          name: "SchmockError",
          code: "VALIDATION_CONFIG_INVALID",
          context: { option: "requestErrorStatus", received: 199 },
        });
      }
    });

    it("accepts the core-supported status boundaries", () => {
      expect(() =>
        validationPlugin({
          requestErrorStatus: 200,
          responseErrorStatus: 599,
        }),
      ).not.toThrow();
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
