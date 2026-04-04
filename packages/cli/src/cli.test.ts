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

  it("returns 500 JSON when request body stream errors", async () => {
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
});
