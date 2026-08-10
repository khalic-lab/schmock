import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { CliServer } from "../cli";
import { createCliServer } from "../cli";

const feature = await loadFeature("../../features/admin-api.feature");

const simpleSpec = {
  openapi: "3.0.3",
  info: { title: "Admin API test", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        responses: {
          "200": {
            description: "Items",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Item" },
                },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Item" },
            },
          },
        },
        responses: {
          "201": {
            description: "Created item",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Item" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Item: {
        type: "object",
        required: ["name"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
        },
      },
    },
  },
};

interface JsonResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

interface RouteRecord {
  method: string;
  path: string;
  hasParams: boolean;
}

interface HistoryRecordSummary {
  method: string;
  path: string;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  response: {
    status: number;
    body: unknown;
  };
}

const expectedRoutes: RouteRecord[] = [
  { method: "GET", path: "/items", hasParams: false },
  { method: "POST", path: "/items", hasParams: false },
];

const expectedHistory: HistoryRecordSummary[] = [
  {
    method: "GET",
    path: "/items",
    params: {},
    query: {},
    response: { status: 200, body: [] },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drops `headers` so payload assertions stay focused on the JSON body. */
function payload(response: JsonResponse): { status: number; body: unknown } {
  return { status: response.status, body: response.body };
}

function routeRecords(value: unknown): RouteRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected the admin routes response to be an array");
  }

  return value.map((route, index) => {
    if (!isRecord(route)) {
      throw new Error(`Expected route ${index} to be an object`);
    }
    expect(Object.keys(route).sort()).toEqual(["hasParams", "method", "path"]);

    const { method, path, hasParams } = route;
    if (
      typeof method !== "string" ||
      typeof path !== "string" ||
      typeof hasParams !== "boolean"
    ) {
      throw new Error(`Expected route ${index} to have typed route fields`);
    }

    return { method, path, hasParams };
  });
}

function historyRecords(value: unknown): HistoryRecordSummary[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected the admin history response to be an array");
  }

  return value.map((record, index) => {
    if (!isRecord(record)) {
      throw new Error(`Expected history record ${index} to be an object`);
    }
    expect(Object.keys(record).sort()).toEqual([
      "headers",
      "method",
      "params",
      "path",
      "query",
      "response",
      "timestamp",
    ]);

    const { method, path, params, query, headers, timestamp, response } =
      record;
    if (
      typeof method !== "string" ||
      typeof path !== "string" ||
      !isRecord(params) ||
      !isRecord(query) ||
      !isRecord(headers) ||
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      !isRecord(response) ||
      typeof response.status !== "number"
    ) {
      throw new Error(`Expected history record ${index} to have typed fields`);
    }

    return {
      method,
      path,
      params,
      query,
      response: { status: response.status, body: response.body },
    };
  });
}

/**
 * Reads the raw `headers` map of the first history record. `historyRecords`
 * deliberately drops header values, so header-level assertions need their own
 * reader.
 */
function firstRecordHeaders(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Expected at least one history record");
  }
  const [record] = value;
  if (!isRecord(record) || !isRecord(record.headers)) {
    throw new Error("Expected the first history record to carry headers");
  }
  return record.headers;
}

