import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  connect,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliServer, isLoopbackHost, parseCliArgs, run } from "./cli";

const PETSTORE_SPEC = resolve(
  __dirname,
  "../../openapi/src/__fixtures__/petstore-openapi3.json",
);

describe("parseCliArgs", () => {
  it("parses --spec flag", () => {
    const result = parseCliArgs(["--spec", "petstore.yaml"]);
    expect(result.spec).toBe("petstore.yaml");
  });

  it("parses --port flag", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--port", "8080"]);
    expect(result.port).toBe(8080);
  });

  it("parses --hostname flag", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--hostname", "0.0.0.0"]);
    expect(result.hostname).toBe("0.0.0.0");
  });

  it("parses --seed flag", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--seed", "seed.json"]);
    expect(result.seed).toBe("seed.json");
  });

  it("parses --cors flag", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--cors"]);
    expect(result.cors).toBe(true);
  });

  it("parses --debug flag", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--debug"]);
    expect(result.debug).toBe(true);
  });

  it("parses -h / --help flag", () => {
    const result = parseCliArgs(["-h"]);
    expect(result.help).toBe(true);
  });

  it("parses the spec-loading policy flags", () => {
    const result = parseCliArgs([
      "--spec",
      "x.yaml",
      "--strict",
      "--refs-external",
      "--refs-allow-http",
      "a.test, b.test",
    ]);

    expect(result.strict).toBe(true);
    expect(result.refsExternal).toBe(true);
    expect(result.refsAllowHttp).toEqual(["a.test", "b.test"]);
  });

  it("leaves the reference policy off by default", () => {
    const result = parseCliArgs(["--spec", "x.yaml"]);

    expect(result.strict).toBe(false);
    expect(result.refsExternal).toBe(false);
    expect(result.refsAllowHttp).toBeUndefined();
  });

  it("defaults port to undefined when not provided", () => {
    const result = parseCliArgs(["--spec", "x.yaml"]);
    expect(result.port).toBeUndefined();
  });

  it("defaults cors to false", () => {
    const result = parseCliArgs(["--spec", "x.yaml"]);
    expect(result.cors).toBe(false);
  });

  it("defaults spec to empty string when not provided", () => {
    const result = parseCliArgs([]);
    expect(result.spec).toBe("");
  });

  it("parses positional spec argument", () => {
    const result = parseCliArgs(["petstore.yaml"]);
    expect(result.spec).toBe("petstore.yaml");
  });

  it("positional spec works with other flags", () => {
    const result = parseCliArgs(["petstore.yaml", "--port", "8080", "--cors"]);
    expect(result.spec).toBe("petstore.yaml");
    expect(result.port).toBe(8080);
    expect(result.cors).toBe(true);
  });

  it("--spec flag takes precedence over positional", () => {
    const result = parseCliArgs(["positional.yaml", "--spec", "flag.yaml"]);
    expect(result.spec).toBe("flag.yaml");
  });

  it("throws on non-numeric --port value", () => {
    expect(() => parseCliArgs(["--spec", "x.yaml", "--port", "foo"])).toThrow();
  });

  it("throws on negative --port value", () => {
    expect(() => parseCliArgs(["--spec", "x.yaml", "--port", "-1"])).toThrow();
  });

  it("throws on out-of-range --port value", () => {
    expect(() =>
      parseCliArgs(["--spec", "x.yaml", "--port", "99999"]),
    ).toThrow();
  });

  it("parses --admin-token", () => {
    const result = parseCliArgs([
      "--spec",
      "x.yaml",
      "--admin",
      "--admin-token",
      "s3cret",
    ]);
    expect(result.adminToken).toBe("s3cret");
  });

  it("leaves --admin-token undefined by default", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--admin"]);
    expect(result.adminToken).toBeUndefined();
  });

  it("throws on an empty --admin-token", () => {
    expect(() =>
      parseCliArgs(["--spec", "x.yaml", "--admin", "--admin-token", ""]),
    ).toThrow(/admin-token/);
  });

  it("throws on an --admin-token containing whitespace", () => {
    expect(() =>
      parseCliArgs(["--spec", "x.yaml", "--admin", "--admin-token", "a b"]),
    ).toThrow(/admin-token/);
  });

  it("parses --admin-history-limit", () => {
    const result = parseCliArgs([
      "--spec",
      "x.yaml",
      "--admin",
      "--admin-history-limit",
      "25",
    ]);
    expect(result.adminHistoryLimit).toBe(25);
  });

  it("accepts --admin-history-limit 0", () => {
    const result = parseCliArgs([
      "--spec",
      "x.yaml",
      "--admin",
      "--admin-history-limit",
      "0",
    ]);
    expect(result.adminHistoryLimit).toBe(0);
  });

  it("leaves --admin-history-limit undefined by default", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--admin"]);
    expect(result.adminHistoryLimit).toBeUndefined();
  });

  // Core reads a negative maxHistorySize as "unbounded", so these must never
  // reach it.
  it.each([
    "-1",
    "1.5",
    "foo",
    "",
  ])("throws on --admin-history-limit %j", (value) => {
    expect(() =>
      parseCliArgs([
        "--spec",
        "x.yaml",
        "--admin",
        "--admin-history-limit",
        value,
      ]),
    ).toThrow(/admin-history-limit/);
  });
});

