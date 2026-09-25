import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortReason,
  acquireRequestAdmission,
  createFetchInterceptor as adapterFetchInterceptor,
  awaitWithAbort,
} from "./adapter.js";
import {
  buildFormattedErrorResponse,
  collectBody,
  createFetchInterceptor,
  getHeader,
  getResponseParts,
  InvalidHttpMethodError,
  matchPathPrefix,
  parsePathPrefix,
  redactHeaders,
  replaceResponseBody,
  SchmockError,
  SENSITIVE_HEADER_NAMES,
  schmock,
  serveNodeRequest,
  toHttpMethod,
  withDefaultContentType,
} from "./index.js";

// ── Helpers ────────────────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function parseRawResponse(raw: string): RawResponse {
  const headEnd = raw.indexOf("\r\n\r\n");
  const head = headEnd === -1 ? raw : raw.slice(0, headEnd);
  const body = headEnd === -1 ? "" : raw.slice(headEnd + 4);
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  return { status: Number(statusLine.split(" ")[1]), headers, body };
}

/** Node's own client rejects the malformed requests these tests need. */
function sendRaw(port: number, requestText: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      resolve(parseRawResponse(Buffer.concat(chunks).toString("utf8")));
    });
    socket.write(requestText);
  });
}

function rawRequest(requestLine: string, host = "127.0.0.1"): string {
  return `${requestLine} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
}

function bodyCode(response: RawResponse): unknown {
  const parsed: unknown = JSON.parse(response.body);
  return typeof parsed === "object" && parsed !== null && "code" in parsed
    ? parsed.code
    : undefined;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  vi.restoreAllMocks();
});

function listenOn(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

// ── R9: response decomposition ─────────────────────────────────────────────

describe("getResponseParts", () => {
  it("reads a plain value as a 200 body and a nullish one as 204", () => {
    expect(getResponseParts({ id: 1 })).toEqual({
      kind: "plain",
      status: 200,
      body: { id: 1 },
      headers: {},
    });
    expect(getResponseParts(null)).toEqual({
      kind: "plain",
      status: 204,
      body: null,
      headers: {},
    });
    expect(getResponseParts(undefined).status).toBe(204);
  });

  it("reads status tuples, with or without headers", () => {
    expect(getResponseParts([201, { id: 1 }])).toEqual({
      kind: "tuple",
      status: 201,
      body: { id: 1 },
      headers: {},
    });
    expect(getResponseParts([200, "x", { "x-a": "1" }])).toEqual({
      kind: "tuple",
      status: 200,
      body: "x",
      headers: { "x-a": "1" },
    });
    // Core rejects this tuple as INVALID_RESPONSE; its headers read as none.
    expect(getResponseParts([200, "x", { "x-n": 1 }]).headers).toEqual({});
  });

  it("unwraps an envelope only when core would", () => {
    expect(
      getResponseParts({ status: 202, body: "ok", headers: { a: "b" } }),
    ).toEqual({
      kind: "object",
      status: 202,
      body: "ok",
      headers: { a: "b" },
    });
    // Non-string headers: core delivers the whole object as the body.
    const notEnvelope = { status: 201, body: { id: 1 }, headers: { n: 1 } };
    expect(getResponseParts(notEnvelope)).toEqual({
      kind: "plain",
      status: 200,
      body: notEnvelope,
      headers: {},
    });
  });

  it("returns a copy of the carried headers", () => {
    const headers = { "x-a": "1" };
    const parts = getResponseParts([200, "x", headers]);
    parts.headers["x-b"] = "2";
    expect(headers).toEqual({ "x-a": "1" });
  });

  it("agrees with what handle() answers", async () => {
    const results: unknown[] = [
      { id: 1 },
      null,
      [201, { id: 1 }],
      [202, "text", { "x-a": "1" }],
      { status: 203, body: { ok: true } },
      { status: 201, body: { id: 1 }, headers: { "x-n": 1 } },
    ];
    for (const [index, result] of results.entries()) {
      const mock = schmock();
      mock(`GET /r${index}`, () => result);
      const response = await mock.handle("GET", `/r${index}`);
      const parts = getResponseParts(result);
      expect(response.status).toBe(parts.status);
      expect(response.body).toEqual(parts.body ?? undefined);
    }
  });
});

describe("replaceResponseBody", () => {
  it("keeps the shape of the response it rewrites", () => {
    expect(replaceResponseBody([201, "a"], "b")).toEqual([201, "b"]);
    expect(replaceResponseBody([201, "a", { h: "1" }], "b")).toEqual([
      201,
      "b",
      { h: "1" },
    ]);
    expect(replaceResponseBody({ status: 202, body: "a" }, "b")).toEqual({
      status: 202,
      body: "b",
    });
    expect(
      replaceResponseBody({ status: 202, body: "a", headers: { h: "1" } }, "b"),
    ).toEqual({ status: 202, body: "b", headers: { h: "1" } });
    expect(replaceResponseBody({ plain: true }, "b")).toBe("b");
  });

  it("never mutates the original", () => {
    const tuple: [number, unknown] = [200, "a"];
    const envelope = { status: 200, body: "a" };
    replaceResponseBody(tuple, "b");
    replaceResponseBody(envelope, "b");
    expect(tuple).toEqual([200, "a"]);
    expect(envelope).toEqual({ status: 200, body: "a" });
  });

  it("round-trips through getResponseParts", () => {
    const response = [201, { items: [1, 2] }, { "x-total": "2" }];
    const parts = getResponseParts(replaceResponseBody(response, [3]));
    expect(parts).toMatchObject({ status: 201, body: [3] });
    expect(parts.headers).toEqual({ "x-total": "2" });
  });
});

// ── R7: admission and abort (adapter entry) ────────────────────────────────

describe("acquireRequestAdmission", () => {
  it("admits a request against the routes present at arrival", async () => {
    const mock = schmock();
    mock("GET /users", [{ id: 1 }]);
    const admission = acquireRequestAdmission(mock);
    if (!admission) throw new Error("expected an admission");

    mock.reset();
    const response = await admission.handle("GET", "/users");
    admission.release();

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 1 }]);
    expect((await mock.handle("GET", "/users")).status).toBe(404);
  });

  it("returns undefined for a value that is not a schmock() instance", () => {
    // Copies the methods but not the non-enumerable admission factory.
    const stub: Schmock.CallableMockInstance = Object.assign(
      () => stub,
      schmock(),
    );
    expect(acquireRequestAdmission(stub)).toBeUndefined();
  });

  it("throws a SchmockError when the factory returns something else", () => {
    const impostor: Schmock.CallableMockInstance = Object.assign(
      () => impostor,
      schmock(),
    );
    Object.defineProperty(
      impostor,
      Symbol.for("@schmock/core.request-admission"),
      { value: () => ({ handle: "not a function" }) },
    );
    expect(() => acquireRequestAdmission(impostor)).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST_ADMISSION" }),
    );
    expect(() => acquireRequestAdmission(impostor)).toThrow(SchmockError);
  });
});

describe("awaitWithAbort / abortReason", () => {
  it("resolves with the value when the signal never aborts", async () => {
    const controller = new AbortController();
    await expect(
      awaitWithAbort(Promise.resolve(7), controller.signal),
    ).resolves.toBe(7);
    await expect(awaitWithAbort(8)).resolves.toBe(8);
  });

  it("rejects with the abort reason as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const pending = awaitWithAbort(new Promise(() => {}), controller.signal);
    const reason = new Error("gone");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("returns a rejected promise, not a throw, for a pre-aborted signal", async () => {
    const controller = new AbortController();
    const reason = new Error("already gone");
    controller.abort(reason);
    let result: Promise<unknown> | undefined;
    expect(() => {
      result = awaitWithAbort(1, controller.signal);
    }).not.toThrow();
    await expect(result).rejects.toBe(reason);
  });

  it("reports the signal's reason, including the default AbortError", () => {
    const withReason = new AbortController();
    withReason.abort("custom");
    expect(abortReason(withReason.signal)).toBe("custom");

    const withoutReason = new AbortController();
    withoutReason.abort();
    expect(abortReason(withoutReason.signal)).toMatchObject({
      name: "AbortError",
    });
  });
});

// ── R5: createFetchInterceptor on the adapter entry ────────────────────────

describe("createFetchInterceptor", () => {
  it("is the same function on the root (deprecated) and adapter entries", () => {
    expect(createFetchInterceptor).toBe(adapterFetchInterceptor);
  });

  it("routes fetches through an admitted handle from the adapter entry", async () => {
    const mock = schmock();
    mock("GET /api/ping", { pong: true });
    const originalFetch = globalThis.fetch;
    const admitted: string[] = [];
    const lease = adapterFetchInterceptor(
      (method, path, options) => mock.handle(method, path, options),
      { baseUrl: "/api/", passthrough: false },
      () => {
        const admission = acquireRequestAdmission(mock);
        if (!admission) throw new Error("expected an admission");
        admitted.push("admitted");
        return admission;
      },
    );
    try {
      const response = await fetch("http://localhost/api/ping");
      expect(await response.json()).toEqual({ pong: true });
      expect(admitted).toEqual(["admitted"]);
    } finally {
      lease.restore();
    }
    expect(globalThis.fetch).toBe(originalFetch);
  });
});

// ── #108: intercept() errorFormatter receives the request ──────────────────

describe("intercept errorFormatter", () => {
  it("receives the routed request after beforeRequest", async () => {
    const mock = schmock();
    mock("GET /boom", () => {
      throw new Error("route failed");
    });
    const seen: Array<{ message: string; request: Schmock.AdapterRequest }> =
      [];
    const handle = mock.intercept({
      passthrough: false,
      beforeRequest: (request) => ({
        ...request,
        headers: { ...request.headers, "x-rewritten": "yes" },
      }),
      errorFormatter: (error, request) => {
        seen.push({ message: error.message, request });
        return { failed: request.path };
      },
    });
    try {
      const response = await fetch("http://localhost/boom");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ failed: "/boom" });
    } finally {
      handle.restore();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe("route failed");
    expect(seen[0]?.request).toMatchObject({
      method: "GET",
      path: "/boom",
      headers: { "x-rewritten": "yes" },
    });
  });

  it("receives the incoming request when beforeRequest itself throws", async () => {
    const mock = schmock();
    mock("POST /items", [201, { ok: true }]);
    const requests: Schmock.AdapterRequest[] = [];
    const handle = mock.intercept({
      passthrough: false,
      beforeRequest: () => {
        throw new Error("hook failed");
      },
      errorFormatter: (_error, request) => {
        requests.push(request);
        return { hook: "failed" };
      },
    });
    try {
      const response = await fetch("http://localhost/items?page=2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ hook: "failed" });
    } finally {
      handle.restore();
    }
    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/items",
        body: { name: "x" },
        query: { page: "2" },
      }),
    ]);
  });
});

describe("collectBody header lookup", () => {
  it("reads content-type and content-length case-insensitively", async () => {
    const stream = new PassThrough();
    stream.end(Buffer.from('{"a":1}'));
    await expect(
      collectBody(stream, {
        "Content-Type": "application/json",
        "Content-Length": "7",
      }),
    ).resolves.toEqual({ a: 1 });

    const oversized = new PassThrough();
    await expect(
      collectBody(oversized, { "Content-Length": "999" }, 10),
    ).rejects.toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
  });
});

// ── R6: serveNodeRequest ───────────────────────────────────────────────────

describe("serveNodeRequest", () => {
  async function serve(
    mock: Schmock.CallableMockInstance,
    options: Partial<Parameters<typeof serveNodeRequest>[2]> = {},
  ): Promise<number> {
    const server = createServer((req, res) => {
      void serveNodeRequest(req, res, {
        handle: mock.handle,
        maxBodySize: 1024,
        ...options,
      });
    });
    return listenOn(server);
  }

  it("serves a request through the mock", async () => {
    const mock = schmock();
    mock("POST /echo", ({ body, query }) => ({ body, query }));
    const port = await serve(mock);

    const response = await fetch(`http://127.0.0.1:${port}/echo?a=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      body: { n: 1 },
      query: { a: "1" },
    });
  });

  it("answers an unsupported method with 405 and Allow", async () => {
    const port = await serve(schmock());
    const response = await sendRaw(port, rawRequest("PROPFIND /x"));
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe(
      "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
    );
    expect(bodyCode(response)).toBe("METHOD_NOT_ALLOWED");
  });

  it("answers a missing or malformed Host header with 400", async () => {
    const port = await serve(schmock());
    const missing = await sendRaw(port, "GET /x HTTP/1.0\r\n\r\n");
    const malformed = await sendRaw(port, rawRequest("GET /x", "bad host["));
    expect([missing.status, malformed.status]).toEqual([400, 400]);
    expect([bodyCode(missing), bodyCode(malformed)]).toEqual([
      "BAD_REQUEST",
      "BAD_REQUEST",
    ]);
  });

  it("answers a body over maxBodySize with 413 and closes the connection", async () => {
    const mock = schmock();
    mock("POST /upload", () => "stored");
    const port = await serve(mock, { maxBodySize: 8 });
    const response = await sendRaw(
      port,
      "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
        "Content-Type: text/plain\r\nContent-Length: 20\r\n\r\n" +
        "01234567890123456789",
    );
    expect(response.status).toBe(413);
    expect(response.headers.connection).toBe("close");
    expect(bodyCode(response)).toBe("PAYLOAD_TOO_LARGE");
  });

  it("answers a handler failure with 500 SERVER_ERROR and never rejects", async () => {
    let served: Promise<void> | undefined;
    const server = createServer((req, res) => {
      served = serveNodeRequest(req, res, {
        handle: () => Promise.reject(new Error("handler exploded")),
        maxBodySize: 1024,
      });
    });
    const port = await listenOn(server);
    const response = await sendRaw(port, rawRequest("GET /x"));
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: "handler exploded",
      code: "SERVER_ERROR",
    });
    await expect(served).resolves.toBeUndefined();
  });

  it("writes extraHeaders on success and error answers, telling them apart", async () => {
    const mock = schmock();
    mock("GET /users", []);
    const seen: Array<{ isError: boolean; path: string | undefined }> = [];
    const port = await serve(mock, {
      extraHeaders: (context) => {
        seen.push({ isError: context.isError, path: context.path });
        return { "x-served-by": "schmock" };
      },
    });

    const ok = await sendRaw(port, rawRequest("GET /users"));
    const rejected = await sendRaw(port, rawRequest("PROPFIND /users"));

    expect(ok.headers["x-served-by"]).toBe("schmock");
    expect(rejected.headers["x-served-by"]).toBe("schmock");
    expect(seen).toEqual([
      { isError: false, path: "/users" },
      { isError: true, path: "/users" },
    ]);
  });

  it("lets classifyError choose the answer for an error", async () => {
    class TeapotError extends Error {}
    const port = await serve(schmock(), {
      handle: () => Promise.reject(new TeapotError("short and stout")),
      classifyError: (error) =>
        error instanceof TeapotError
          ? { status: 418, code: "TEAPOT", message: error.message }
          : undefined,
    });
    const teapot = await sendRaw(port, rawRequest("GET /tea"));
    const fallback = await sendRaw(port, rawRequest("PROPFIND /tea"));
    expect(teapot.status).toBe(418);
    expect(JSON.parse(teapot.body)).toEqual({
      error: "short and stout",
      code: "TEAPOT",
    });
    expect(fallback.status).toBe(405);
  });
});

