/// <reference path="../../packages/core/schmock.d.ts" />

import { createRequire } from "node:module";
import { created, schmock } from "@schmock/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  HttpErrorResponse,
  HttpEvent,
  HttpHandler,
} from "../../packages/angular/node_modules/@angular/common/types/http";
import type { AngularAdapterOptions } from "../../packages/angular/src/index";

const requireFromAngular = createRequire(
  new URL("../../packages/angular/package.json", import.meta.url),
);
await import(requireFromAngular.resolve("@angular/compiler"));
const angularHttp: typeof import("../../packages/angular/node_modules/@angular/common/types/http") =
  await import(requireFromAngular.resolve("@angular/common/http"));
const rxjs: typeof import("../../packages/angular/node_modules/rxjs/dist/types/index") =
  await import(requireFromAngular.resolve("rxjs"));
const { createSchmockInterceptor } = await import(
  "../../packages/angular/src/index"
);
const { HttpHeaders, HttpRequest, HttpResponse } = angularHttp;
const { firstValueFrom, of } = rxjs;

const BACKEND_BODY = { source: "real-backend" };

interface InterceptRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  adapter?: AngularAdapterOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function intercept(
  mock: Schmock.CallableMockInstance,
  method: string,
  url: string,
  options: InterceptRequestOptions = {},
): Promise<HttpEvent<unknown>> {
  const Interceptor = createSchmockInterceptor(mock, options.adapter);
  const interceptor = new Interceptor();
  const request = new HttpRequest<unknown>(method, url, options.body, {
    headers: new HttpHeaders(options.headers),
  });
  const next: HttpHandler = {
    handle: () => of(new HttpResponse({ body: BACKEND_BODY, status: 200 })),
  };

  return firstValueFrom(interceptor.intercept(request, next));
}

describe("Angular Adapter Integration", () => {
  let mock: Schmock.CallableMockInstance;

  beforeEach(() => {
    mock = schmock({ state: { todos: [] } });
    mock("GET /todos", ({ state }) => {
      const todos = state.todos;
      return Array.isArray(todos) ? todos : [];
    });
    mock("POST /todos", ({ body, state }) => {
      const todo = { id: "1", ...(isRecord(body) ? body : {}) };
      state.todos = [todo];
      return created(todo);
    });
  });

  afterEach(() => {
    mock.close();
  });

  it("executes the production interceptor across a stateful request flow", async () => {
    const createdEvent = await intercept(mock, "POST", "/api/todos", {
      body: { title: "Write integration tests" },
      adapter: { baseUrl: "/api" },
    });
    expect(createdEvent).toBeInstanceOf(HttpResponse);
    if (!(createdEvent instanceof HttpResponse)) {
      throw new Error("Expected the interceptor to return an HttpResponse");
    }
    expect(createdEvent.status).toBe(201);
    expect(createdEvent.body).toMatchObject({
      id: "1",
      title: "Write integration tests",
    });

    const listEvent = await intercept(mock, "GET", "/api/todos", {
      adapter: { baseUrl: "/api" },
    });
    expect(listEvent).toBeInstanceOf(HttpResponse);
    if (!(listEvent instanceof HttpResponse)) {
      throw new Error("Expected the interceptor to return an HttpResponse");
    }
    expect(listEvent.body).toEqual([
      { id: "1", title: "Write integration tests" },
    ]);
  });

  it("passes a sibling path through even in strict mode", async () => {
    const event = await intercept(mock, "GET", "/apiv2/todos", {
      adapter: { baseUrl: "/api", passthrough: false },
    });

    expect(event).toBeInstanceOf(HttpResponse);
    if (!(event instanceof HttpResponse)) {
      throw new Error("Expected the backend to return an HttpResponse");
    }
    expect(event.body).toEqual(BACKEND_BODY);
  });

  it("passes unsupported methods through without routing them as GET", async () => {
    const event = await intercept(mock, "PROPFIND", "/todos", {
      adapter: { passthrough: false },
    });

    expect(event).toBeInstanceOf(HttpResponse);
    if (!(event instanceof HttpResponse)) {
      throw new Error("Expected the backend to return an HttpResponse");
    }
    expect(event.body).toEqual(BACKEND_BODY);
  });

  it("applies request and response transforms through the production adapter", async () => {
    mock("GET /transformed", ({ headers }) => ({
      authorization: headers.authorization,
    }));

    const event = await intercept(mock, "POST", "/api/original", {
      adapter: {
        baseUrl: "/api",
        transformRequest: () => ({
          method: "GET",
          path: "/transformed",
          headers: { authorization: "Bearer transformed" },
        }),
        transformResponse: (response) => ({
          ...response,
          body: { wrapped: response.body },
        }),
      },
    });

    expect(event).toBeInstanceOf(HttpResponse);
    if (!(event instanceof HttpResponse)) {
      throw new Error("Expected the interceptor to return an HttpResponse");
    }
    expect(event.body).toEqual({
      wrapped: { authorization: "Bearer transformed" },
    });
  });

  it("converts Schmock failures through the production error path", async () => {
    mock("GET /fail", () => {
      throw new Error("Database unavailable");
    });

    await expect(
      intercept(mock, "GET", "/fail", {
        adapter: {
          errorFormatter: (error) => ({ reason: error.message }),
        },
      }),
    ).rejects.toMatchObject({
      status: 500,
      error: { reason: "Database unavailable" },
    } satisfies Partial<HttpErrorResponse>);
  });
});