describe("isLoopbackHost", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "localhost",
    "::1",
    "[::1]",
    "LOCALHOST",
  ])("treats %s as loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "::",
    "",
    "192.168.1.10",
    "example.test",
    "1270.0.0.1",
  ])("treats %s as reachable off-box", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("admin authentication", () => {
  let server: Awaited<ReturnType<typeof createCliServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("mints an admin token when admin is enabled without one", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
    });
    expect(server.adminToken).toEqual(expect.any(String));
    expect(server.adminToken).not.toBe("");
  });

  it("honours an explicitly supplied admin token", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
      adminToken: "pinned-token",
    });
    expect(server.adminToken).toBe("pinned-token");

    const authorized = await fetch(
      `http://127.0.0.1:${server.port}/schmock-admin/state`,
      { headers: { authorization: "Bearer pinned-token" } },
    );
    expect(authorized.status).toBe(200);
  });

  it("issues no token when admin is disabled", async () => {
    server = await createCliServer({ spec: PETSTORE_SPEC, port: 0 });
    expect(server.adminToken).toBeUndefined();
  });

  it("accepts the x-schmock-admin-token header", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
      adminToken: "pinned-token",
    });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/schmock-admin/state`,
      { headers: { "x-schmock-admin-token": "pinned-token" } },
    );
    expect(response.status).toBe(200);
  });

  // A raw timingSafeEqual throws on unequal buffer lengths, which would surface
  // as a 500 rather than a 401.
  it.each([
    "",
    "short",
    "a-much-longer-token-than-the-real-one",
  ])("rejects the wrong token %j with 401", async (token) => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
      adminToken: "pinned-token",
    });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/schmock-admin/state`,
      { headers: { "x-schmock-admin-token": token } },
    );
    expect(response.status).toBe(401);
  });

  // Token stability across a reload is now covered end-to-end by
  // features/watch-mode.feature ("The admin token survives a reload"): the
  // token is captured once when the socket binds and a reload only swaps the
  // mock behind it, so there is no longer a reload entry point to call here.
});

describe("admin request history retention", () => {
  let server: Awaited<ReturnType<typeof createCliServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function readHistory(): Promise<unknown[]> {
    if (!server) throw new Error("Expected a running server");
    const response = await fetch(
      `http://127.0.0.1:${server.port}/schmock-admin/history`,
      { headers: { authorization: `Bearer ${server.adminToken ?? ""}` } },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("Expected a history array");
    return body;
  }

  it("caps history at the configured limit", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
      adminHistoryLimit: 2,
    });
    for (let i = 0; i < 5; i += 1) {
      expect((await fetch(`http://127.0.0.1:${server.port}/pets`)).status).toBe(
        200,
      );
    }
    expect(await readHistory()).toHaveLength(2);
  });

  // The zero-when-off case is only observable indirectly: with admin on and a
  // limit of 0 the very same wiring must record nothing.
  it("records nothing when the limit is zero", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      admin: true,
      adminHistoryLimit: 0,
    });
    for (let i = 0; i < 3; i += 1) {
      await fetch(`http://127.0.0.1:${server.port}/pets`);
    }
    expect(await readHistory()).toHaveLength(0);
  });
});

