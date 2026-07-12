import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { schmock } from "./index";

describe("Standalone Server", () => {
  let mock: Schmock.CallableMockInstance;

  afterEach(() => {
    mock?.close();
  });

  it("returns actual port when port=0", async () => {
    mock = schmock();
    mock("GET /test", { ok: true });
    const info = await mock.listen(0);
    expect(info.port).toBeGreaterThan(0);
    expect(info.hostname).toBe("127.0.0.1");
  });

  it("propagates request headers", async () => {
    mock = schmock();
    mock("GET /headers", ({ headers }) => ({
      auth: headers.authorization,
    }));
    const info = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${info.port}/headers`, {
      headers: { authorization: "Bearer secret" },
    });
    const body = await res.json();
    expect(body.auth).toBe("Bearer secret");
  });

  it("handles concurrent requests", async () => {
    mock = schmock();
    mock("GET /slow", () => ({ value: "done" }));
    const info = await mock.listen(0);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`http://127.0.0.1:${info.port}/slow`).then((r) => r.json()),
      ),
    );

    for (const body of results) {
      expect(body.value).toBe("done");
    }
  });

  it("parses text body when content-type is not JSON", async () => {
    mock = schmock();
    mock("POST /text", ({ body: reqBody }) => ({ received: reqBody }));
    const info = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${info.port}/text`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello world",
    });
    const resBody = await res.json();
    expect(resBody.received).toBe("hello world");
  });

  it("returns 204 with no body for undefined response", async () => {
    mock = schmock();
    mock("DELETE /item", () => undefined);
    const info = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${info.port}/item`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it("writes binary response bodies without JSON serialization", async () => {
    mock = schmock();
    mock("GET /binary", new Uint8Array([0, 1, 255]));
    const info = await mock.listen(0);

    const response = await fetch(`http://127.0.0.1:${info.port}/binary`);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 255]),
    );
  });

  it("writes dynamic and tuple binary responses with binary content type", async () => {
    mock = schmock();
    const dynamicBytes = new Uint8Array([1, 2, 3]);
    const tupleBytes = new Uint8Array([4, 5, 6]);
    mock("GET /dynamic-binary", () => dynamicBytes.buffer);
    mock(
      "GET /tuple-binary",
      () => [206, new DataView(tupleBytes.buffer)] satisfies [number, unknown],
    );
    const info = await mock.listen(0);

    const dynamicResponse = await fetch(
      `http://127.0.0.1:${info.port}/dynamic-binary`,
    );
    expect(dynamicResponse.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await dynamicResponse.arrayBuffer())).toEqual(
      dynamicBytes,
    );

    const tupleResponse = await fetch(
      `http://127.0.0.1:${info.port}/tuple-binary`,
    );
    expect(tupleResponse.status).toBe(206);
    expect(tupleResponse.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await tupleResponse.arrayBuffer())).toEqual(
      tupleBytes,
    );
  });

  it("reset stops the server", async () => {
    mock = schmock();
    mock("GET /test", { ok: true });
    const info = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${info.port}/test`);
    expect(res.status).toBe(200);

    mock.reset();

    await expect(
      fetch(`http://127.0.0.1:${info.port}/test`),
    ).rejects.toBeDefined();
  });

  it("handles route params in server mode", async () => {
    mock = schmock();
    mock("GET /users/:id", ({ params }) => ({ id: params.id }));
    const info = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${info.port}/users/42`);
    const body = await res.json();
    expect(body.id).toBe("42");
  });

  it("double listen throws", async () => {
    mock = schmock();
    mock("GET /test", { ok: true });
    await mock.listen(0);
    expect(() => mock.listen(0)).toThrow("Server is already running");
  });

  it("can retry listening after an occupied-port failure", async () => {
    const occupiedServer = createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once("error", reject);
      occupiedServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = occupiedServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected an address with a numeric port");
      }

      mock = schmock();
      await expect(mock.listen(address.port)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });

      const retry = await mock.listen(0);
      expect(retry.port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) =>
        occupiedServer.close(() => resolve()),
      );
    }
  });

  it("close is idempotent", async () => {
    mock = schmock();
    mock("GET /test", { ok: true });
    await mock.listen(0);
    mock.close();
    expect(() => mock.close()).not.toThrow();
  });

  it("generator that throws synchronously returns 500", async () => {
    mock = schmock();
    mock("GET /boom", () => {
      throw new Error("sync kaboom");
    });
    const info = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${info.port}/boom`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("sync kaboom");
  });

  it("generator that returns rejected Promise returns 500", async () => {
    mock = schmock();
    mock("GET /reject", async () => {
      throw new Error("async rejection");
    });
    const info = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${info.port}/reject`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("async rejection");
  });

  it("close terminates keep-alive connections immediately", async () => {
    mock = schmock();
    mock("GET /test", { ok: true });
    const info = await mock.listen(0);

    // Make a keep-alive request to establish a persistent connection
    const res = await fetch(`http://127.0.0.1:${info.port}/test`, {
      headers: { connection: "keep-alive" },
    });
    expect(res.status).toBe(200);

    // Close the server — should terminate all connections
    mock.close();

    // Subsequent request should fail immediately (not hang on keep-alive)
    await expect(
      fetch(`http://127.0.0.1:${info.port}/test`),
    ).rejects.toBeDefined();
  });
});
