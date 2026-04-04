/// <reference path="../../packages/core/schmock.d.ts" />

import { schmock } from "@schmock/core";
import {
  badRequest,
  created,
  noContent,
  notFound,
  serverError,
} from "@schmock/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Angular Adapter Integration Tests
 *
 * Since Angular's DI and HttpClient are difficult to bootstrap in vitest,
 * these tests verify the Angular adapter's option semantics (baseUrl,
 * transformRequest, transformResponse, errorFormatter) by exercising
 * mock.handle() directly — the same code path the real interceptor uses.
 *
 * The unit tests in packages/angular/src/index.test.ts cover the Observable
 * wiring with mocked dependencies; this file covers end-to-end routing and
 * stateful handler behaviour with a real Schmock instance.
 */

// ---------------------------------------------------------------------------
// Helpers — re-implement the Angular adapter's internal functions so we can
// test the same logic end-to-end without importing Angular packages.
// ---------------------------------------------------------------------------

function extractPathname(url: string): string {
  const queryStart = url.indexOf("?");
  const urlWithoutQuery = queryStart === -1 ? url : url.slice(0, queryStart);

  if (urlWithoutQuery.includes("://")) {
    try {
      const parsed = new URL(urlWithoutQuery);
      return parsed.pathname;
    } catch {
      // fall through
    }
  }

  if (!urlWithoutQuery.startsWith("/")) {
    return `/${urlWithoutQuery}`;
  }

  return urlWithoutQuery;
}

/**
 * Simulate the Angular adapter's request-routing logic:
 * 1. Extract pathname from full URL
 * 2. Check baseUrl prefix (skip if not matching)
 * 3. Strip baseUrl prefix
 * 4. Apply transformRequest
 * 5. Call mock.handle()
 * 6. Apply transformResponse / errorFormatter
 */
