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

  it("reset stops the server", async () => {
    mock = schmock();
    mock("GET /test", { ok: true });
    const info = await mock.listen(0);

    const res = await fetch(`http://127.0.0.1:${info.port}/test`);
    expect(res.status).toBe(200);

    mock.reset();

    try {
      await fetch(`http://127.0.0.1:${info.port}/test`);
      expect.unreachable("Should have thrown");
    } catch {
      // Expected: connection refused
    }
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

  it("close is idempotent", async () => {
    mock = schmock();
    mock("GET /test", { ok: true });
    await mock.listen(0);
    mock.close();
    expect(() => mock.close()).not.toThrow();
  });
});
