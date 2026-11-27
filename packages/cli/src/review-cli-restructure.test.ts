import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CallableMockInstance, RequestRecord } from "@schmock/core";
import { SchmockError, SENSITIVE_HEADER_NAMES, schmock } from "@schmock/core";
import { afterEach, describe, expect, it } from "vitest";
import { answerAdminRequest } from "./admin";
import { isLoopbackHost, parseCliArgs } from "./args";
import * as facade from "./cli";
import { type CliServer, createCliServer } from "./cli";
import * as publicApi from "./index";
import { handleCliRequest } from "./request";
import { loadSeedFile } from "./seed-manifest";
import { createCliServer as createCliServerImpl } from "./server";

const PETSTORE_SPEC = resolve(
  __dirname,
  "../../openapi/src/__fixtures__/petstore-openapi3.json",
);

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function parseRawResponse(raw: string): RawResponse | undefined {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) return undefined;
  const [statusLine = "", ...headerLines] = raw
    .slice(0, headerEnd)
    .split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).trim().toLowerCase()] = line
      .slice(colon + 1)
      .trim();
  }
  const body = raw.slice(headerEnd + 4);
  const declared = headers["content-length"];
  if (declared !== undefined && Buffer.byteLength(body) < Number(declared)) {
    return undefined;
  }
  return { status: Number(statusLine.split(" ")[1]), headers, body };
}

/**
 * Send one raw HTTP/1.1 request and resolve with the first complete response,
 * without waiting for the socket to close, so a kept-alive connection can
 * still be inspected.
 */
function sendRaw(port: number, request: string): Promise<RawResponse> {
  return new Promise((done, fail) => {
    let received = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error(`No complete response; received: ${received}`));
    }, 5_000);
    const finish = (): void => {
      const parsed = parseRawResponse(received);
      if (parsed === undefined) return;
      clearTimeout(timer);
      socket.destroy();
      done(parsed);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      finish();
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const parsed = parseRawResponse(`${received}`);
      if (parsed) done(parsed);
      else fail(new Error(`Socket closed early; received: ${received}`));
    });
    socket.on("error", fail);
  });
}