// ── R8: path prefixes ──────────────────────────────────────────────────────

describe("parsePathPrefix / matchPathPrefix", () => {
  it("parses path and origin forms with one trailing-slash rule", () => {
    expect(parsePathPrefix("/api")).toEqual({ origin: null, path: "/api" });
    expect(parsePathPrefix("/api/")).toEqual({ origin: null, path: "/api" });
    expect(parsePathPrefix("api")).toEqual({ origin: null, path: "/api" });
    expect(parsePathPrefix("/")).toEqual({ origin: null, path: "" });
    expect(parsePathPrefix("")).toEqual({ origin: null, path: "" });
    expect(parsePathPrefix("https://x.com/api/v1/")).toEqual({
      origin: "https://x.com",
      path: "/api/v1",
    });
    expect(parsePathPrefix("https://x.com")).toEqual({
      origin: "https://x.com",
      path: "",
    });
  });

  it("canonicalizes the prefix like request paths", () => {
    expect(parsePathPrefix("/café")).toEqual({
      origin: null,
      path: "/caf%C3%A9",
    });
  });

  it("matches on a segment boundary only", () => {
    const prefix = parsePathPrefix("/api/");
    expect(matchPathPrefix(prefix, "/api")).toBe(true);
    expect(matchPathPrefix(prefix, "/api/users")).toBe(true);
    expect(matchPathPrefix(prefix, "/apiv2")).toBe(false);
    expect(matchPathPrefix(prefix, "/")).toBe(false);
    expect(matchPathPrefix(parsePathPrefix("/"), "/anything")).toBe(true);
  });

  it("matches a raw and an encoded spelling of the same path", () => {
    const prefix = parsePathPrefix("/café");
    expect(matchPathPrefix(prefix, "/café/menu")).toBe(true);
    expect(matchPathPrefix(prefix, "/caf%C3%A9/menu")).toBe(true);
  });
});

