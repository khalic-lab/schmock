// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandler,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import type * as Schmock from "@schmock/core";
import { schmock } from "@schmock/core";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { type AngularAdapterOptions, createSchmockInterceptor } from "./index";

const realResponse = new HttpResponse({ body: "real backend" });

function passthroughHandler(): HttpHandler {
  return { handle: vi.fn(() => of(realResponse)) };
}

/** A mock whose handle() records the path and answers 200 with it. */
function recordingMock() {
  const handle = vi.fn(async (_method: string, path: string) => ({
    status: 200,
    body: { path },
    headers: {},
  }));
  const mock = { handle } as unknown as Schmock.CallableMockInstance;
  return { mock, handle };
}

function run(
  mock: Schmock.CallableMockInstance,
  req: HttpRequest<unknown>,
  options: AngularAdapterOptions = {},
  next: HttpHandler = passthroughHandler(),
): Promise<HttpEvent<unknown>> {
  const Interceptor = createSchmockInterceptor(mock, options);
  return firstValueFrom(new Interceptor().intercept(req, next));
}

async function runError(
  mock: Schmock.CallableMockInstance,
  req: HttpRequest<unknown>,
  options: AngularAdapterOptions = {},
): Promise<HttpErrorResponse> {
  try {
    await run(mock, req, options);
  } catch (error) {
    if (error instanceof HttpErrorResponse) return error;
    throw error;
  }
  throw new Error("expected an HttpErrorResponse");
}

async function routedPath(
  baseUrl: string,
  url: string,
): Promise<string | undefined> {
  const { mock, handle } = recordingMock();
  const next = passthroughHandler();
  const event = await run(mock, new HttpRequest("GET", url), { baseUrl }, next);
  if (event === realResponse) return undefined;
  return handle.mock.calls[0]?.[1];
}

describe("Angular baseUrl matching is core's (R8)", () => {
  it("matches an encoded prefix against a raw request path", async () => {
    expect(await routedPath("/caf%C3%A9", "/café/users")).toBe("/users");
  });

  it("matches a raw prefix against an encoded request path", async () => {
    expect(await routedPath("/café", "/caf%C3%A9/users")).toBe("/users");
    expect(await routedPath("/café", "http://localhost/café/users")).toBe(
      "/users",
    );
  });

  it("keeps the request's own spelling of the stripped remainder", async () => {
    expect(await routedPath("/api", "/api/café")).toBe("/café");
    expect(await routedPath("/caf%C3%A9", "/café/%e2%82%ac")).toBe(
      "/%e2%82%ac",
    );
  });

  it("still strips to '/' and respects segment boundaries", async () => {
    expect(await routedPath("/api", "/api")).toBe("/");
    expect(await routedPath("/api/", "/api/users")).toBe("/users");
    expect(await routedPath("/api", "/apiv2/users")).toBeUndefined();
    expect(await routedPath("/", "/users")).toBe("/users");
  });

  it("reads a baseUrl without a leading slash as rooted", async () => {
    // Previously "api" never matched a pathname, so everything passed through.
    expect(await routedPath("api", "/api/users")).toBe("/users");
  });

  it("requires the origin of an origin-form baseUrl", async () => {
    const base = "http://localhost:4200/api";
    expect(await routedPath(base, "http://localhost:4200/api/users")).toBe(
      "/users",
    );
    expect(await routedPath(base, "http://other:4200/api/users")).toBe(
      undefined,
    );
    expect(await routedPath(base, "/api/users")).toBeUndefined();
    expect(
      await routedPath(base, "/api/users?next=http://localhost:4200/api"),
    ).toBeUndefined();
  });
});