describe("CLI requests served through core's serveNodeRequest", () => {
  let server: CliServer | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("answers a malformed Host header with core's 400 message", async () => {
    server = await createCliServer({ spec: PETSTORE_SPEC, port: 0 });
    const response = await sendRaw(
      server.port,
      "GET /pets HTTP/1.1\r\nHost: :\r\nConnection: close\r\n\r\n",
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: "Malformed Host header",
      code: "BAD_REQUEST",
    });
  });

  it("reads a target starting with // as a path, never as a host", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "schmock-cli-restructure-"));
    const specPath = join(tempDir, "root.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "root", version: "1.0.0" },
        paths: {
          "/": {
            get: {
              responses: {
                "200": {
                  description: "root",
                  content: {
                    "application/json": {
                      schema: { type: "object" },
                      example: { root: true },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    server = await createCliServer({ spec: specPath, port: 0 });

    // Resolved against a base URL, `//users` used to become host "users" with
    // path "/", and so reached the `GET /` route.
    const response = await sendRaw(
      server.port,
      "GET //users HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    expect(response.status).toBe(404);
    const root = await sendRaw(
      server.port,
      "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    expect(root.status).toBe(200);
  });

  it("closes a kept-alive connection after a malformed JSON body", async () => {
    server = await createCliServer({ spec: PETSTORE_SPEC, port: 0 });
    const body = '{"broken":';
    const response = await sendRaw(
      server.port,
      "POST /pets HTTP/1.1\r\nHost: localhost\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: keep-alive\r\n\r\n${body}`,
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: "MALFORMED_JSON" });
    expect(response.headers.connection).toBe("close");
  });

  it("refuses an unauthorized admin request before reading its malformed body", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
      cors: true,
    });
    const body = '{"broken":';
    const response = await sendRaw(
      server.port,
      "POST /schmock-admin/reset HTTP/1.1\r\nHost: localhost\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`,
    );
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ code: "UNAUTHORIZED" });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses an unauthorized admin request declaring an oversized body with 401, not 413", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
    });
    const response = await sendRaw(
      server.port,
      "POST /schmock-admin/reset HTTP/1.1\r\nHost: localhost\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 20000000\r\n" +
        "Connection: close\r\n\r\n",
    );
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses an unauthorized admin request at once while its body stalls", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
      shutdownGraceMs: 100,
    });
    const started = Date.now();
    // 7 of the 100 declared bytes, and then nothing: an answer that waited
    // for the body would come only when the client or the server gave up.
    const response = await sendRaw(
      server.port,
      "GET /schmock-admin/state HTTP/1.1\r\nHost: localhost\r\n" +
        "Content-Type: text/plain\r\n" +
        "Content-Length: 100\r\n" +
        "Connection: close\r\n\r\npartial",
    );
    expect(response.status).toBe(401);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("runs an authorized admin action without decoding a body it never uses", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
    });
    const body = "not gzip at all";
    const response = await sendRaw(
      server.port,
      "POST /schmock-admin/reset HTTP/1.1\r\nHost: localhost\r\n" +
        `Authorization: Bearer ${server.adminToken}\r\n` +
        "Content-Type: application/json\r\n" +
        "Content-Encoding: gzip\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`,
    );
    expect(response.status).toBe(204);
  });

  it("declares a Content-Length on admin answers", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
    });
    const response = await sendRaw(
      server.port,
      "GET /schmock-admin/routes HTTP/1.1\r\nHost: localhost\r\n" +
        `Authorization: Bearer ${server.adminToken}\r\n` +
        "Connection: close\r\n\r\n",
    );
    expect(response.status).toBe(200);
    expect(response.headers["transfer-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).toBe(
      String(Buffer.byteLength(response.body)),
    );
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("keeps 405 with Allow and no CORS for an unsupported verb on an admin path", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
      cors: true,
    });
    const response = await sendRaw(
      server.port,
      "PROPFIND /schmock-admin/state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    expect(response.status).toBe(405);
    expect(response.headers.allow).toContain("GET");
    expect(JSON.parse(response.body)).toMatchObject({
      code: "METHOD_NOT_ALLOWED",
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("keeps CORS on a 405 for a mock path", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
      cors: true,
    });
    const response = await sendRaw(
      server.port,
      "PROPFIND /pets HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    expect(response.status).toBe(405);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });

  it("keeps the preflight answer a bare 204 with CORS headers", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      cors: true,
    });
    const response = await sendRaw(
      server.port,
      "OPTIONS /pets HTTP/1.1\r\nHost: localhost\r\n" +
        "Origin: http://app.test\r\n" +
        "Access-Control-Request-Method: POST\r\n" +
        "Access-Control-Request-Headers: x-my-token\r\n" +
        "Connection: close\r\n\r\n",
    );
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["access-control-allow-headers"]).toBe("x-my-token");
    expect(response.headers["content-type"]).toBeUndefined();
    expect(response.body).toBe("");
  });

  it.each([["x-a;b"], ["x-a, ,b"]])(
    "answers a preflight requesting headers %j with the default list",
    async (requested) => {
      server = await createCliServer({
        spec: PETSTORE_SPEC,
        port: 0,
        cors: true,
      });
      const response = await sendRaw(
        server.port,
        "OPTIONS /pets HTTP/1.1\r\nHost: localhost\r\n" +
          "Origin: http://app.test\r\n" +
          "Access-Control-Request-Method: POST\r\n" +
          `Access-Control-Request-Headers: ${requested}\r\n` +
          "Connection: close\r\n\r\n",
      );
      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-allow-headers"]).toBe(
        "Content-Type, Authorization",
      );
    },
  );

  it("answers a preflight without reading its body", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      cors: true,
    });
    const body = '{"broken":';
    const response = await sendRaw(
      server.port,
      "OPTIONS /pets HTTP/1.1\r\nHost: localhost\r\n" +
        "Origin: http://app.test\r\n" +
        "Access-Control-Request-Method: POST\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`,
    );
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });

  it("keeps CORS on a 413 for a mock path and closes the connection", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      cors: true,
    });
    const response = await sendRaw(
      server.port,
      "POST /pets HTTP/1.1\r\nHost: localhost\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 10485761\r\n" +
        "Connection: keep-alive\r\n\r\n",
    );
    expect(response.status).toBe(413);
    expect(response.headers.connection).toBe("close");
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("the handler behind the CLI server", () => {
  let httpServer: Server | undefined;

  afterEach(async () => {
    const closing = httpServer;
    httpServer = undefined;
    if (closing) await new Promise<void>((done) => closing.close(() => done()));
  });

  function serve(mock: CallableMockInstance): Promise<string> {
    const server = createServer((req, res) => {
      void handleCliRequest(req, res, {
        mock,
        admin: true,
        cors: false,
        adminToken: "admin-secret",
      });
    });
    httpServer = server;
    return new Promise((done) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port =
          address !== null && typeof address === "object" ? address.port : 0;
        done(`http://127.0.0.1:${port}`);
      });
    });
  }

  it("answers 500 for mock routes when the admission is broken, and keeps the admin API up", async () => {
    const real = schmock({ state: {} });
    real("GET /hello", { ok: true });
    // Inherits every method from the real mock but overrides its admission
    // factory with one that returns something that is not an admission.
    const broken: CallableMockInstance = Object.create(real);
    Object.defineProperty(
      broken,
      Symbol.for("@schmock/core.request-admission"),
      { value: () => ({ handle: "not a function" }) },
    );
    const base = await serve(broken);

    const hello = await fetch(`${base}/hello`);
    expect(hello.status).toBe(500);
    expect(await hello.json()).toEqual({
      error: "Schmock returned an invalid request admission",
      code: "SERVER_ERROR",
    });

    const routes = await fetch(`${base}/schmock-admin/routes`, {
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(routes.status).toBe(200);
    expect(await routes.json()).toEqual(real.getRoutes());
  });

  it("reads the body before answering a broken admission's 500", async () => {
    const real = schmock({ state: {} });
    real("POST /hello", { ok: true });
    const broken: CallableMockInstance = Object.create(real);
    Object.defineProperty(
      broken,
      Symbol.for("@schmock/core.request-admission"),
      { value: () => ({ handle: "not a function" }) },
    );
    const base = await serve(broken);

    // The admission failure surfaces only when the mock is called, which is
    // after the body is collected, so a malformed body is still a 400.
    const malformed = await fetch(`${base}/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"broken":',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "MALFORMED_JSON" });

    const wellFormed = await fetch(`${base}/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"fine":true}',
    });
    expect(wellFormed.status).toBe(500);
    expect(await wellFormed.json()).toMatchObject({ code: "SERVER_ERROR" });
  });

  it("serves a mock route through its admission", async () => {
    const mock = schmock({ state: {} });
    mock("GET /hello", { ok: true });
    const base = await serve(mock);

    const hello = await fetch(`${base}/hello`);
    expect(hello.status).toBe(200);
    expect(await hello.json()).toEqual({ ok: true });
  });
});