// ── R10: transport response shaping ────────────────────────────────────────

describe("withDefaultContentType", () => {
  it("infers a content type from the body when none is declared", () => {
    const binary = withDefaultContentType({
      status: 200,
      body: new Uint8Array([1]),
      headers: {},
    });
    const json = withDefaultContentType({
      status: 200,
      body: { a: 1 },
      headers: {},
    });
    const nullBody = withDefaultContentType({
      status: 200,
      body: null,
      headers: {},
    });
    const text = withDefaultContentType({
      status: 200,
      body: "hi",
      headers: {},
    });
    const empty = withDefaultContentType({
      status: 204,
      body: undefined,
      headers: {},
    });

    expect(binary.headers).toEqual({
      "content-type": "application/octet-stream",
    });
    expect(json.headers).toEqual({ "content-type": "application/json" });
    expect(nullBody.headers).toEqual({ "content-type": "application/json" });
    expect(text.headers).toEqual({});
    expect(empty.headers).toEqual({});
  });

  it("keeps a declared content type in any case and never mutates", () => {
    const response = {
      status: 200,
      body: { a: 1 },
      headers: { "Content-Type": "application/vnd.x+json" },
    };
    const result = withDefaultContentType(response);
    expect(result.headers).toEqual({
      "Content-Type": "application/vnd.x+json",
    });
    expect(result.headers).not.toBe(response.headers);
  });
});

