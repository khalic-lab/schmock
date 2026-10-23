// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import {
  HttpClient,
  type HttpEvent,
  HttpEventType,
  type HttpHandler,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import { schmock } from "@schmock/core";
import { lastValueFrom, type Observable, of, toArray } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { type AngularAdapterOptions, createSchmockInterceptor } from "./index";

/** A backend that answers the way Angular's own backends do: Sent first. */
function realBackend(): HttpHandler {
  return {
    handle: vi.fn(
      (): Observable<HttpEvent<unknown>> =>
        of(
          { type: HttpEventType.Sent },
          new HttpResponse({ body: "real backend" }),
        ),
    ),
  };
}

function eventTypes(events: HttpEvent<unknown>[]): HttpEventType[] {
  return events.map((event) => event.type);
}

/** Every event the interceptor emits, and the error it ends with, if any. */
async function interceptEvents(
  request: HttpRequest<unknown>,
  options: AngularAdapterOptions = {},
  backend: HttpHandler = realBackend(),
): Promise<{ events: HttpEvent<unknown>[]; error?: unknown }> {
  const mock = schmock();
  mock("POST /api/up", [201, { id: 1 }]);
  mock("GET /api/fail", () => [500, { error: "domain" }]);
  const Interceptor = createSchmockInterceptor(mock, options);
  const events: HttpEvent<unknown>[] = [];
  return new Promise((resolve) => {
    new Interceptor().intercept(request, backend).subscribe({
      next: (event) => events.push(event),
      complete: () => resolve({ events }),
      error: (error: unknown) => resolve({ events, error }),
    });
  });
}

describe("Angular interceptor events", () => {
  it("emits Sent before the response the mock answers", async () => {
    const { events } = await interceptEvents(
      new HttpRequest("POST", "/api/up", { name: "x" }),
    );
    expect(eventTypes(events)).toEqual([
      HttpEventType.Sent,
      HttpEventType.Response,
    ]);
  });

  it("emits Sent before an error response", async () => {
    const { events, error } = await interceptEvents(
      new HttpRequest("GET", "/api/fail"),
    );
    expect(eventTypes(events)).toEqual([HttpEventType.Sent]);
    expect(error).toMatchObject({ status: 500 });
  });

  it("emits Sent before the 404 of a strict miss", async () => {
    const { events, error } = await interceptEvents(
      new HttpRequest("GET", "/api/missing"),
      { passthrough: false },
    );
    expect(eventTypes(events)).toEqual([HttpEventType.Sent]);
    expect(error).toMatchObject({ status: 404 });
  });

  it("emits Sent before the 500 of a mock whose handle() rejects", async () => {
    const mock = schmock();
    mock("GET /api/x", [200, {}]);
    vi.spyOn(mock, "handle").mockRejectedValue(new Error("boom"));
    const Interceptor = createSchmockInterceptor(mock);
    const events: HttpEvent<unknown>[] = [];
    const error = await new Promise<unknown>((resolve) => {
      new Interceptor()
        .intercept(new HttpRequest("GET", "/api/x"), realBackend())
        .subscribe({
          next: (event) => events.push(event),
          error: resolve,
        });
    });
    expect(eventTypes(events)).toEqual([HttpEventType.Sent]);
    expect(error).toMatchObject({ status: 500, error: { error: "boom" } });
  });

  it("emits no Sent when a request hook throws before dispatch", async () => {
    const { events, error } = await interceptEvents(
      new HttpRequest("POST", "/api/up", null),
      {
        beforeRequest: () => {
          throw new Error("hook");
        },
      },
    );
    expect(events).toEqual([]);
    expect(error).toMatchObject({ status: 500 });
  });

  it("leaves Sent to the real backend on a passthrough miss", async () => {
    const backend = realBackend();
    const { events } = await interceptEvents(
      new HttpRequest("GET", "/api/missing"),
      {},
      backend,
    );
    expect(backend.handle).toHaveBeenCalledOnce();
    expect(eventTypes(events)).toEqual([
      HttpEventType.Sent,
      HttpEventType.Response,
    ]);
  });

  it("leaves Sent to the real backend for a hook rewrite to an unsupported method", async () => {
    const { events } = await interceptEvents(
      new HttpRequest("POST", "/api/up", null),
      { beforeRequest: () => ({ method: "PURGE" }) },
    );
    expect(eventTypes(events)).toEqual([
      HttpEventType.Sent,
      HttpEventType.Response,
    ]);
  });

  it("gives HttpClient's observe: 'events' the stream a backend gives", async () => {
    const mock = schmock();
    mock("POST /api/up", [201, { id: 1 }]);
    const Interceptor = createSchmockInterceptor(mock);
    const interceptor = new Interceptor();
    const http = new HttpClient({
      handle: (request) => interceptor.intercept(request, realBackend()),
    });

    const events = await lastValueFrom(
      http
        .post("/api/up", { name: "x" }, { observe: "events" })
        .pipe(toArray()),
    );

    expect(eventTypes(events)).toEqual([
      HttpEventType.Sent,
      HttpEventType.Response,
    ]);
    expect(events[1]).toMatchObject({ status: 201, body: { id: 1 } });
  });
});