describe("admin history redaction", () => {
  let server: CliServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("masks every header in core's SENSITIVE_HEADER_NAMES", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
    });
    const sensitive = [...SENSITIVE_HEADER_NAMES];
    expect(sensitive.length).toBeGreaterThan(0);
    await sendRaw(
      server.port,
      "GET /pets HTTP/1.1\r\nHost: localhost\r\n" +
        sensitive.map((name) => `${name}: leaked-${name}\r\n`).join("") +
        "Accept: application/json\r\nConnection: close\r\n\r\n",
    );

    const history = await fetch(
      `http://127.0.0.1:${server.port}/schmock-admin/history`,
      { headers: { authorization: `Bearer ${server.adminToken}` } },
    );
    const text = await history.text();
    expect(text).not.toContain("leaked-");
    const records: Array<{ headers: Record<string, string> }> =
      JSON.parse(text);
    const headers = records[0]?.headers ?? {};
    // Node delivers a request `set-cookie` as an array, which core does not
    // record at all; every other name arrives as a string and is masked.
    for (const name of sensitive.filter((header) => header !== "set-cookie")) {
      expect(headers[name], name).toBe("[redacted]");
    }
    expect(headers.accept).toBe("application/json");
  });

  // Review 2026-10-23, cli-4: JSON.stringify showed a binary upload as `{}`.
  it("describes a binary upload by its size instead of showing it as {}", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
    });
    const url = `http://127.0.0.1:${server.port}/pets`;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(1000),
    }).then((response) => response.arrayBuffer());
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.arrayBuffer());

    const history = await fetch(
      `http://127.0.0.1:${server.port}/schmock-admin/history`,
      { headers: { authorization: `Bearer ${server.adminToken}` } },
    );
    const records: Array<{ body: unknown }> = await history.json();

    // The JSON `{}` still reads as `{}`; only the binary body is described.
    expect(records.map((record) => record.body)).toEqual([
      { kind: "binary", byteLength: 1000 },
      {},
    ]);
  });

  it("describes typed-array and binary response bodies the same way", () => {
    const record: RequestRecord = {
      method: "POST",
      path: "/upload",
      params: {},
      query: {},
      headers: {},
      body: new Uint8Array([1, 2, 3]),
      timestamp: 0,
      response: { status: 200, body: new ArrayBuffer(16) },
    };
    const mock = {
      history: () => [record],
    } as unknown as CallableMockInstance;

    const response = answerAdminRequest({
      req: { headers: { authorization: "Bearer t0k" } },
      method: "GET",
      path: "/schmock-admin/history",
      mock,
      adminToken: "t0k",
    });

    expect(JSON.parse(String(response.body))).toEqual([
      {
        ...record,
        body: { kind: "binary", byteLength: 3 },
        response: { status: 200, body: { kind: "binary", byteLength: 16 } },
      },
    ]);
  });
  it("keeps a query key and a header named __proto__ in the projection", async () => {
    const mock = schmock();
    mock("GET /pets", () => []);
    await mock.handle("GET", "/pets", {
      query: Object.fromEntries(new URLSearchParams("__proto__=value&limit=2")),
      headers: Object.fromEntries([
        ["__proto__", "h"],
        ["x-a", "1"],
      ]),
    });

    const response = answerAdminRequest({
      req: { headers: { authorization: "Bearer t0k" } },
      method: "GET",
      path: "/schmock-admin/history",
      mock,
      adminToken: "t0k",
    });

    const records: Array<{ query: object; headers: object }> = JSON.parse(
      String(response.body),
    );
    expect(Object.entries(records[0]?.query ?? {})).toEqual([
      ["__proto__", "value"],
      ["limit", "2"],
    ]);
    expect(Object.entries(records[0]?.headers ?? {})).toEqual([
      ["__proto__", "h"],
      ["x-a", "1"],
    ]);
  });
});