describe("buildFormattedErrorResponse", () => {
  const error = new Error("boom");

  it("formats once and keeps the inherited headers except content type", () => {
    const formatter = vi.fn((failure: Error) => ({ message: failure.message }));
    const response = buildFormattedErrorResponse({
      formatter,
      error,
      inheritedHeaders: { "Retry-After": "5", "Content-Type": "text/plain" },
      method: "GET",
    });
    expect(formatter).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      status: 500,
      body: { message: "boom" },
      headers: { "Retry-After": "5", "content-type": "application/json" },
    });
  });

  it("keeps the formatted body when the inherited headers cannot be sent", () => {
    const formatter = vi.fn(() => ({ formatted: true }));
    const response = buildFormattedErrorResponse({
      formatter,
      error,
      inheritedHeaders: { "x-bad": "line\nbreak" },
      method: "GET",
    });
    expect(formatter).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      status: 500,
      body: { formatted: true },
      headers: { "content-type": "application/json" },
    });
  });

  it("falls back to the minimal body when the formatter throws or its result cannot be sent", () => {
    const minimal = {
      status: 500,
      body: { error: "Internal Server Error", code: "INTERNAL_ERROR" },
      headers: { "content-type": "application/json" },
    };
    const throwing = buildFormattedErrorResponse({
      formatter: () => {
        throw new Error("formatter failed");
      },
      error,
      method: "GET",
    });
    const unserializable = buildFormattedErrorResponse({
      formatter: () => ({ cause: new Error("not JSON") }),
      error,
      method: "GET",
    });
    expect(throwing).toEqual(minimal);
    expect(unserializable).toEqual(minimal);
  });

  it("drops the body for HEAD", () => {
    const response = buildFormattedErrorResponse({
      formatter: () => ({ formatted: true }),
      error,
      method: "HEAD",
    });
    expect(response.status).toBe(500);
    expect(response.body).toBeUndefined();
  });
});