describe("createCliServer error handling", () => {
  let server: Awaited<ReturnType<typeof createCliServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("remains available when a request body stream aborts", async () => {
    server = await createCliServer({ spec: PETSTORE_SPEC, port: 0 });
    const { port } = server;

    // Use a raw TCP socket to send a request then destroy the connection
    // mid-body, triggering a stream error that the .catch() should handle
    await new Promise<string>((done, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        // Send a POST with a large content-length but then destroy the stream
        socket.write(
          "POST /pets HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: 10000\r\n" +
            "\r\n" +
            '{"partial":',
        );
        // Destroy after partial body to trigger stream error
        setTimeout(() => socket.destroy(), 50);
      });

      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("close", () => done(data));
      socket.on("error", () => done(data));
      setTimeout(() => reject(new Error("Timeout")), 5000);
    });

    // Verify the server is still alive after the error
    const healthCheck = await fetch(`http://127.0.0.1:${port}/pets`);
    expect(healthCheck.status).toBe(200);
  });

  it("closes an oversized keep-alive request and remains available", async () => {
    server = await createCliServer({ spec: PETSTORE_SPEC, port: 0 });
    const rawResponse = await new Promise<string>((resolveResponse, reject) => {
      const socket = connect(server?.port ?? 0, "127.0.0.1", () => {
        socket.write(
          "POST /pets HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: 10485761\r\n" +
            "Connection: keep-alive\r\n" +
            "\r\n",
        );
      });
      let received = "";
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out waiting for oversized connection close"));
      }, 1_000);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received += chunk;
      });
      socket.on("error", reject);
      socket.on("close", () => {
        clearTimeout(timeout);
        resolveResponse(received);
      });
    });

    expect(rawResponse).toContain(" 413 ");
    expect(rawResponse.toLowerCase()).toContain("connection: close");
    const healthCheck = await fetch(`http://127.0.0.1:${server.port}/pets`);
    expect(healthCheck.status).toBe(200);
  });

  it("delivers a clean 413 while the client is still uploading the declared body", async () => {
    server = await createCliServer({ spec: PETSTORE_SPEC, port: 0 });
    const declaredSize = 10_485_761;

    // Without draining the unread request, closing the socket mid-upload sends
    // a TCP reset that discards the already-written 413 from the client's
    // receive buffer; the client then sees ECONNRESET and zero response bytes.
    const rawResponse = await new Promise<string>((resolveResponse, reject) => {
      const socket = connect(server?.port ?? 0, "127.0.0.1");
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let written = 0;
      let received = "";
      let responseComplete = false;

      const pump = (): void => {
        while (!responseComplete && written < declaredSize) {
          const next = chunk.subarray(
            0,
            Math.min(chunk.length, declaredSize - written),
          );
          written += next.length;
          if (!socket.write(next)) {
            socket.once("drain", pump);
            return;
          }
        }
      };

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out waiting for the 413 during upload"));
      }, 10_000);
      socket.on("connect", () => {
        socket.write(
          "POST /pets HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "Content-Type: application/json\r\n" +
            `Content-Length: ${declaredSize}\r\n` +
            "Connection: keep-alive\r\n" +
            "\r\n",
        );
        pump();
      });
      socket.on("data", (data: Buffer) => {
        received += data.toString("utf8");
        if (!responseComplete && received.includes("\r\n\r\n")) {
          responseComplete = true;
          socket.end();
        }
      });
      socket.on("error", (error: Error) => {
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error(`socket error during upload: ${error.message}`));
      });
      socket.on("close", () => {
        clearTimeout(timeout);
        resolveResponse(received);
      });
    });

    expect(rawResponse).toContain(" 413 ");
    expect(rawResponse.toLowerCase()).toContain("connection: close");
    expect(rawResponse).toContain('"code":"PAYLOAD_TOO_LARGE"');
    const healthCheck = await fetch(`http://127.0.0.1:${server.port}/pets`);
    expect(healthCheck.status).toBe(200);
  });
});

describe("bounded shutdown", () => {
  let server: Awaited<ReturnType<typeof createCliServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  /** Binding the port again is the only proof the socket was really released. */
  function expectPortIsFree(port: number): Promise<void> {
    return new Promise<void>((done, fail) => {
      const probe = createNetServer();
      probe.once("error", fail);
      probe.listen(port, "127.0.0.1", () => {
        probe.close(() => done());
      });
    });
  }

  /** Headers announcing a body that never arrives — the handler stays admitted. */
  function startStalledRequest(port: number): Promise<Socket> {
    return new Promise((done, fail) => {
      const socket = connect(port, "127.0.0.1");
      socket.on("error", fail);
      socket.on("connect", () => {
        socket.write(
          "POST /pets HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: 100\r\n" +
            "Connection: keep-alive\r\n" +
            "\r\n" +
            '{"name":',
        );
        setTimeout(() => done(socket), 100);
      });
    });
  }

  // Unbounded, this never settles: `server.close()` waits for a request whose
  // body the client will never finish sending.
  it("settles with a half-sent request still open", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      shutdownGraceMs: 100,
    });
    const { port } = server;
    const stalled = await startStalledRequest(port);

    try {
      await server.close();
      server = undefined;
      await expectPortIsFree(port);
    } finally {
      stalled.destroy();
    }
  }, 10_000);

  it("is idempotent and resolves every caller", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      shutdownGraceMs: 100,
    });
    const { port } = server;

    const first = server.close();
    const second = server.close();
    // The same shutdown, not a second one racing the first.
    expect(second).toBe(first);
    await Promise.all([first, second, server.close()]);
    server = undefined;

    await expectPortIsFree(port);
  });
});