describe("CLI errors carry SchmockError codes", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function captureError(action: () => unknown): unknown {
    try {
      action();
    } catch (error) {
      return error;
    }
    throw new Error("Expected the action to throw");
  }

  it.each([
    {
      args: ["spec.json", "--port", "http"],
      message:
        'Invalid port "http". Port must be an integer between 0 and 65535.',
      context: { flag: "--port", value: "http" },
    },
    {
      args: ["spec.json", "--admin-history-limit=-1"],
      message:
        'Invalid --admin-history-limit "-1". It must be a non-negative integer.',
      context: { flag: "--admin-history-limit", value: "-1" },
    },
    {
      args: ["spec.json", "--seed-random", "1.5"],
      message: 'Invalid --seed-random "1.5". It must be a finite integer.',
      context: { flag: "--seed-random", value: "1.5" },
    },
    {
      args: ["spec.json", "--hostname="],
      message:
        "Invalid --hostname. The hostname must be a non-empty host, address or interface.",
      context: { flag: "--hostname", value: "" },
    },
    {
      args: ["spec.json", "--admin", "--admin-token", "has space"],
      message:
        "Invalid --admin-token. The token must be non-empty visible ASCII with no whitespace.",
      context: { flag: "--admin-token" },
    },
    {
      args: ["spec.json", "--admin-token", "abc"],
      message: "--admin-token requires --admin.",
      context: { flag: "--admin-token" },
    },
    {
      args: ["a.json", "b.json"],
      message:
        "Unexpected extra arguments: b.json. Pass exactly one spec path.",
      context: { flag: "<spec>" },
    },
    {
      args: ["spec.json", "--seed="],
      message: "Invalid --seed. The path must be non-empty.",
      context: { flag: "--seed", value: "" },
    },
    {
      args: ["spec.json", "--seed", "  "],
      message: "Invalid --seed. The path must be non-empty.",
      context: { flag: "--seed", value: "  " },
    },
    {
      args: ["--spec=", "spec.json"],
      message: "Invalid --spec. The path must be non-empty.",
      context: { flag: "--spec", value: "" },
    },
    {
      args: [""],
      message: "Invalid --spec. The path must be non-empty.",
      context: { flag: "--spec", value: "" },
    },
    {
      args: ["  ", "--port", "3000"],
      message: "Invalid --spec. The path must be non-empty.",
      context: { flag: "--spec", value: "  " },
    },
  ])(
    "parseCliArgs($args) throws INVALID_CONFIG",
    ({ args, message, context }) => {
      const error = captureError(() => parseCliArgs(args));
      expect(error).toBeInstanceOf(SchmockError);
      expect(error).toMatchObject({ code: "INVALID_CONFIG", message, context });
    },
  );

  it("createCliServer refuses a blank hostname with INVALID_CONFIG", async () => {
    await expect(
      createCliServer({ spec: PETSTORE_SPEC, port: 0, hostname: "  " }),
    ).rejects.toMatchObject({
      name: "SchmockError",
      code: "INVALID_CONFIG",
      message:
        "Invalid hostname. The hostname must be a non-empty host, address or interface.",
    });
  });

  it.each([[""], ["  "]])(
    "createCliServer refuses the blank seed path %j with INVALID_CONFIG",
    async (seed) => {
      await expect(
        createCliServer({ spec: PETSTORE_SPEC, port: 0, seed }),
      ).rejects.toMatchObject({
        name: "SchmockError",
        code: "INVALID_CONFIG",
        message: "Invalid seed. The seed manifest path must be non-empty.",
        context: { option: "seed", value: seed },
      });
    },
  );

  // Review 2026-10-23, cli-7: setTimeout fires after 1 ms for each of these,
  // so the "grace window" destroyed in-flight requests at once.
  it.each([
    [Number.POSITIVE_INFINITY],
    [2 ** 31],
    [3_000_000_000],
    [-1],
    [1.5],
    [Number.NaN],
  ])(
    "createCliServer refuses shutdownGraceMs %d with INVALID_CONFIG",
    async (shutdownGraceMs) => {
      await expect(
        createCliServer({ spec: PETSTORE_SPEC, port: 0, shutdownGraceMs }),
      ).rejects.toMatchObject({
        name: "SchmockError",
        code: "INVALID_CONFIG",
        message:
          "Invalid shutdownGraceMs. It must be an integer number of milliseconds from 0 to 2147483647.",
        context: { option: "shutdownGraceMs", value: shutdownGraceMs },
      });
    },
  );

  it.each([[0], [2_147_483_647]])(
    "createCliServer accepts shutdownGraceMs %d",
    async (shutdownGraceMs) => {
      const server = await createCliServer({
        spec: PETSTORE_SPEC,
        port: 0,
        shutdownGraceMs,
      });
      await server.close();
    },
  );

  // Review 2026-10-23, cli-6: the watcher read a URL as a local path.
  it.each([
    ["https://specs.example.com/api.json"],
    ["HTTP://specs.example.com/api.yaml"],
    // @schmock/openapi resolves these to an http(s) URL and reads them so.
    ["//specs.example.com/api.json"],
    ["\\\\specs.example.com\\api.json"],
    ["http:specs.example.com/api.json"],
  ])(
    "createCliServer refuses to watch the spec URL %s, before reading it",
    async (spec) => {
      await expect(
        createCliServer({ spec, port: 0, watch: true }),
      ).rejects.toMatchObject({
        name: "SchmockError",
        code: "INVALID_CONFIG",
        message:
          "Invalid watch. A spec read from a URL cannot be watched; watch a local copy instead.",
        context: { option: "watch", spec },
      });
    },
  );

  it("createCliServer refuses the blank seed path before reading the spec", async () => {
    // A spec that does not exist would fail first if it were read first.
    await expect(
      createCliServer({ spec: "missing-spec.json", port: 0, seed: "" }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("createCliServer refuses an unusable admin token without echoing it", async () => {
    const rejection = createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
      adminToken: "leaked token",
    });
    await expect(rejection).rejects.toBeInstanceOf(SchmockError);
    await expect(rejection).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      context: { option: "adminToken" },
    });
    await rejection.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain("leaked token");
    });
  });

  it.each([
    {
      manifest: '{"pets": 42}',
      message:
        'Seed entry "pets" must be an array, a file path, or { "count": <number> }',
      context: { option: "seed", resource: "pets" },
    },
    {
      manifest: '{"pets": "missing.json"}',
      message: 'Seed entry "pets" points to a missing file: missing.json',
      context: { option: "seed", resource: "pets" },
    },
    {
      manifest: '{"pets": "../outside.json"}',
      message:
        'Seed entry "pets" must stay inside the seed manifest directory: ../outside.json',
      context: { option: "seed", resource: "pets" },
    },
    {
      manifest: "[1, 2]",
      message: "Seed file must contain a JSON object, got: array",
      context: { option: "seed" },
    },
  ])(
    "loadSeedFile refuses $manifest with OPENAPI_INVALID_OPTION",
    ({ manifest, message, context }) => {
      tempDir = mkdtempSync(join(tmpdir(), "schmock-seed-codes-"));
      // The manifest lives one level down, so `../outside.json` exists but
      // escapes the manifest directory.
      const manifestDir = join(tempDir, "manifest");
      mkdirSync(manifestDir);
      writeFileSync(join(tempDir, "outside.json"), "[]");
      const seedPath = join(manifestDir, "seed.json");
      writeFileSync(seedPath, manifest);

      const error = captureError(() => loadSeedFile(seedPath));
      expect(error).toBeInstanceOf(SchmockError);
      expect(error).toMatchObject({
        code: "OPENAPI_INVALID_OPTION",
        message,
        context,
      });
    },
  );

  it("names the parser's complaint in an invalid-JSON manifest's message and gives it the seed code", () => {
    tempDir = mkdtempSync(join(tmpdir(), "schmock-seed-codes-"));
    const seedPath = join(tempDir, "seed.json");
    writeFileSync(seedPath, "{not json");
    // The wording is the runtime's own, so it is taken from the same parser.
    const reason = captureError(() => JSON.parse("{not json"));
    expect(reason).toBeInstanceOf(SyntaxError);
    const parserMessage = (reason as SyntaxError).message;

    const error = captureError(() => loadSeedFile(seedPath));
    expect(error).toBeInstanceOf(SchmockError);
    expect(error).toMatchObject({
      code: "OPENAPI_INVALID_OPTION",
      message: `Seed file "${seedPath}" contains invalid JSON: ${parserMessage}`,
      context: { option: "seed", reason: parserMessage },
    });
  });
});