// ── R15: header helpers ────────────────────────────────────────────────────

describe("header helpers", () => {
  it("lists the credential headers in lowercase", () => {
    expect([...SENSITIVE_HEADER_NAMES]).toEqual([
      "authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
      "x-auth-token",
      "x-schmock-admin-token",
    ]);
  });

  it("redacts sensitive values copy-on-write", () => {
    const headers = { Authorization: "Bearer t", accept: "*/*" };
    const redacted = redactHeaders(headers);
    expect(redacted).toEqual({ Authorization: "[redacted]", accept: "*/*" });
    expect(headers.Authorization).toBe("Bearer t");

    const harmless = { accept: "*/*" };
    expect(redactHeaders(harmless)).toBe(harmless);
  });

  it("looks a header up case-insensitively", () => {
    const headers = { "Content-Type": "text/plain" };
    expect(getHeader(headers, "content-type")).toBe("text/plain");
    expect(getHeader(headers, "CONTENT-TYPE")).toBe("text/plain");
    expect(getHeader(headers, "accept")).toBeUndefined();
    expect(getHeader(undefined, "accept")).toBeUndefined();
  });

  it("redacts credentials in debug logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mock = schmock({ debug: true });
    mock("GET /secure", "ok");
    await mock.handle("GET", "/secure", {
      headers: { authorization: "Bearer secret" },
    });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("Bearer secret");
    expect(logged).toContain("[redacted]");
  });
});

// ── Error classes ──────────────────────────────────────────────────────────

describe("error classes", () => {
  it("toHttpMethod throws an InvalidHttpMethodError", () => {
    let thrown: unknown;
    try {
      toHttpMethod("propfind");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidHttpMethodError);
    expect(thrown).toBeInstanceOf(SchmockError);
    expect(thrown).toMatchObject({
      code: "INVALID_HTTP_METHOD",
      message: 'Invalid HTTP method: "propfind"',
      context: { method: "propfind" },
    });
  });

  it("attributes an invalid plugin result to the plugin once", async () => {
    const mock = schmock();
    // Untyped on purpose: plain JavaScript can return any shape.
    const broken = { name: "broken", process: () => ({ notAResult: true }) };
    Reflect.apply(mock.pipe, mock, [broken]);
    mock("GET /x", "x");
    const response = await mock.handle("GET", "/x");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: `Plugin "broken" failed: didn't return valid result`,
      code: "PLUGIN_ERROR",
    });
  });
});
