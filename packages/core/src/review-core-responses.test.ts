import { afterEach, describe, expect, it, vi } from "vitest";
import * as adapterEntry from "./adapter.js";
import { redactQuery } from "./headers.js";
import { schmock } from "./index";

function errorWithMessage(message: unknown): Error {
  const error = new Error("replaced");
  Object.defineProperty(error, "message", { value: message });
  return error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("failed requests", () => {
  describe("an Error whose message is not a string", () => {
    it.each([
      ["undefined", undefined, "Unknown error"],
      ["bigint", 10n, "10"],
      ["object", { code: 1 }, '{"code":1}'],
      ["number", 42, "42"],
    ] satisfies Array<[string, unknown, string]>)(
      "answers with a string error and one request:end when the message is %s",
      async (_label, message, described) => {
        const mock = schmock();
        mock("GET /fails", () => {
          throw errorWithMessage(message);
        });
        const ends: number[] = [];
        mock.on("request:end", (event) => ends.push(event.status));

        const response = await mock.handle("GET", "/fails");

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
          error: described,
          code: "INTERNAL_ERROR",
        });
        expect(ends).toEqual([500]);
        expect(mock.callCount()).toBe(1);
      },
    );
  });

  describe("non-Error throws", () => {
    const thrown = { reason: "quota exceeded", retryAfter: 30 };
    let originalFetch: typeof globalThis.fetch;

    afterEach(() => {
      if (originalFetch) globalThis.fetch = originalFetch;
    });

    async function formatterErrorsFor(
      configure: (mock: Schmock.CallableMockInstance) => void,
      options: Schmock.InterceptOptions = {},
    ): Promise<Error[]> {
      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("network"));
      const mock = schmock();
      configure(mock);
      const seen: Error[] = [];
      const handle = mock.intercept({
        passthrough: false,
        ...options,
        errorFormatter: (error) => {
          seen.push(error);
          return { message: error.message };
        },
      });
      try {
        const response = await fetch("http://localhost/quota");
        expect(response.status).toBe(500);
      } finally {
        handle.restore();
      }
      return seen;
    }

    it("hands errorFormatter the value a route threw as the error's cause", async () => {
      const seen = await formatterErrorsFor((mock) => {
        mock("GET /quota", () => {
          throw thrown;
        });
      });

      expect(seen).toHaveLength(1);
      expect(seen[0].message).toBe(JSON.stringify(thrown));
      expect(seen[0].cause).toBe(thrown);
    });

    it("describes a value an adapter hook threw as a route throw is described", async () => {
      const seen = await formatterErrorsFor(
        (mock) => {
          mock("GET /quota", { ok: true });
        },
        {
          beforeRequest: () => {
            throw thrown;
          },
        },
      );

      expect(seen).toHaveLength(1);
      expect(seen[0].message).toBe(JSON.stringify(thrown));
      expect(seen[0].cause).toBe(thrown);
    });

    it("hands onError the value a plugin threw as the error's cause", async () => {
      const mock = schmock();
      mock("GET /quota", { ok: true });
      const seen: Error[] = [];
      mock.pipe({
        name: "thrower",
        process: () => {
          throw thrown;
        },
        onError: (error) => {
          seen.push(error);
        },
      });

      const response = await mock.handle("GET", "/quota");

      expect(response.status).toBe(500);
      expect(seen).toHaveLength(1);
      expect(seen[0].message).toBe(JSON.stringify(thrown));
      expect(seen[0].cause).toBe(thrown);
    });
  });
});

describe("@schmock/core/adapter error helpers", () => {
  it("exports the JSON error envelope core answers failures with", async () => {
    const { buildJsonErrorResponse } = adapterEntry;
    const mock = schmock();

    const coreMiss = await mock.handle("GET", "/nowhere");
    const built = buildJsonErrorResponse({
      status: 404,
      error: "Route not found: GET /nowhere",
      code: "ROUTE_NOT_FOUND",
      method: "GET",
    });

    expect(built).toEqual({
      status: coreMiss.status,
      body: coreMiss.body,
      headers: coreMiss.headers,
    });
  });

  it("adds extra headers after the JSON content type and strips a HEAD body", () => {
    const built = adapterEntry.buildJsonErrorResponse({
      status: 405,
      error: "Unsupported HTTP method: PROPFIND",
      code: "METHOD_NOT_ALLOWED",
      method: "HEAD",
      headers: { allow: "GET, HEAD" },
    });

    expect(built).toEqual({
      status: 405,
      body: undefined,
      headers: { "content-type": "application/json", allow: "GET, HEAD" },
    });
  });

  it("exports toError", () => {
    const error = adapterEntry.toError("boom");
    expect(error.message).toBe("boom");
    expect(error.cause).toBe("boom");
  });
});

describe("credential names", () => {
  it.each([
    "key",
    "token",
    "apikey",
    "api_key",
    "api-key",
    "secret",
    "password",
    "X-Pet-Key",
    "access_token",
    "client_secret",
    "API_KEY",
  ])("treats %s as a credential name", (name) => {
    expect(adapterEntry.isCredentialName(name)).toBe(true);
  });

  it.each(["limit", "keyboard", "monkey", "X-Pet-Credential", "tokens"])(
    "does not treat %s as a credential name",
    (name) => {
      expect(adapterEntry.isCredentialName(name)).toBe(false);
    },
  );

  it("redacts credential query values copy-on-write", () => {
    const query = { api_key: "k", page: "2" };
    const redacted = redactQuery(query);

    expect(redacted).toEqual({ api_key: "[redacted]", page: "2" });
    expect(query.api_key).toBe("k");
    const harmless = { page: "2" };
    expect(redactQuery(harmless)).toBe(harmless);
  });
});