describe("the cli.ts facade after the split", () => {
  it("re-exports the implementing modules' functions unchanged", () => {
    expect(facade.parseCliArgs).toBe(parseCliArgs);
    expect(facade.isLoopbackHost).toBe(isLoopbackHost);
    expect(facade.loadSeedFile).toBe(loadSeedFile);
    expect(facade.createCliServer).toBe(createCliServerImpl);
  });

  it("keeps the package's public runtime surface", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "createCliServer",
      "loadSeedFile",
      "parseCliArgs",
      "run",
    ]);
  });
});

describe("CLI multipart bodies other than multipart/form-data", () => {
  let server: CliServer | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  const objectSchema = {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  };

  /** A validating, admin-enabled CLI server whose POST /uploads takes both multipart types. */
  async function uploadServer(): Promise<CliServer> {
    tempDir = mkdtempSync(join(tmpdir(), "schmock-cli-multipart-"));
    const specPath = join(tempDir, "uploads.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "uploads", version: "1.0.0" },
        paths: {
          "/uploads": {
            post: {
              requestBody: {
                required: true,
                content: {
                  "multipart/related": { schema: objectSchema },
                  "multipart/form-data": { schema: objectSchema },
                },
              },
              responses: {
                "201": {
                  description: "stored",
                  content: {
                    "application/json": {
                      schema: { type: "object" },
                      example: { ok: true },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    return createCliServer({
      spec: specPath,
      port: 0,
      admin: true,
      errors: true,
    });
  }

  it("answers a multipart/related upload and records it as its bytes", async () => {
    server = await uploadServer();
    const body = new Uint8Array([
      ...new TextEncoder().encode("--b\r\nContent-Type: image/jpeg\r\n\r\n"),
      0xff,
      0xd8,
      0x00,
      0x80,
      ...new TextEncoder().encode("\r\n--b--\r\n"),
    ]);

    const response = await fetch(`http://127.0.0.1:${server.port}/uploads`, {
      method: "POST",
      headers: {
        "content-type": 'multipart/related; type="image/jpeg"; boundary=b',
      },
      body,
    });
    expect(response.status).toBe(201);

    const history = await fetch(
      `http://127.0.0.1:${server.port}/schmock-admin/history`,
      { headers: { authorization: `Bearer ${server.adminToken}` } },
    );
    const records: Array<{ body: unknown }> = await history.json();
    expect(records.map((record) => record.body)).toEqual([
      { kind: "binary", byteLength: body.byteLength },
    ]);
  });

  it("still validates a multipart/form-data upload as the record of its fields", async () => {
    server = await uploadServer();
    const form = new FormData();
    form.set("other", "value");

    const response = await fetch(`http://127.0.0.1:${server.port}/uploads`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(400);
  });
});
