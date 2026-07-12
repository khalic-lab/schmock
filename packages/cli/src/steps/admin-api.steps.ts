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

async function fetchJson(
  server: CliServer,
  method: string,
  path: string,
): Promise<JsonResponse> {
  const response = await fetch(
    `http://${server.hostname}:${server.port}${path}`,
    { method },
  );
  if (response.status === 204) {
    return { status: response.status, body: undefined };
  }
  const body: unknown = await response.json();
  return { status: response.status, body };
}

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

  async function closeServer(): Promise<void> {
    if (!server?.server.listening) {
      server = undefined;
      return;
    }
    server.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server?.server.close(() => resolve());
    });
    server = undefined;
  }

  function writeTempSpec(): string {
    tempDir = mkdtempSync(join(tmpdir(), "schmock-admin-"));
    const specPath = join(tempDir, "spec.json");
    writeFileSync(specPath, JSON.stringify(simpleSpec));
    return specPath;
  }

  async function startServer(admin: boolean): Promise<void> {
    server = await createCliServer({
      spec: writeTempSpec(),
      port: 0,
      admin,
    });
  }

  async function requestMockApi(): Promise<JsonResponse> {
    return fetchJson(requireServer(), "GET", "/items");
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
      response = await fetchJson(
        requireServer(),
        "GET",
        "/schmock-admin/routes",
      );
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
      response = await fetchJson(
        requireServer(),
        "GET",
        "/schmock-admin/state",
      );
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

        const routeResponse = await fetchJson(
          requireServer(),
          "GET",
          "/schmock-admin/routes",
        );
        routesBeforeReset = routeRecords(routeResponse.body);
        expect(routesBeforeReset).toEqual(expectedRoutes);

        const mockResponse = await requestMockApi();
        expect(mockResponse).toEqual({ status: 200, body: [] });

        const stateResponse = await fetchJson(
          requireServer(),
          "GET",
          "/schmock-admin/state",
        );
        expect(isRecord(stateResponse.body)).toBe(true);
        if (!isRecord(stateResponse.body)) {
          throw new Error("Expected populated state before reset");
        }
        expect(Object.keys(stateResponse.body).length).toBeGreaterThan(0);

        const historyResponse = await fetchJson(
          requireServer(),
          "GET",
          "/schmock-admin/history",
        );
        expect(historyRecords(historyResponse.body)).toEqual(expectedHistory);
      },
    );

    When('I send "POST /schmock-admin/reset"', async () => {
      response = await fetchJson(
        requireServer(),
        "POST",
        "/schmock-admin/reset",
      );
    });

    Then("the response status is 204", () => {
      expect(requireResponse()).toEqual({ status: 204, body: undefined });
    });

    And("the admin request history is empty", async () => {
      const historyResponse = await fetchJson(
        requireServer(),
        "GET",
        "/schmock-admin/history",
      );
      expect(historyResponse).toEqual({ status: 200, body: [] });
    });

    And("the admin state is empty", async () => {
      const stateResponse = await fetchJson(
        requireServer(),
        "GET",
        "/schmock-admin/state",
      );
      expect(stateResponse).toEqual({ status: 200, body: {} });
    });

    And("the registered routes are unchanged", async () => {
      const routeResponse = await fetchJson(
        requireServer(),
        "GET",
        "/schmock-admin/routes",
      );
      expect(routeRecords(routeResponse.body)).toEqual(routesBeforeReset);
    });

    And("the mock API still responds", async () => {
      expect(await requestMockApi()).toEqual({ status: 200, body: [] });
    });
  });

  Scenario("View request history", ({ Given, When, Then, And }) => {
    Given("a CLI server with admin enabled and a simple spec", async () => {
      await startServer(true);
    });

    When("I make a request to the mock API", async () => {
      expect(await requestMockApi()).toEqual({ status: 200, body: [] });
    });

    And('I request "GET /schmock-admin/history"', async () => {
      response = await fetchJson(
        requireServer(),
        "GET",
        "/schmock-admin/history",
      );
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
});