async function fetchJson(
  server: CliServer,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(
    `http://${server.hostname}:${server.port}${path}`,
    { method, headers },
  );
  if (response.status === 204) {
    return {
      status: response.status,
      body: undefined,
      headers: response.headers,
    };
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

const CORS_RESPONSE_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
];

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let server: CliServer | undefined;
  let tempDir: string | undefined;
  let response: JsonResponse | undefined;
  let routesBeforeReset: RouteRecord[] | undefined;

  function requireServer(): CliServer {
    if (!server) throw new Error("Expected a running CLI server");
    return server;
  }

  function requireResponse(): JsonResponse {
    if (!response) throw new Error("Expected an HTTP response");
    return response;
  }

  function adminAuth(): Record<string, string> {
    const token = requireServer().adminToken;
    if (!token)
      throw new Error("Expected the CLI server to issue an admin token");
    return { authorization: `Bearer ${token}` };
  }

  /** Every admin call in this suite is authenticated with the issued token. */
  function adminFetch(
    method: string,
    path: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<JsonResponse> {
    return fetchJson(requireServer(), method, path, {
      ...adminAuth(),
      ...extraHeaders,
    });
  }

  function expectNoCorsHeaders(received: JsonResponse): void {
    for (const header of CORS_RESPONSE_HEADERS) {
      expect(received.headers.get(header)).toBeNull();
    }
  }

  async function closeServer(): Promise<void> {
    await server?.close();
    server = undefined;
  }

  function writeTempSpec(): string {
    tempDir = mkdtempSync(join(tmpdir(), "schmock-admin-"));
    const specPath = join(tempDir, "spec.json");
    writeFileSync(specPath, JSON.stringify(simpleSpec));
    return specPath;
  }

  async function startServer(
    admin: boolean,
    extra: { cors?: boolean; adminHistoryLimit?: number } = {},
  ): Promise<void> {
    server = await createCliServer({
      spec: writeTempSpec(),
      port: 0,
      admin,
      ...extra,
    });
  }

  async function requestMockApi(
    headers: Record<string, string> = {},
  ): Promise<JsonResponse> {
    return fetchJson(requireServer(), "GET", "/items", headers);
  }

  AfterEachScenario(async () => {
    await closeServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    response = undefined;
    routesBeforeReset = undefined;
  });

  Scenario("List registered routes", ({ Given, When, Then, And }) => {
    Given("a CLI server with admin enabled and a simple spec", async () => {
      await startServer(true);
    });

    When('I request "GET /schmock-admin/routes"', async () => {
      response = await adminFetch("GET", "/schmock-admin/routes");
    });

    Then("the response status is 200", () => {
      expect(requireResponse().status).toBe(200);
    });

    And("the response body contains the exact registered routes", () => {
      expect(routeRecords(requireResponse().body)).toEqual(expectedRoutes);
    });
  });

  Scenario("Inspect server state", ({ Given, When, Then, And }) => {
    Given("a CLI server with admin enabled and a simple spec", async () => {
      await startServer(true);
    });

    When('I request "GET /schmock-admin/state"', async () => {
      response = await adminFetch("GET", "/schmock-admin/state");
    });

    Then("the response status is 200", () => {
      expect(requireResponse().status).toBe(200);
    });

    And("the response body is an empty state object", () => {
      expect(requireResponse().body).toEqual({});
    });
  });

  Scenario("Reset the mock via admin", ({ Given, When, Then, And }) => {
    Given(
      "a CLI server with admin enabled, state, and request history",
      async () => {
        await startServer(true);

        const routeResponse = await adminFetch("GET", "/schmock-admin/routes");
        routesBeforeReset = routeRecords(routeResponse.body);
        expect(routesBeforeReset).toEqual(expectedRoutes);

        const mockResponse = await requestMockApi();
        expect(payload(mockResponse)).toEqual({ status: 200, body: [] });

        const stateResponse = await adminFetch("GET", "/schmock-admin/state");
        expect(isRecord(stateResponse.body)).toBe(true);
        if (!isRecord(stateResponse.body)) {
          throw new Error("Expected populated state before reset");
        }
        expect(Object.keys(stateResponse.body).length).toBeGreaterThan(0);

        const historyResponse = await adminFetch(
          "GET",
          "/schmock-admin/history",
        );
        expect(historyRecords(historyResponse.body)).toEqual(expectedHistory);
      },
    );

    When('I send "POST /schmock-admin/reset"', async () => {
      response = await adminFetch("POST", "/schmock-admin/reset");
    });

    Then("the response status is 204", () => {
      expect(payload(requireResponse())).toEqual({
        status: 204,
        body: undefined,
      });
    });

    And("the admin request history is empty", async () => {
      const historyResponse = await adminFetch("GET", "/schmock-admin/history");
      expect(payload(historyResponse)).toEqual({ status: 200, body: [] });
    });

    And("the admin state is empty", async () => {
      const stateResponse = await adminFetch("GET", "/schmock-admin/state");
      expect(payload(stateResponse)).toEqual({ status: 200, body: {} });
    });

    And("the registered routes are unchanged", async () => {
      const routeResponse = await adminFetch("GET", "/schmock-admin/routes");
      expect(routeRecords(routeResponse.body)).toEqual(routesBeforeReset);
    });

    And("the mock API still responds", async () => {
      expect(payload(await requestMockApi())).toEqual({
        status: 200,
        body: [],
      });
    });
  });

  Scenario("View request history", ({ Given, When, Then, And }) => {
    Given("a CLI server with admin enabled and a simple spec", async () => {
      await startServer(true);
    });

    When("I make a request to the mock API", async () => {
      expect(payload(await requestMockApi())).toEqual({
        status: 200,
        body: [],
      });
    });

    And('I request "GET /schmock-admin/history"', async () => {
      response = await adminFetch("GET", "/schmock-admin/history");
    });

    Then("the response status is 200", () => {
      expect(requireResponse().status).toBe(200);
    });

    And("the response body contains the exact recorded request", () => {
      expect(historyRecords(requireResponse().body)).toEqual(expectedHistory);
    });
  });

  Scenario("Admin routes are 404 without flag", ({ Given, When, Then }) => {
    Given("a CLI server without admin enabled", async () => {
      await startServer(false);
    });

    When('I request "GET /schmock-admin/routes"', async () => {
      response = await fetchJson(
        requireServer(),
        "GET",
        "/schmock-admin/routes",
      );
    });

    Then("the response status is 404", () => {
      expect(requireResponse().status).toBe(404);
    });
  });

  Scenario(
    "Admin endpoints reject an unauthenticated request",
    ({ Given, When, Then, And }) => {
      Given("a CLI server with admin enabled and a simple spec", async () => {
        await startServer(true);
      });

      When(
        'I request "GET /schmock-admin/history" without a token',
        async () => {
          response = await fetchJson(
            requireServer(),
            "GET",
            "/schmock-admin/history",
          );
        },
      );

      Then("the response status is 401", () => {
        expect(requireResponse().status).toBe(401);
      });

      And('the response body has code "UNAUTHORIZED"', () => {
        expect(requireResponse().body).toMatchObject({ code: "UNAUTHORIZED" });
      });

      And('the response carries a "www-authenticate" challenge', () => {
        expect(requireResponse().headers.get("www-authenticate")).toContain(
          "Bearer",
        );
      });

      And("the response has no CORS headers", () => {
        expectNoCorsHeaders(requireResponse());
      });
    },
  );

  Scenario(
    "Admin endpoints reject a wrong token",
    ({ Given, When, Then, And }) => {
      Given("a CLI server with admin enabled and a simple spec", async () => {
        await startServer(true);
      });

      When(
        'I request "GET /schmock-admin/history" with the token "not-the-token"',
        async () => {
          response = await fetchJson(
            requireServer(),
            "GET",
            "/schmock-admin/history",
            { authorization: "Bearer not-the-token" },
          );
        },
      );

      Then("the response status is 401", () => {
        expect(requireResponse().status).toBe(401);
      });

      And('the response body has code "UNAUTHORIZED"', () => {
        expect(requireResponse().body).toMatchObject({ code: "UNAUTHORIZED" });
      });
    },
  );

  Scenario(
    "Admin endpoints accept the issued token",
    ({ Given, When, Then, And }) => {
      Given("a CLI server with admin enabled and a simple spec", async () => {
        await startServer(true);
      });

      When(
        'I request "GET /schmock-admin/routes" with the issued token',
        async () => {
          response = await adminFetch("GET", "/schmock-admin/routes");
        },
      );

      Then("the response status is 200", () => {
        expect(requireResponse().status).toBe(200);
      });

      And("the response body contains the exact registered routes", () => {
        expect(routeRecords(requireResponse().body)).toEqual(expectedRoutes);
      });
    },
  );

  Scenario(
    "Admin responses carry no CORS headers even with CORS enabled",
    ({ Given, When, Then, And }) => {
      Given("a CLI server with admin and CORS enabled", async () => {
        await startServer(true, { cors: true });
      });

      When(
        'I request "GET /schmock-admin/state" with the issued token',
        async () => {
          response = await adminFetch("GET", "/schmock-admin/state");
        },
      );

      Then("the response status is 200", () => {
        expect(requireResponse().status).toBe(200);
      });

      And("the response has no CORS headers", () => {
        expectNoCorsHeaders(requireResponse());
      });

      And(
        'a browser preflight to "/schmock-admin/state" is refused with 403 and no CORS headers',
        async () => {
          // A real preflight (Origin + Access-Control-Request-Method) is what
          // exercises the `!adminRequest` gate on the CORS short-circuit; a
          // bare OPTIONS never reaches it.
          response = await fetchJson(
            requireServer(),
            "OPTIONS",
            "/schmock-admin/state",
            {
              origin: "https://evil.example",
              "access-control-request-method": "GET",
            },
          );
          expect(requireResponse().status).toBe(403);
          expect(requireResponse().body).toMatchObject({ code: "FORBIDDEN" });
          expectNoCorsHeaders(requireResponse());
        },
      );

      And(
        'a bare OPTIONS to "/schmock-admin/state" gets no CORS headers and is not 204',
        async () => {
          response = await fetchJson(
            requireServer(),
            "OPTIONS",
            "/schmock-admin/state",
          );
          expect(requireResponse().status).not.toBe(204);
          expectNoCorsHeaders(requireResponse());
        },
      );

      And(
        'an unsupported method on "/schmock-admin/state" gets an error with no CORS headers',
        async () => {
          // Pins the error path in the request handler's catch block, which
          // must also honor the admin CORS exclusion.
          response = await fetchJson(
            requireServer(),
            "PROPFIND",
            "/schmock-admin/state",
          );
          expect(requireResponse().status).toBeGreaterThanOrEqual(400);
          expectNoCorsHeaders(requireResponse());
        },
      );
    },
  );

  Scenario(
    "Admin refuses a browser-originated request",
    ({ Given, When, Then, And }) => {
      Given("a CLI server with admin enabled and a simple spec", async () => {
        await startServer(true);
      });

      When(
        'I request "GET /schmock-admin/state" with the issued token and an Origin header',
        async () => {
          response = await adminFetch("GET", "/schmock-admin/state", {
            origin: "https://evil.example",
          });
        },
      );

      Then("the response status is 403", () => {
        expect(requireResponse().status).toBe(403);
      });

      And('the response body has code "FORBIDDEN"', () => {
        expect(requireResponse().body).toMatchObject({ code: "FORBIDDEN" });
      });

      And("the response has no CORS headers", () => {
        expectNoCorsHeaders(requireResponse());
      });
    },
  );

  Scenario(
    "Admin history redacts sensitive request headers",
    ({ Given, When, Then, And }) => {
      Given("a CLI server with admin enabled and a simple spec", async () => {
        await startServer(true);
      });

      When(
        "I make a request to the mock API with sensitive headers",
        async () => {
          const mockResponse = await requestMockApi({
            authorization: "Bearer super-secret-token",
            cookie: "sid=abc123",
            "x-schmock-admin-token": "leaked-admin-token",
            accept: "application/json",
          });
          expect(mockResponse.status).toBe(200);
        },
      );

      And(
        'I request "GET /schmock-admin/history" with the issued token',
        async () => {
          response = await adminFetch("GET", "/schmock-admin/history");
        },
      );

      Then("the response status is 200", () => {
        expect(requireResponse().status).toBe(200);
      });

      And('the recorded headers redact "authorization"', () => {
        expect(firstRecordHeaders(requireResponse().body).authorization).toBe(
          "[redacted]",
        );
      });

      And('the recorded headers redact "cookie"', () => {
        expect(firstRecordHeaders(requireResponse().body).cookie).toBe(
          "[redacted]",
        );
      });

      And('the recorded headers redact "x-schmock-admin-token"', () => {
        expect(
          firstRecordHeaders(requireResponse().body)["x-schmock-admin-token"],
        ).toBe("[redacted]");
      });

      And('the recorded headers keep "accept"', () => {
        expect(firstRecordHeaders(requireResponse().body).accept).toBe(
          "application/json",
        );
      });
    },
  );

  Scenario(
    "Admin history is capped by the configured limit",
    ({ Given, When, Then, And }) => {
      Given(
        "a CLI server with admin enabled and a history limit of 2",
        async () => {
          await startServer(true, { adminHistoryLimit: 2 });
        },
      );

      When("I make 5 requests to the mock API", async () => {
        for (let i = 0; i < 5; i += 1) {
          expect((await requestMockApi()).status).toBe(200);
        }
      });

      And(
        'I request "GET /schmock-admin/history" with the issued token',
        async () => {
          response = await adminFetch("GET", "/schmock-admin/history");
        },
      );

      Then("the response status is 200", () => {
        expect(requireResponse().status).toBe(200);
      });

      And("the response body contains 2 history records", () => {
        expect(historyRecords(requireResponse().body)).toHaveLength(2);
      });
    },
  );
});
