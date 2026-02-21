/// <reference path="../../packages/core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";
import { afterEach, describe, expect, it } from "vitest";
import { fetchJson } from "./helpers";

// ─── Inline spec helpers ────────────────────────────────────────────

function securedSpec(
  securitySchemes: Record<string, unknown>,
  options?: {
    globalSecurity?: unknown[];
    operationSecurity?: unknown[];
    paths?: Record<string, unknown>;
  },
): object {
  const endpoint = {
    get: {
      ...(options?.operationSecurity
        ? { security: options.operationSecurity }
        : {}),
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { data: { type: "string", default: "secret" } },
              },
            },
          },
        },
      },
    },
  };

  return {
    openapi: "3.0.3",
    info: { title: "Security Test", version: "1.0.0" },
    components: { securitySchemes },
    ...(options?.globalSecurity
      ? { security: options.globalSecurity }
      : {}),
    paths: options?.paths ?? { "/secure": endpoint },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Security Edge Cases", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => {
    mock?.close();
  });

  // --- Bearer auth ---

  it("Bearer auth: valid token passes", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          { bearerAuth: { type: "http", scheme: "bearer" } },
          { globalSecurity: [{ bearerAuth: [] }] },
        ),
        security: true,
      }),
    );

    const res = await mock.handle("GET", "/secure", {
      headers: { authorization: "Bearer token123" },
    });
    expect(res.status).toBe(200);
  });

  it("Bearer auth: missing header returns 401", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          { bearerAuth: { type: "http", scheme: "bearer" } },
          { globalSecurity: [{ bearerAuth: [] }] },
        ),
        security: true,
      }),
    );

    const res = await mock.handle("GET", "/secure");
    expect(res.status).toBe(401);
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty("code", "UNAUTHORIZED");
    // Should include WWW-Authenticate header
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("Bearer auth: wrong scheme returns 401", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          { bearerAuth: { type: "http", scheme: "bearer" } },
          { globalSecurity: [{ bearerAuth: [] }] },
        ),
        security: true,
      }),
    );

    const res = await mock.handle("GET", "/secure", {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  // --- Basic auth ---

  it("Basic auth: valid credentials pass", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          { basicAuth: { type: "http", scheme: "basic" } },
          { globalSecurity: [{ basicAuth: [] }] },
        ),
        security: true,
      }),
    );

    const res = await mock.handle("GET", "/secure", {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(200);
  });

  it("Basic auth: wrong scheme returns 401", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          { basicAuth: { type: "http", scheme: "basic" } },
          { globalSecurity: [{ basicAuth: [] }] },
        ),
        security: true,
      }),
    );

    const res = await mock.handle("GET", "/secure", {
      headers: { authorization: "Bearer xxx" },
    });
    expect(res.status).toBe(401);
  });

  // --- API key auth ---

  it("API key in header: present passes", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          {
            apiKeyAuth: {
              type: "apiKey",
              in: "header",
              name: "X-API-Key",
            },
          },
          { globalSecurity: [{ apiKeyAuth: [] }] },
        ),
        security: true,
      }),
    );

    const res = await mock.handle("GET", "/secure", {
      headers: { "x-api-key": "key123" },
    });
    expect(res.status).toBe(200);
  });

  it("API key in header: missing returns 401", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          {
            apiKeyAuth: {
              type: "apiKey",
              in: "header",
              name: "X-API-Key",
            },
          },
          { globalSecurity: [{ apiKeyAuth: [] }] },
        ),
        security: true,
      }),
    );

    const res = await mock.handle("GET", "/secure");
    expect(res.status).toBe(401);
  });

  it("API key in query: always passes (known gap)", async () => {
    // Query-based API keys can't be checked from headers alone.
    // The security checker returns true for query API keys.
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          {
            apiKeyQuery: {
              type: "apiKey",
              in: "query",
              name: "api_key",
            },
          },
          { globalSecurity: [{ apiKeyQuery: [] }] },
        ),
        security: true,
      }),
    );

    // Request without any API key in query → still passes because
    // query API keys aren't validated (checkSchemePresence returns true)
    const res = await mock.handle("GET", "/secure");
    expect(res.status).toBe(200);
  });

  // --- OR / AND security combos ---

  it("OR security: either scheme passes", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          {
            bearerAuth: { type: "http", scheme: "bearer" },
            apiKeyAuth: {
              type: "apiKey",
              in: "header",
              name: "X-API-Key",
            },
          },
          // Each entry is OR: [{bearerAuth}, {apiKeyAuth}]
          {
            globalSecurity: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          },
        ),
        security: true,
      }),
    );

    // Bearer alone passes
    const bearerRes = await mock.handle("GET", "/secure", {
      headers: { authorization: "Bearer token" },
    });
    expect(bearerRes.status).toBe(200);

    // API key alone passes
    const apiKeyRes = await mock.handle("GET", "/secure", {
      headers: { "x-api-key": "key123" },
    });
    expect(apiKeyRes.status).toBe(200);

    // Neither → 401
    const noneRes = await mock.handle("GET", "/secure");
    expect(noneRes.status).toBe(401);
  });

  it("AND security: both required", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          {
            bearerAuth: { type: "http", scheme: "bearer" },
            apiKeyAuth: {
              type: "apiKey",
              in: "header",
              name: "X-API-Key",
            },
          },
          // Single entry with both schemes = AND within group
          {
            globalSecurity: [{ bearerAuth: [], apiKeyAuth: [] }],
          },
        ),
        security: true,
      }),
    );

    // Both present → passes
    const bothRes = await mock.handle("GET", "/secure", {
      headers: {
        authorization: "Bearer token",
        "x-api-key": "key123",
      },
    });
    expect(bothRes.status).toBe(200);

    // Only bearer → 401
    const bearerOnly = await mock.handle("GET", "/secure", {
      headers: { authorization: "Bearer token" },
    });
    expect(bearerOnly.status).toBe(401);

    // Only API key → 401
    const apiKeyOnly = await mock.handle("GET", "/secure", {
      headers: { "x-api-key": "key123" },
    });
    expect(apiKeyOnly.status).toBe(401);
  });

  it("Empty security group = public endpoint", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          { bearerAuth: { type: "http", scheme: "bearer" } },
          // security: [{}] means "no auth required" (public)
          { globalSecurity: [{}] },
        ),
        security: true,
      }),
    );

    // No auth headers → still 200 because empty group means public
    const res = await mock.handle("GET", "/secure");
    expect(res.status).toBe(200);
  });

  it("Operation-level security overrides global", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          { bearerAuth: { type: "http", scheme: "bearer" } },
          {
            globalSecurity: [{ bearerAuth: [] }],
            paths: {
              "/secure": {
                get: {
                  // Operation has security: [{}] → public (empty group = no auth)
                  // Note: security: [] (empty array) is NOT recognized as "public"
                  // by the parser — extractSecurityRequirements returns undefined for
                  // empty arrays, falling through to global. Use [{}] instead.
                  security: [{}],
                  responses: {
                    "200": {
                      description: "OK",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            properties: {
                              data: { type: "string", default: "public" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              "/private": {
                get: {
                  // No operation-level security → inherits global bearer
                  responses: {
                    "200": {
                      description: "OK",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            properties: {
                              data: { type: "string", default: "private" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ),
        security: true,
      }),
    );

    // /secure has security: [{}] → public (empty group = no auth required)
    const publicRes = await mock.handle("GET", "/secure");
    expect(publicRes.status).toBe(200);

    // /private inherits global bearer → requires auth
    const noAuth = await mock.handle("GET", "/private");
    expect(noAuth.status).toBe(401);

    const withAuth = await mock.handle("GET", "/private", {
      headers: { authorization: "Bearer token" },
    });
    expect(withAuth.status).toBe(200);
  });

  it("Multiple schemes: WWW-Authenticate lists all", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          {
            bearerAuth: { type: "http", scheme: "bearer" },
            basicAuth: { type: "http", scheme: "basic" },
          },
          {
            globalSecurity: [{ bearerAuth: [] }, { basicAuth: [] }],
          },
        ),
        security: true,
      }),
    );

    const res = await mock.handle("GET", "/secure");
    expect(res.status).toBe(401);
    const wwwAuth = res.headers["www-authenticate"] ?? "";
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("Basic");
  });

  it("Security disabled by default (no security option)", async () => {
    mock = schmock({ state: {} });
    mock.pipe(
      await openapi({
        spec: securedSpec(
          { bearerAuth: { type: "http", scheme: "bearer" } },
          { globalSecurity: [{ bearerAuth: [] }] },
        ),
        // No `security: true` → auth is not enforced
      }),
    );

    // No auth headers but should still pass because security is disabled
    const res = await mock.handle("GET", "/secure");
    expect(res.status).toBe(200);
  });
});