/**
 * The invariant the whole one-server design rests on: the mock is read once,
 * when the request is admitted. A request already in flight must therefore
 * finish against the mock it started on, while the next one sees the new mock.
 */
describe("mock swap on reload", () => {
  let server: Awaited<ReturnType<typeof createCliServer>> | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function spec(paths: Record<string, unknown>): string {
    return JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Reload", version: "1.0.0" },
      paths,
    });
  }

  // The declared status is the discriminator: it depends on nothing but which
  // spec the mock was built from.
  const before = {
    "/echo": { post: { responses: { "201": { description: "Created" } } } },
  };
  const after = {
    "/echo": { post: { responses: { "202": { description: "Accepted" } } } },
    "/ready": { get: { responses: { "200": { description: "OK" } } } },
  };

  it("finishes an in-flight request on the old mock and serves the new one after", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "schmock-swap-"));
    const specPath = join(tempDir, "spec.json");
    writeFileSync(specPath, spec(before));

    server = await createCliServer({
      spec: specPath,
      port: 0,
      watch: true,
      shutdownGraceMs: 100,
    });
    const { port } = server;
    // `fs.watch` only observes changes made after one event-loop turn.
    await new Promise((armed) => setTimeout(armed, 25));

    const body = '{"a":"0123456789ab"}';
    const socket = connect(port, "127.0.0.1");
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      raw += chunk;
    });
    await new Promise<void>((connected) =>
      socket.on("connect", () => connected()),
    );

    // Headers plus a fragment of the body: the request is admitted against the
    // current mock and then stays pending across the reload.
    socket.write(
      "POST /echo HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Type: application/json\r\n" +
        `Content-Length: ${body.length}\r\n` +
        "Connection: close\r\n" +
        "\r\n" +
        body.slice(0, 5),
    );
    await new Promise((admitted) => setTimeout(admitted, 100));

    writeFileSync(specPath, spec(after));
    const deadline = Date.now() + 10_000;
    let reloaded = false;
    while (!reloaded && Date.now() < deadline) {
      const probe = await fetch(`http://127.0.0.1:${port}/ready`);
      await probe.arrayBuffer();
      reloaded = probe.status === 200;
      if (!reloaded) await new Promise((tick) => setTimeout(tick, 50));
    }
    expect(reloaded).toBe(true);

    // Only now does the pending request get the rest of its body.
    socket.write(body.slice(5));
    await new Promise<void>((closed) => socket.on("close", () => closed()));
    expect(raw).toContain(" 201 ");

    const afterReload = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(afterReload.status).toBe(202);
  }, 20_000);
});

describe("CLI binary", () => {
  it("reports a rejected run and exits unsuccessfully", async () => {
    const missingSpec = resolve(__dirname, "__fixtures__/missing-spec.json");
    const child = spawn(
      "bun",
      [resolve(__dirname, "bin.ts"), "--spec", missingSpec],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on("close", resolveExit);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Schmock failed:");
  });

  /** Runs the binary until it reports it is listening, then kills it. */
  async function startBinary(args: string[]): Promise<string> {
    const child = spawn(
      "bun",
      [resolve(__dirname, "bin.ts"), "--spec", PETSTORE_SPEC, ...args],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(
          () => rejectReady(new Error(`Server never started: ${stderr}`)),
          15_000,
        );
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
          if (stderr.includes("Schmock server running")) {
            clearTimeout(timeout);
            resolveReady();
          }
        });
        child.on("error", (error) => {
          clearTimeout(timeout);
          rejectReady(error);
        });
      });
      // The warning is written after the banner; give it a tick to arrive.
      await new Promise((tick) => setTimeout(tick, 100));
    } finally {
      child.kill("SIGKILL");
    }

    return stderr;
  }

  it("prints the generated admin token and stays quiet on a loopback bind", async () => {
    const stderr = await startBinary(["--port", "0", "--admin"]);

    expect(stderr).toContain("Admin: enabled (/schmock-admin/*)");
    expect(stderr).toMatch(/Admin token: \S+/);
    expect(stderr).not.toContain("WARNING");
  });

  it("warns when the admin API is bound to a non-loopback address", async () => {
    const stderr = await startBinary([
      "--port",
      "0",
      "--admin",
      "--hostname",
      "0.0.0.0",
    ]);

    expect(stderr).toContain("WARNING");
    expect(stderr).toContain("0.0.0.0");
  });
});