describe("Angular beforeRequest / beforeResponse aliases (types-108)", () => {
  it("applies a sync or async beforeRequest override", async () => {
    for (const beforeRequest of [
      () => ({ path: "/rewritten" }),
      async () => ({ path: "/rewritten" }),
    ]) {
      const { mock, handle } = recordingMock();
      await run(mock, new HttpRequest("GET", "/original"), { beforeRequest });
      expect(handle.mock.calls[0]?.[1]).toBe("/rewritten");
    }
  });

  it("leaves the request unchanged when beforeRequest returns nothing", async () => {
    const { mock, handle } = recordingMock();
    const seen: string[] = [];
    await run(mock, new HttpRequest("GET", "/original"), {
      beforeRequest: async (request) => {
        seen.push(request.url);
      },
    });
    expect(seen).toEqual(["/original"]);
    expect(handle.mock.calls[0]?.[1]).toBe("/original");
  });

  it("passes through when an async beforeRequest picks an unsupported method", async () => {
    const { mock, handle } = recordingMock();
    const event = await run(mock, new HttpRequest("GET", "/x"), {
      beforeRequest: async () => ({ method: "PROPFIND" }),
    });
    expect(event).toBe(realResponse);
    expect(handle).not.toHaveBeenCalled();
  });

  it("shapes a rejecting beforeRequest through errorFormatter", async () => {
    const { mock, handle } = recordingMock();
    const error = await runError(mock, new HttpRequest("GET", "/x"), {
      beforeRequest: async () => {
        throw new Error("hook rejected");
      },
      errorFormatter: (cause) => ({ formatted: cause.message }),
    });
    expect(error.status).toBe(500);
    expect(error.error).toEqual({ formatted: "hook rejected" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("applies a sync or async beforeResponse and keeps the response on void", async () => {
    const replace = (response: Schmock.Response) => ({
      ...response,
      body: { replaced: true },
    });
    for (const [beforeResponse, expected] of [
      [replace, { replaced: true }],
      [
        async (response: Schmock.Response) => replace(response),
        { replaced: true },
      ],
      [async () => undefined, { path: "/x" }],
      [() => undefined, { path: "/x" }],
    ] as const) {
      const { mock } = recordingMock();
      const event = await run(mock, new HttpRequest("GET", "/x"), {
        beforeResponse,
      });
      expect(event).toBeInstanceOf(HttpResponse);
      expect(event instanceof HttpResponse && event.body).toEqual(expected);
    }
  });

  it("formats a core exception whose mark an async beforeResponse dropped", async () => {
    const mock = schmock();
    mock("GET /boom", () => {
      throw new Error("boom");
    });
    const errorFormatter = vi.fn((cause: Error) => ({
      formatted: cause.message,
    }));
    const error = await runError(mock, new HttpRequest("GET", "/boom"), {
      errorFormatter,
      beforeResponse: async (response) => ({
        ...response,
        headers: { ...response.headers, "retry-after": "5" },
      }),
    });
    expect(errorFormatter).toHaveBeenCalledTimes(1);
    expect(error.error).toEqual({ formatted: "boom" });
    expect(error.headers.get("retry-after")).toBe("5");
    expect(error.headers.get("content-type")).toBe("application/json");
  });

  it("uses transformRequest / transformResponse when both names are set", async () => {
    const { mock, handle } = recordingMock();
    const beforeRequest = vi.fn(() => ({ path: "/before" }));
    const beforeResponse = vi.fn(() => undefined);
    const event = await run(mock, new HttpRequest("GET", "/x"), {
      transformRequest: () => ({ path: "/transform" }),
      beforeRequest,
      transformResponse: (response) => ({ ...response, body: "transform" }),
      beforeResponse,
    });
    expect(handle.mock.calls[0]?.[1]).toBe("/transform");
    expect(event instanceof HttpResponse && event.body).toBe("transform");
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(beforeResponse).not.toHaveBeenCalled();
  });

  it("awaits a promise returned from transformRequest / transformResponse", async () => {
    // Previously a Promise was spread into the request (its override lost)
    // and handed to the normalizer as the response (a 500).
    const { mock, handle } = recordingMock();
    const event = await run(mock, new HttpRequest("GET", "/x"), {
      transformRequest: (() => Promise.resolve({ path: "/async" })) as never,
      transformResponse: ((response: Schmock.Response) =>
        Promise.resolve({ ...response, body: "async" })) as never,
    });
    expect(handle.mock.calls[0]?.[1]).toBe("/async");
    expect(event instanceof HttpResponse && event.body).toBe("async");
  });

  it("still errors when transformResponse returns nothing", async () => {
    const { mock } = recordingMock();
    const error = await runError(mock, new HttpRequest("GET", "/x"), {
      transformResponse: (() => undefined) as never,
    });
    expect(error.status).toBe(500);
  });
});

describe("Angular out-of-band errors keep their fallback body", () => {
  it("falls back to the failure's message and code when the formatter throws", async () => {
    const handle = vi.fn(async () => {
      throw Object.assign(new Error("handler failed"), { code: "E_HANDLER" });
    });
    const mock = { handle } as unknown as Schmock.CallableMockInstance;
    const error = await runError(mock, new HttpRequest("GET", "/x"), {
      errorFormatter: () => {
        throw new Error("formatter failed");
      },
    });
    expect(error.status).toBe(500);
    expect(error.statusText).toBe("Internal Server Error");
    expect(error.error).toEqual({ error: "handler failed", code: "E_HANDLER" });
  });

  it("answers the minimal body when the formatted body cannot be serialized", async () => {
    const handle = vi.fn(async () => {
      throw new Error("handler failed");
    });
    const mock = { handle } as unknown as Schmock.CallableMockInstance;
    const error = await runError(mock, new HttpRequest("GET", "/x"), {
      errorFormatter: () => ({ cause: new Error("not JSON") }),
    });
    expect(error.error).toEqual({
      error: "Internal Server Error",
      code: "INTERNAL_ERROR",
    });
  });

  it("reports 404 with its status text when passthrough is off", async () => {
    const mock = schmock();
    const error = await runError(mock, new HttpRequest("GET", "/missing"), {
      passthrough: false,
    });
    expect(error.status).toBe(404);
    expect(error.statusText).toBe("Not Found");
    expect(error.error).toEqual({ message: "No matching mock route found" });
  });
});
