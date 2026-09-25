import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CallableMockInstance } from "@schmock/core";
import { SchmockError, SENSITIVE_HEADER_NAMES, schmock } from "@schmock/core";
import { afterEach, describe, expect, it } from "vitest";
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

  it("rejects a malformed admin request body before checking the token", async () => {
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
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: "MALFORMED_JSON" });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
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

  it("reads a preflight's body before answering it", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      cors: true,
    });
    const body = '{"broken":';
    // The preflight used to be answered 204 without reading the body.
    const response = await sendRaw(
      server.port,
      "OPTIONS /pets HTTP/1.1\r\nHost: localhost\r\n" +
        "Origin: http://app.test\r\n" +
        "Access-Control-Request-Method: POST\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: keep-alive\r\n\r\n${body}`,
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: "MALFORMED_JSON" });
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers.connection).toBe("close");
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
        "Invalid --admin-token. The token must be non-empty and contain no whitespace.",
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

  it("keeps an invalid-JSON manifest's message and gives it the seed code", () => {
    tempDir = mkdtempSync(join(tmpdir(), "schmock-seed-codes-"));
    const seedPath = join(tempDir, "seed.json");
    writeFileSync(seedPath, "{not json");
    const error = captureError(() => loadSeedFile(seedPath));
    expect(error).toBeInstanceOf(SchmockError);
    expect(error).toMatchObject({
      code: "OPENAPI_INVALID_OPTION",
      message: `Seed file "${seedPath}" contains invalid JSON`,
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