describe("post-listen server errors", () => {
  let server: Awaited<ReturnType<typeof createCliServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reports a server error raised after listen instead of swallowing it", async () => {
    server = await createCliServer({ spec: PETSTORE_SPEC, port: 0 });
    const written: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });

    try {
      expect(() =>
        server?.server.emit("error", new Error("late server failure")),
      ).not.toThrow();
    } finally {
      writeSpy.mockRestore();
    }

    expect(written.join("")).toMatch(/Server error: late server failure/);
  });

  it("keeps exactly one error listener after listen resolves", async () => {
    server = await createCliServer({ spec: PETSTORE_SPEC, port: 0 });
    expect(server.server.listenerCount("error")).toBe(1);
  });

  it("still rejects when the socket cannot be bound", async () => {
    const blocker = createNetServer();
    await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", done));
    const address = blocker.address();
    const takenPort =
      address !== null && typeof address === "object" ? address.port : 0;

    try {
      await expect(
        createCliServer({ spec: PETSTORE_SPEC, port: takenPort }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });
});

describe("parseCliArgs validation", () => {
  it.each([
    ["abc"],
    [""],
    ["1.5"],
    ["  "],
    ["Infinity"],
    ["1e400"],
  ])("rejects --seed-random %j", (value) => {
    expect(() =>
      parseCliArgs(["--spec", "x.yaml", "--seed-random", value]),
    ).toThrow(/--seed-random/);
  });

  it.each([
    ["42", 42],
    ["0", 0],
    [" 7 ", 7],
  ])("accepts --seed-random %j as %i", (value, expected) => {
    const result = parseCliArgs(["--spec", "x.yaml", "--seed-random", value]);
    expect(result.fakerSeed).toBe(expected);
  });

  // A leading dash needs the `=` form: node:util's parseArgs refuses a
  // separate argument that looks like another flag.
  it("accepts a negative --seed-random", () => {
    const result = parseCliArgs(["--spec", "x.yaml", "--seed-random=-1"]);
    expect(result.fakerSeed).toBe(-1);
  });

  it("leaves fakerSeed undefined when --seed-random is absent", () => {
    expect(parseCliArgs(["--spec", "x.yaml"]).fakerSeed).toBeUndefined();
  });

  it.each([[""], ["   "]])("rejects a blank --hostname %j", (value) => {
    expect(() =>
      parseCliArgs(["--spec", "x.yaml", "--hostname", value]),
    ).toThrow(/--hostname/);
  });

  it("still accepts a real hostname", () => {
    expect(
      parseCliArgs(["--spec", "x.yaml", "--hostname", "0.0.0.0"]).hostname,
    ).toBe("0.0.0.0");
  });

  it("rejects extra positional arguments", () => {
    expect(() => parseCliArgs(["a.json", "b.json"])).toThrow(
      /Unexpected extra argument/,
    );
    expect(() => parseCliArgs(["a.json", "b.json", "c.json"])).toThrow(
      /b\.json, c\.json/,
    );
  });
});

describe("createCliServer hostname validation", () => {
  it("rejects a blank hostname on the programmatic path", async () => {
    await expect(
      createCliServer({ spec: PETSTORE_SPEC, port: 0, hostname: "" }),
    ).rejects.toThrow(/hostname/);
  });
});

describe("repeat shutdown signals", () => {
  it("acknowledges a repeat signal once and still settles", async () => {
    const baseline = process.listeners("SIGINT");
    let stderr = "";
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });

    const runPromise = run(["--spec", PETSTORE_SPEC, "--port", "0"]).finally(
      () => stderrWrite.mockRestore(),
    );

    try {
      const deadline = Date.now() + 10_000;
      while (
        !/Schmock server running on/.test(stderr) &&
        Date.now() < deadline
      ) {
        await new Promise((tick) => setTimeout(tick, 25));
      }
      expect(stderr).toMatch(/Schmock server running on/);

      const added = process
        .listeners("SIGINT")
        .filter((listener) => !baseline.includes(listener)) as Array<
        () => void
      >;
      expect(added).toHaveLength(1);

      // First signal shuts down; the next two must not be silent, and must not
      // restart the shutdown either.
      added[0]?.();
      added[0]?.();
      added[0]?.();

      await runPromise;
    } finally {
      stderrWrite.mockRestore();
    }

    expect(stderr.match(/Shutting down\.\.\./g)).toHaveLength(1);
    expect(stderr.match(/Shutdown already in progress/g)).toHaveLength(1);
    expect(process.listeners("SIGINT")).toEqual(baseline);
  });
});
