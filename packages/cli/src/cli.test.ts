import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliServer, parseCliArgs } from "./cli";

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
});

describe("createCliServer error handling", () => {
  let server: Awaited<ReturnType<typeof createCliServer>> | undefined;

  afterEach(() => {
    server?.close();
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
});
