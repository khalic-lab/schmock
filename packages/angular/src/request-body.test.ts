// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import {
  HttpErrorResponse,
  type HttpEvent,
  HttpEventType,
  HttpHeaders,
  HttpParams,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import { type CallableMockInstance, schmock } from "@schmock/core";
import { lastValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { type AngularAdapterOptions, createSchmockInterceptor } from "./index";

/** The Accept header Angular's backends add when the caller set none. */
const ANGULAR_ACCEPT = "application/json, text/plain, */*";

interface Received {
  body: unknown;
  contentType: string | undefined;
  accept: string | undefined;
}

interface Outcome {
  events: HttpEvent<unknown>[];
  error?: unknown;
  routed: boolean;
  body?: unknown;
  contentType?: string;
}

/** Every event an Angular request emits, its error, and the body the route saw. */
async function outcome(
  request: HttpRequest<unknown>,
  options: AngularAdapterOptions,
): Promise<Outcome> {
  const mock = schmock();
  const result: Outcome = { events: [], routed: false };
  mock("POST /echo", ({ body, headers }) => {
    result.routed = true;
    result.body = body;
    result.contentType = headers["content-type"];
    return [200, { ok: true }];
  });
  const Interceptor = createSchmockInterceptor(mock, options);
  const real: HttpEvent<unknown> = new HttpResponse({ body: "real" });
  return new Promise((resolve) => {
    new Interceptor().intercept(request, { handle: () => of(real) }).subscribe({
      next: (event) => result.events.push(event),
      complete: () => resolve(result),
      error: (error: unknown) => resolve({ ...result, error }),
    });
  });
}

/** What a route handler receives for an Angular request sent through the adapter. */
async function received(request: HttpRequest<unknown>): Promise<Received> {
  const mock = schmock();
  let seen: Received | undefined;
  const record = ({
    body,
    headers,
  }: {
    body?: unknown;
    headers: Record<string, string>;
  }) => {
    seen = {
      body,
      contentType: headers["content-type"],
      accept: headers.accept,
    };
    return [200, { ok: true }] as [number, unknown];
  };
  mock("GET /echo", record);
  mock("POST /echo", record);
  mock("PUT /echo", record);

  const Interceptor = createSchmockInterceptor(mock, { passthrough: false });
  const real: HttpEvent<unknown> = new HttpResponse({ body: "real" });
  await lastValueFrom(
    new Interceptor().intercept(request, { handle: () => of(real) }),
  );
  if (seen === undefined) throw new Error("the route did not run");
  return seen;
}

describe("Angular request bodies reach handlers as the backend sends them", () => {
  describe("bodyless requests", () => {
    it("delivers no body for a GET", async () => {
      expect(await received(new HttpRequest("GET", "/echo"))).toEqual({
        body: undefined,
        contentType: undefined,
        accept: ANGULAR_ACCEPT,
      });
    });

    it("delivers no body for a POST without one", async () => {
      const { body, contentType } = await received(
        new HttpRequest("POST", "/echo", null),
      );
      expect(body).toBeUndefined();
      expect(contentType).toBeUndefined();
    });
  });

  describe("bodies Angular serializes", () => {
    it("parses a JSON object and labels it application/json", async () => {
      expect(
        await received(new HttpRequest("POST", "/echo", { name: "Rex" })),
      ).toEqual({
        body: { name: "Rex" },
        contentType: "application/json",
        accept: ANGULAR_ACCEPT,
      });
    });

    it("delivers an HttpParams form as its fields", async () => {
      const form = new HttpParams()
        .set("grant_type", "password")
        .set("user", "alice");
      expect(await received(new HttpRequest("POST", "/echo", form))).toEqual({
        body: { grant_type: "password", user: "alice" },
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        accept: ANGULAR_ACCEPT,
      });
    });

    it("delivers a string as text/plain", async () => {
      expect(
        await received(new HttpRequest("POST", "/echo", "hello")),
      ).toMatchObject({ body: "hello", contentType: "text/plain" });
    });

    it("delivers a URLSearchParams form labelled as one as its fields", async () => {
      const request = new HttpRequest(
        "POST",
        "/echo",
        new URLSearchParams({ user: "alice" }),
        {
          headers: new HttpHeaders({
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        },
      );
      expect(await received(request)).toMatchObject({
        body: { user: "alice" },
        contentType: "application/x-www-form-urlencoded",
      });
    });

    it("keeps Angular's application/json label on an unlabelled URLSearchParams", async () => {
      // Angular's backends label it this way too, so a real server receives
      // urlencoded text under a JSON content type. The text is not JSON: a
      // passthrough interceptor routes it as text, a strict one refuses it.
      const request = () =>
        new HttpRequest("POST", "/echo", new URLSearchParams({ a: "1" }));
      expect(await outcome(request(), { passthrough: true })).toMatchObject({
        body: "a=1",
        contentType: "application/json",
      });
      expect(
        (await outcome(request(), { passthrough: false })).error,
      ).toMatchObject({ status: 400, error: { code: "MALFORMED_JSON" } });
    });

    it("delivers a Blob decoded by its own type", async () => {
      const blob = new Blob([JSON.stringify({ a: 1 })], {
        type: "application/json",
      });
      expect(
        await received(new HttpRequest("PUT", "/echo", blob)),
      ).toMatchObject({ body: { a: 1 }, contentType: "application/json" });
    });

    it("delivers an ArrayBuffer as a copy of its bytes", async () => {
      const bytes = new Uint8Array([1, 2, 3]).buffer;
      const { body, contentType } = await received(
        new HttpRequest("PUT", "/echo", bytes),
      );
      expect(body).toBeInstanceOf(ArrayBuffer);
      expect(body).not.toBe(bytes);
      expect([...new Uint8Array(body as ArrayBuffer)]).toEqual([1, 2, 3]);
      expect(contentType).toBeUndefined();
    });

    it("delivers FormData as is", async () => {
      const form = new FormData();
      form.set("name", "Rex");
      const { body } = await received(new HttpRequest("POST", "/echo", form));
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("name")).toBe("Rex");
    });

    it("labels FormData multipart/form-data, as the browser sends it", async () => {
      const form = new FormData();
      form.set("name", "Rex");
      expect(
        await received(new HttpRequest("POST", "/echo", form)),
      ).toMatchObject({ contentType: "multipart/form-data" });
    });

    it("keeps the caller's Content-Type on FormData", async () => {
      const request = new HttpRequest("POST", "/echo", new FormData(), {
        headers: new HttpHeaders({ "Content-Type": "multipart/mixed" }),
      });
      expect(await received(request)).toMatchObject({
        contentType: "multipart/mixed",
      });
    });
  });

  describe("headers the caller set", () => {
    it("keeps the caller's Content-Type and Accept, decoding by that type", async () => {
      const request = new HttpRequest(
        "POST",
        "/echo",
        { op: "replace" },
        {
          headers: new HttpHeaders({
            "Content-Type": "application/merge-patch+json",
            Accept: "application/xml",
          }),
        },
      );
      expect(await received(request)).toEqual({
        body: { op: "replace" },
        contentType: "application/merge-patch+json",
        accept: "application/xml",
      });
    });

    it("parses a JSON-labelled string", async () => {
      const request = new HttpRequest("POST", "/echo", '{"a":1}', {
        headers: new HttpHeaders({ "Content-Type": "application/json" }),
      });
      expect(await received(request)).toMatchObject({ body: { a: 1 } });
    });
  });

  describe("bodies core's ingress refuses or parses", () => {
    /** A multipart body with one `name` field, delimited by `boundary`. */
    const multipart = (boundary: string): string =>
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="name"\r\n\r\n' +
      `Rex\r\n--${boundary}--\r\n`;

    const jsonText = (text: string) =>
      new HttpRequest("POST", "/echo", text, {
        headers: new HttpHeaders({ "Content-Type": "application/json" }),
      });

    it("answers a JSON-labelled string that does not parse with 400 MALFORMED_JSON", async () => {
      const { events, error, routed } = await outcome(jsonText("not json"), {
        passthrough: false,
      });
      expect(routed).toBe(false);
      expect(events.map((event) => event.type)).toEqual([HttpEventType.Sent]);
      expect(error).toBeInstanceOf(HttpErrorResponse);
      expect(error).toMatchObject({
        status: 400,
        error: { error: "Malformed JSON request body", code: "MALFORMED_JSON" },
      });
    });

    it("answers JSON nested past 256 levels with 400 JSON_TOO_DEEP", async () => {
      const deep = `${"[".repeat(257)}${"]".repeat(257)}`;
      const { error, routed } = await outcome(jsonText(deep), {
        passthrough: false,
      });
      expect(routed).toBe(false);
      expect(error).toMatchObject({
        status: 400,
        error: { code: "JSON_TOO_DEEP" },
      });
    });

    it("routes a JSON body it refuses as its text when passthrough is on", async () => {
      const { body, error } = await outcome(jsonText("not json"), {
        passthrough: true,
      });
      expect(error).toBeUndefined();
      expect(body).toBe("not json");
    });

    it("decodes a multipart-labelled string to FormData", async () => {
      const request = new HttpRequest("POST", "/echo", multipart("xyz"), {
        headers: new HttpHeaders({
          "Content-Type": "multipart/form-data; boundary=xyz",
        }),
      });
      const { body } = await received(request);
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("name")).toBe("Rex");
    });

    it("decodes a multipart Blob to FormData", async () => {
      const blob = new Blob([multipart("xyz")], {
        type: "multipart/form-data; boundary=xyz",
      });
      const { body } = await received(new HttpRequest("PUT", "/echo", blob));
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("name")).toBe("Rex");
    });

    it("passes an unmocked request through without reading its body", async () => {
      const request = new HttpRequest("POST", "/other", "garbage", {
        headers: new HttpHeaders({
          "Content-Type": "multipart/form-data; boundary=x",
        }),
      });
      const { events, error, routed } = await outcome(request, {
        passthrough: true,
      });
      expect(error).toBeUndefined();
      expect(routed).toBe(false);
      expect(events).toEqual([expect.objectContaining({ body: "real" })]);
    });

    it("reads the body of an unrouted request a request hook reroutes", async () => {
      // The hook may move the request onto a route, so the arrival path
      // alone cannot tell the adapter to skip the body.
      const request = new HttpRequest("POST", "/other", "plain text", {
        headers: new HttpHeaders({ "Content-Type": "text/plain" }),
      });
      const { body, error, routed } = await outcome(request, {
        passthrough: true,
        transformRequest: () => ({ path: "/echo" }),
      });
      expect(error).toBeUndefined();
      expect(routed).toBe(true);
      expect(body).toBe("plain text");
    });

    it("fails an unrouted body it cannot parse when passthrough is off", async () => {
      // With passthrough off the mock owns every request, so the body is
      // read, and fails, before the route miss would answer 404.
      const request = new HttpRequest("POST", "/other", "garbage", {
        headers: new HttpHeaders({
          "Content-Type": "multipart/form-data; boundary=x",
        }),
      });
      const { error, routed } = await outcome(request, { passthrough: false });
      expect(routed).toBe(false);
      expect(error).toMatchObject({ status: 500 });
    });

    it("reads the body for a hand-written mock under passthrough", async () => {
      // A hand-written mock has no admission to say a route is missing, so
      // the body is read and reaches its handle().
      const handle = vi.fn(async () => ({
        status: 200,
        body: { ok: true },
        headers: {},
      }));
      const mock = { handle, pipe: vi.fn() } as unknown as CallableMockInstance;
      const Interceptor = createSchmockInterceptor(mock, { passthrough: true });
      const request = new HttpRequest("POST", "/echo", "plain text", {
        headers: new HttpHeaders({ "Content-Type": "text/plain" }),
      });
      await lastValueFrom(
        new Interceptor().intercept(request, {
          handle: () => of(new HttpResponse({ body: "real" })),
        }),
      );
      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledWith(
        "POST",
        "/echo",
        expect.objectContaining({ body: "plain text" }),
      );
    });

    it("reads the body when the admission has no route probe", async () => {
      // An admission without hasRoute cannot say a route is missing, so the
      // body is read and reaches the admission's handle().
      const handle = vi.fn(async () => ({
        status: 200,
        body: { ok: true },
        headers: {},
      }));
      const release = vi.fn();
      const mock = {
        handle: vi.fn(),
        pipe: vi.fn(),
        [Symbol.for("@schmock/core.request-admission")]: () => ({
          handle,
          release,
        }),
      } as unknown as CallableMockInstance;
      const Interceptor = createSchmockInterceptor(mock, { passthrough: true });
      const request = new HttpRequest("POST", "/echo", "plain text", {
        headers: new HttpHeaders({ "Content-Type": "text/plain" }),
      });
      await lastValueFrom(
        new Interceptor().intercept(request, {
          handle: () => of(new HttpResponse({ body: "real" })),
        }),
      );
      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledWith(
        "POST",
        "/echo",
        expect.objectContaining({ body: "plain text" }),
      );
      expect(release).toHaveBeenCalledTimes(1);
    });

    it("reads the body when the admission's route probe throws", async () => {
      // A probe that throws cannot say a route is missing, so the body is
      // read and reaches the admission's handle().
      const handle = vi.fn(async () => ({
        status: 200,
        body: { ok: true },
        headers: {},
      }));
      const mock = {
        handle: vi.fn(),
        pipe: vi.fn(),
        [Symbol.for("@schmock/core.request-admission")]: () => ({
          handle,
          release: vi.fn(),
          hasRoute: () => {
            throw new Error("probe failed");
          },
        }),
      } as unknown as CallableMockInstance;
      const Interceptor = createSchmockInterceptor(mock, { passthrough: true });
      const request = new HttpRequest("POST", "/echo", "plain text", {
        headers: new HttpHeaders({ "Content-Type": "text/plain" }),
      });
      await lastValueFrom(
        new Interceptor().intercept(request, {
          handle: () => of(new HttpResponse({ body: "real" })),
        }),
      );
      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledWith(
        "POST",
        "/echo",
        expect.objectContaining({ body: "plain text" }),
      );
    });

    it("fails a multipart body the platform cannot parse", async () => {
      const request = new HttpRequest("POST", "/echo", multipart("xyz"), {
        headers: new HttpHeaders({ "Content-Type": "multipart/form-data" }),
      });
      const { error, routed } = await outcome(request, { passthrough: false });
      expect(routed).toBe(false);
      expect(error).toMatchObject({ status: 500 });
    });
  });

  describe("urlencoded forms keep every value of a repeated name", () => {
    interface SeenForm {
      body: unknown;
      tags: string[] | undefined;
    }

    async function seenForm(
      request: HttpRequest<unknown>,
      options: AngularAdapterOptions = {},
    ): Promise<SeenForm> {
      const mock = schmock();
      let seen: SeenForm | undefined;
      mock("POST /echo", ({ body, form }) => {
        seen = { body, tags: form?.getAll("tag") };
        return [200, { ok: true }];
      });
      const Interceptor = createSchmockInterceptor(mock, {
        passthrough: false,
        ...options,
      });
      const real: HttpEvent<unknown> = new HttpResponse({ body: "real" });
      await lastValueFrom(
        new Interceptor().intercept(request, { handle: () => of(real) }),
      );
      if (seen === undefined) throw new Error("the route did not run");
      return seen;
    }

    const repeatedTags = () =>
      new HttpRequest(
        "POST",
        "/echo",
        new HttpParams().append("tag", "a").append("tag", "b"),
      );

    it("hands the route the form beside the last-wins body", async () => {
      expect(await seenForm(repeatedTags())).toEqual({
        body: { tag: "b" },
        tags: ["a", "b"],
      });
    });

    it("keeps the form when a request hook leaves the body alone", async () => {
      const seen = await seenForm(repeatedTags(), {
        transformRequest: () => ({ headers: { "x-hooked": "1" } }),
      });
      expect(seen.tags).toEqual(["a", "b"]);
    });

    it("drops the form when a request hook replaces the body", async () => {
      expect(
        await seenForm(repeatedTags(), {
          transformRequest: () => ({ body: { tag: "c" } }),
        }),
      ).toEqual({ body: { tag: "c" }, tags: undefined });
    });
  });
});