async function angularHandle(
  mock: Schmock.CallableMockInstance,
  method: Schmock.HttpMethod,
  url: string,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
  } = {},
  adapterOptions: {
    baseUrl?: string;
    transformRequest?: (req: {
      method: Schmock.HttpMethod;
      path: string;
      headers: Record<string, string>;
      body: unknown;
      query: Record<string, string>;
    }) => Schmock.AdapterRequestOverride;
    transformResponse?: (
      response: Schmock.Response,
      req: { method: Schmock.HttpMethod; url: string },
    ) => Schmock.Response;
    errorFormatter?: (error: Error) => unknown;
  } = {},
): Promise<Schmock.Response | "PASSTHROUGH"> {
  const { baseUrl, transformRequest, transformResponse, errorFormatter } =
    adapterOptions;

  const path = extractPathname(url);

  // baseUrl filter
  if (baseUrl && !path.startsWith(baseUrl)) {
    return "PASSTHROUGH";
  }

  // Strip baseUrl prefix
  const routePath = baseUrl ? path.slice(baseUrl.length) || "/" : path;

  const headers = options.headers ?? {};
  const body = options.body;
  const query = options.query ?? {};

  let requestData: {
    method: Schmock.HttpMethod;
    path: string;
    headers: Record<string, string>;
    body: unknown;
    query: Record<string, string>;
  } = { method, path: routePath, headers, body, query };

  // Apply transformRequest
  if (transformRequest) {
    const override = transformRequest(requestData);
    requestData = {
      ...requestData,
      ...override,
      method: (override.method?.toUpperCase() as Schmock.HttpMethod) ?? requestData.method,
    };
  }

  const response = await mock.handle(requestData.method, requestData.path, {
    headers: requestData.headers,
    body: requestData.body,
    query: requestData.query,
  });

  // Apply transformResponse
  if (transformResponse) {
    return transformResponse(response, { method, url });
  }

  // Apply errorFormatter for 500 errors from thrown exceptions
  if (
    errorFormatter &&
    response.status === 500 &&
    response.body !== null &&
    typeof response.body === "object" &&
    "error" in (response.body as Record<string, unknown>) &&
    "code" in (response.body as Record<string, unknown>)
  ) {
    const respBody = response.body as { error: string; code: string };
    const error = new Error(respBody.error);
    return {
      ...response,
      body: errorFormatter(error),
    };
  }

  return response;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Angular Adapter Integration", () => {
  let mock: Schmock.CallableMockInstance;

  // Stateful Todo CRUD handlers
  function registerTodoRoutes(m: Schmock.CallableMockInstance) {
    m("GET /todos", (ctx) => {
      const todos = (ctx.state.todos ?? []) as Array<Record<string, unknown>>;
      return todos;
    });

    m("POST /todos", (ctx) => {
      const todos = ((ctx.state.todos as Array<Record<string, unknown>>) ?? []);
      const newTodo = {
        id: String(todos.length + 1),
        ...(ctx.body as Record<string, unknown>),
      };
      todos.push(newTodo);
      ctx.state.todos = todos;
      return created(newTodo);
    });

    m("PATCH /todos/:id", (ctx) => {
      const todos = ((ctx.state.todos as Array<Record<string, unknown>>) ?? []);
      const idx = todos.findIndex((t) => t.id === ctx.params.id);
      if (idx === -1) return notFound("Todo not found");
      todos[idx] = { ...todos[idx], ...(ctx.body as Record<string, unknown>) };
      ctx.state.todos = todos;
      return todos[idx];
    });

    m("DELETE /todos/:id", (ctx) => {
      const todos = ((ctx.state.todos as Array<Record<string, unknown>>) ?? []);
      const idx = todos.findIndex((t) => t.id === ctx.params.id);
      if (idx === -1) return notFound("Todo not found");
      todos.splice(idx, 1);
      ctx.state.todos = todos;
      return noContent();
    });
  }

  beforeEach(() => {
    mock = schmock({ state: { todos: [] } });
    registerTodoRoutes(mock);
  });

  afterEach(() => {
    mock?.close();
  });

  // -----------------------------------------------------------------------
  // 1. baseUrl filters requests correctly
  // -----------------------------------------------------------------------

  describe("baseUrl filtering", () => {
    it("passes through requests outside the base URL", async () => {
      const result = await angularHandle(mock, "GET", "/other/stuff", {}, {
        baseUrl: "/api",
      });

      expect(result).toBe("PASSTHROUGH");
    });

    it("intercepts requests matching the base URL", async () => {
      const result = await angularHandle(mock, "GET", "/api/todos", {}, {
        baseUrl: "/api",
      });

      expect(result).not.toBe("PASSTHROUGH");
      expect((result as Schmock.Response).status).toBe(200);
    });

    it("intercepts all requests when no baseUrl is set", async () => {
      const result = await angularHandle(mock, "GET", "/todos");

      expect(result).not.toBe("PASSTHROUGH");
      expect((result as Schmock.Response).status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // 2. baseUrl strips prefix before routing
  // -----------------------------------------------------------------------

  describe("baseUrl prefix stripping", () => {
    it("strips baseUrl prefix so /api/todos matches route /todos", async () => {
      const result = (await angularHandle(mock, "GET", "/api/todos", {}, {
        baseUrl: "/api",
      })) as Schmock.Response;

      expect(result.status).toBe(200);
      expect(result.body).toEqual([]);
    });

    it("routes POST /api/todos to POST /todos handler", async () => {
      const result = (await angularHandle(
        mock,
        "POST",
        "/api/todos",
        { body: { title: "Buy groceries", done: false } },
        { baseUrl: "/api" },
      )) as Schmock.Response;

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ title: "Buy groceries" });
    });

    it("routes to / when request path equals baseUrl exactly", async () => {
      // Register a root handler
      mock("GET /", () => ({ root: true }));

      const result = (await angularHandle(mock, "GET", "/api", {}, {
        baseUrl: "/api",
      })) as Schmock.Response;

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ root: true });
    });

    it("handles full URLs with protocol and host", async () => {
      const result = (await angularHandle(
        mock,
        "GET",
        "http://localhost:4200/api/todos",
        {},
        { baseUrl: "/api" },
      )) as Schmock.Response;

      expect(result.status).toBe(200);
      expect(result.body).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Error status codes
  // -----------------------------------------------------------------------

  describe("error status codes", () => {
    it("returns 400 for bad request responses", async () => {
      mock("POST /validate", () => badRequest("Missing required field"));

      const result = (await angularHandle(mock, "POST", "/validate")) as Schmock.Response;

      expect(result.status).toBe(400);
    });

    it("returns 404 for not-found resources", async () => {
      const result = (await angularHandle(
        mock,
        "PATCH",
        "/todos/999",
        { body: { title: "updated" } },
      )) as Schmock.Response;

      expect(result.status).toBe(404);
    });

    it("returns 500 for server errors", async () => {
      mock("GET /broken", () => serverError("Database connection failed"));

      const result = (await angularHandle(mock, "GET", "/broken")) as Schmock.Response;

      expect(result.status).toBe(500);
    });

    it("returns 500 when handler throws", async () => {
      mock("GET /throw", () => {
        throw new Error("Unexpected failure");
      });

      const result = (await angularHandle(mock, "GET", "/throw")) as Schmock.Response;

      expect(result.status).toBe(500);
      expect(result.body).toMatchObject({ error: expect.stringContaining("Unexpected failure") });
    });
  });

  // -----------------------------------------------------------------------
  // 4. POST with JSON body flows through correctly
  // -----------------------------------------------------------------------

  describe("POST with JSON body", () => {
    it("creates a todo and persists it in state", async () => {
      // Create
      const createResult = (await angularHandle(mock, "POST", "/todos", {
        body: { title: "Write tests", done: false },
      })) as Schmock.Response;

      expect(createResult.status).toBe(201);
      expect(createResult.body).toMatchObject({
        id: "1",
        title: "Write tests",
        done: false,
      });

      // Verify via GET
      const listResult = (await angularHandle(mock, "GET", "/todos")) as Schmock.Response;

      expect(listResult.status).toBe(200);
      expect(listResult.body).toHaveLength(1);
      expect((listResult.body as Array<Record<string, unknown>>)[0]).toMatchObject({
        title: "Write tests",
      });
    });

    it("full CRUD cycle works end-to-end", async () => {
      // Create
      const c1 = (await angularHandle(mock, "POST", "/todos", {
        body: { title: "First" },
      })) as Schmock.Response;
      expect(c1.status).toBe(201);

      const c2 = (await angularHandle(mock, "POST", "/todos", {
        body: { title: "Second" },
      })) as Schmock.Response;
      expect(c2.status).toBe(201);

      // List
      const list = (await angularHandle(mock, "GET", "/todos")) as Schmock.Response;
      expect((list.body as unknown[]).length).toBe(2);

      // Update
      const updated = (await angularHandle(mock, "PATCH", "/todos/1", {
        body: { title: "First (edited)" },
      })) as Schmock.Response;
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ title: "First (edited)" });

      // Delete
      const deleted = (await angularHandle(mock, "DELETE", "/todos/1")) as Schmock.Response;
      expect(deleted.status).toBe(204);

      // Verify deletion
      const after = (await angularHandle(mock, "GET", "/todos")) as Schmock.Response;
      expect((after.body as unknown[]).length).toBe(1);
      expect((after.body as Array<Record<string, unknown>>)[0]).toMatchObject({
        title: "Second",
      });
    });

    it("passes body through baseUrl-prefixed routes", async () => {
      const result = (await angularHandle(
        mock,
        "POST",
        "/api/todos",
        { body: { title: "Via base URL", priority: "high" } },
        { baseUrl: "/api" },
      )) as Schmock.Response;

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({
        title: "Via base URL",
        priority: "high",
      });
    });
  });

  // -----------------------------------------------------------------------
  // 5. transformRequest
  // -----------------------------------------------------------------------

  describe("transformRequest", () => {
    it("modifies the request before Schmock handles it", async () => {
      mock("GET /transformed", () => ({ transformed: true }));

      const result = (await angularHandle(
        mock,
        "POST",
        "/original",
        {},
        {
          transformRequest: () => ({
            method: "GET",
            path: "/transformed",
          }),
        },
      )) as Schmock.Response;

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ transformed: true });
    });

    it("adds custom headers via transformRequest", async () => {
      mock("GET /check-header", (ctx) => ({
        hasAuth: "authorization" in ctx.headers,
        authValue: ctx.headers.authorization,
      }));

      const result = (await angularHandle(
        mock,
        "GET",
        "/check-header",
        {},
        {
          transformRequest: () => ({
            headers: { authorization: "Bearer secret-token" },
          }),
        },
      )) as Schmock.Response;

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        hasAuth: true,
        authValue: "Bearer secret-token",
      });
    });

    it("overrides query parameters via transformRequest", async () => {
      mock("GET /search", (ctx) => ({
        query: ctx.query,
      }));

      const result = (await angularHandle(
        mock,
        "GET",
        "/search",
        { query: { q: "original" } },
        {
          transformRequest: () => ({
            query: { q: "overridden", page: "2" },
          }),
        },
      )) as Schmock.Response;

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        query: { q: "overridden", page: "2" },
      });
    });
  });

  // -----------------------------------------------------------------------
  // 6. transformResponse
  // -----------------------------------------------------------------------

  describe("transformResponse", () => {
    it("modifies the response before returning", async () => {
      const result = (await angularHandle(
        mock,
        "GET",
        "/todos",
        {},
        {
          transformResponse: (response) => ({
            ...response,
            body: { wrapped: response.body },
            headers: { ...response.headers, "x-wrapped": "true" },
          }),
        },
      )) as Schmock.Response;

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ wrapped: [] });
      expect(result.headers["x-wrapped"]).toBe("true");
    });

    it("can change the status code", async () => {
      const result = (await angularHandle(
        mock,
        "GET",
        "/todos",
        {},
        {
          transformResponse: (response) => ({
            ...response,
            status: 202,
          }),
        },
      )) as Schmock.Response;

      expect(result.status).toBe(202);
    });

    it("receives the original request info", async () => {
      let capturedUrl = "";
      let capturedMethod = "";

      await angularHandle(
        mock,
        "POST",
        "/api/todos",
        { body: { title: "test" } },
        {
          baseUrl: "/api",
          transformResponse: (response, req) => {
            capturedUrl = req.url;
            capturedMethod = req.method;
            return response;
          },
        },
      );

      expect(capturedUrl).toBe("/api/todos");
      expect(capturedMethod).toBe("POST");
    });
  });

  // -----------------------------------------------------------------------
  // 7. errorFormatter
  // -----------------------------------------------------------------------

  describe("errorFormatter", () => {
    it("customizes error responses from thrown errors", async () => {
      mock("GET /fail", () => {
        throw new Error("DB timeout");
      });

      const result = (await angularHandle(
        mock,
        "GET",
        "/fail",
        {},
        {
          errorFormatter: (error) => ({
            custom: true,
            reason: error.message,
            timestamp: "2026-04-04T00:00:00Z",
          }),
        },
      )) as Schmock.Response;

      expect(result.status).toBe(500);
      expect(result.body).toEqual({
        custom: true,
        reason: "DB timeout",
        timestamp: "2026-04-04T00:00:00Z",
      });
    });

    it("does not alter non-500 error responses", async () => {
      const result = (await angularHandle(
        mock,
        "PATCH",
        "/todos/999",
        { body: { title: "nope" } },
        {
          errorFormatter: () => ({ should: "not appear" }),
        },
      )) as Schmock.Response;

      // 404 from handler — errorFormatter should NOT apply
      expect(result.status).toBe(404);
      expect(result.body).not.toMatchObject({ should: "not appear" });
    });

    it("works together with baseUrl", async () => {
      mock("GET /explode", () => {
        throw new Error("Kaboom");
      });

      const result = (await angularHandle(
        mock,
        "GET",
        "/api/explode",
        {},
        {
          baseUrl: "/api",
          errorFormatter: (error) => ({
            formatted: true,
            msg: error.message,
          }),
        },
      )) as Schmock.Response;

      expect(result.status).toBe(500);
      expect(result.body).toEqual({
        formatted: true,
        msg: "Kaboom",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Combined options
  // -----------------------------------------------------------------------

  describe("combined options", () => {
    it("baseUrl + transformRequest + transformResponse work together", async () => {
      const result = (await angularHandle(
        mock,
        "GET",
        "/api/todos",
        {},
        {
          baseUrl: "/api",
          transformRequest: (req) => ({
            headers: { ...req.headers, "x-source": "angular" },
          }),
          transformResponse: (response) => ({
            ...response,
            body: {
              data: response.body,
              meta: { source: "angular-adapter" },
            },
          }),
        },
      )) as Schmock.Response;

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        data: [],
        meta: { source: "angular-adapter" },
      });
    });

    it("full CRUD through baseUrl with transforms", async () => {
      const opts = {
        baseUrl: "/api",
        transformResponse: (response: Schmock.Response) => ({
          ...response,
          headers: { ...response.headers, "x-adapter": "angular" },
        }),
      };

      // Create
      const c = (await angularHandle(
        mock,
        "POST",
        "/api/todos",
        { body: { title: "Angular todo" } },
        opts,
      )) as Schmock.Response;
      expect(c.status).toBe(201);
      expect(c.headers["x-adapter"]).toBe("angular");

      // Read
      const list = (await angularHandle(
        mock,
        "GET",
        "/api/todos",
        {},
        opts,
      )) as Schmock.Response;
      expect((list.body as unknown[]).length).toBe(1);

      // Update
      const u = (await angularHandle(
        mock,
        "PATCH",
        "/api/todos/1",
        { body: { done: true } },
        opts,
      )) as Schmock.Response;
      expect(u.status).toBe(200);
      expect(u.body).toMatchObject({ done: true });

      // Delete
      const d = (await angularHandle(
        mock,
        "DELETE",
        "/api/todos/1",
        {},
        opts,
      )) as Schmock.Response;
      expect(d.status).toBe(204);
    });
  });
});
