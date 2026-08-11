import { describe, expect, it } from "vitest";
import { getResponseException } from "./constants.js";
import { isRouteNotFound, schmock } from "./index";

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a record");
  }
  return Object.fromEntries(Object.entries(value));
}

// ── FIX 1.2: defineRoute must shallow-clone the config ────────────────────────

describe("FIX 1.2 — defineRoute must not mutate the caller's config", () => {
  it("does not add contentType to the caller's config object", () => {
    const sharedConfig: Schmock.RouteConfig = {};
    const mock = schmock();
    mock("GET /a", { x: 1 }, sharedConfig);
    // sharedConfig must remain empty — defineRoute must work on a clone
    expect(Object.keys(sharedConfig)).toHaveLength(0);
  });

  it("second route registered with same config is not polluted by first route detection", () => {
    const sharedConfig: Schmock.RouteConfig = {};
    const mock = schmock();
    mock("GET /first", { x: 1 }, sharedConfig);
    mock("GET /second", "hello", sharedConfig);
    // sharedConfig must still be clean — neither call should have written to it
    expect(Object.keys(sharedConfig)).toHaveLength(0);
  });

  it("mutating caller's config after registration does not change the registered route response", async () => {
    const config: Schmock.RouteConfig = {};
    const mock = schmock();
    mock("GET /item", { value: 99 }, config);

    // After registration, mutate the caller's config
    config.status = 503;
    config.contentType = "text/html";

    const response = await mock.handle("GET", "/item");
    // The registered route must use its own cloned config — not 503
    expect(response.status).toBe(200);
    const ct =
      response.headers?.["content-type"] ?? response.headers?.["Content-Type"];
    expect(ct).toContain("application/json");
  });

  it("each route keeps its own detected contentType even when sharing the same config object", async () => {
    const sharedConfig: Schmock.RouteConfig = {};
    const mock = schmock();
    // First route: object → application/json
    mock("GET /obj", { value: 1 }, sharedConfig);
    // Second route: primitive string → text/plain
    mock("GET /str", "hello", sharedConfig);

    const objResp = await mock.handle("GET", "/obj");
    const strResp = await mock.handle("GET", "/str");

    const ctObj =
      objResp.headers?.["content-type"] ?? objResp.headers?.["Content-Type"];
    const ctStr =
      strResp.headers?.["content-type"] ?? strResp.headers?.["Content-Type"];

    expect(ctObj).toContain("application/json");
    expect(ctStr).toContain("text/plain");
  });
});

// ── FIX 2.2: duplicate route detection must normalize trailing slash ──────────

describe("FIX 2.2 — duplicate-route detection uses normalized paths", () => {
  it("GET /users/ is treated as duplicate of GET /users", () => {
    const mock = schmock();
    mock("GET /users", [{ id: 1 }], {});
    // Registering with trailing slash must not add a second route
    mock("GET /users/", [{ id: 2 }], {});

    const routes = mock.getRoutes();
    const userRoutes = routes.filter(
      (r) =>
        r.method === "GET" && (r.path === "/users" || r.path === "/users/"),
    );
    expect(userRoutes).toHaveLength(1);
  });

  it("first registration wins — trailing-slash variant does not overwrite", async () => {
    const mock = schmock();
    mock("GET /items", [{ id: 1 }], {});
    mock("GET /items/", [{ id: 999 }], {});

    // Should still get the first registration's data
    const resp = await mock.handle("GET", "/items");
    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body)).toBe(true);
    expect((resp.body as { id: number }[])[0].id).toBe(1);
  });

  it("registering verbatim duplicate also produces only one route", () => {
    const mock = schmock();
    mock("GET /same", { ok: true }, {});
    mock("GET /same", { ok: false }, {});

    const routes = mock.getRoutes();
    const sameRoutes = routes.filter(
      (r) => r.method === "GET" && r.path === "/same",
    );
    expect(sameRoutes).toHaveLength(1);
  });
});

// ── FIX 3.3: reset()/resetState() must reassign, not delete keys ─────────────

describe("FIX 3.3 — reset()/resetState() must not mutate caller's state", () => {
  it("reset() leaves the external state object untouched", () => {
    const st = { a: 1 };
    const mock = schmock({ state: st });
    mock.reset();
    expect(st).toEqual({ a: 1 });
  });

  it("resetState() leaves the external state object untouched", () => {
    const st = { b: 2 };
    const mock = schmock({ state: st });
    mock.resetState();
    expect(st).toEqual({ b: 2 });
  });

  it("mock.getState() is empty after reset()", () => {
    const st = { x: 10 };
    const mock = schmock({ state: st });
    mock.reset();
    expect(mock.getState()).toEqual({});
  });

  it("mock.getState() is empty after resetState()", () => {
    const st = { y: 20 };
    const mock = schmock({ state: st });
    mock.resetState();
    expect(mock.getState()).toEqual({});
  });

  it("generator sees empty state after resetState", async () => {
    const st: Record<string, unknown> = { counter: 0 };
    const mock = schmock({ state: st });
    mock("GET /stateful", (ctx: Schmock.RequestContext) => {
      return { stateKeys: Object.keys(ctx.state) };
    });

    mock.resetState();

    const resp = await mock.handle("GET", "/stateful");
    expect(resp.status).toBe(200);
    // After resetState, the generator should see an empty state
    expect((resp.body as { stateKeys: string[] }).stateKeys).toHaveLength(0);
  });
});

// ── FIX 2.3: history()/lastRequest() must return deep clones ─────────────────

describe("FIX 2.3 — history() and lastRequest() return deep clones", () => {
  it("mutating a history() record's nested body does not corrupt internal history", async () => {
    const mock = schmock();
    mock("GET /nested", { deep: { value: "original" } }, {});

    await mock.handle("GET", "/nested");

    // First read: mutate the returned record's body
    const records1 = mock.history();
    const firstRecord = records1[0];
    (firstRecord.response.body as { deep: { value: string } }).deep.value =
      "MUTATED";

    // Second read: internal history must be unchanged
    const records2 = mock.history();
    expect(
      (records2[0].response.body as { deep: { value: string } }).deep.value,
    ).toBe("original");
  });

  it("mutating filtered history() record does not corrupt internal history", async () => {
    const mock = schmock();
    mock("GET /data", { info: { count: 42 } }, {});
    await mock.handle("GET", "/data");

    const filtered = mock.history("GET", "/data");
    (filtered[0].response.body as { info: { count: number } }).info.count = 0;

    const again = mock.history("GET", "/data");
    expect(
      (again[0].response.body as { info: { count: number } }).info.count,
    ).toBe(42);
  });

  it("mutating lastRequest() record does not corrupt internal history", async () => {
    const mock = schmock();
    mock("GET /last", { meta: { tag: "safe" } }, {});
    await mock.handle("GET", "/last");

    const last = mock.lastRequest();
    if (!last) throw new Error("expected a record");
    (last.response.body as { meta: { tag: string } }).meta.tag = "corrupted";

    const again = mock.lastRequest();
    if (!again) throw new Error("expected a record");
    expect((again.response.body as { meta: { tag: string } }).meta.tag).toBe(
      "safe",
    );
  });

  it("mutating filtered lastRequest() record does not corrupt internal history", async () => {
    const mock = schmock();
    mock("POST /echo", { msg: { text: "hello" } }, {});
    await mock.handle("POST", "/echo");

    const last = mock.lastRequest("POST", "/echo");
    if (!last) throw new Error("expected a record");
    (last.response.body as { msg: { text: string } }).msg.text = "CHANGED";

    const again = mock.lastRequest("POST", "/echo");
    if (!again) throw new Error("expected a record");
    expect((again.response.body as { msg: { text: string } }).msg.text).toBe(
      "hello",
    );
  });

  it("records a descriptor instead of retaining non-cloneable request bodies", async () => {
    const mock = schmock();
    const body = { mutable: "original", callback: () => "value" };
    mock("POST /non-cloneable", { accepted: true });

    await mock.handle("POST", "/non-cloneable", { body });
    body.mutable = "changed";

    const first = mock.lastRequest();
    expect(first?.body).toMatchObject({
      kind: "unavailable",
      reason: "not-structured-cloneable",
    });
    if (typeof first?.body === "object" && first.body !== null) {
      Reflect.set(first.body, "kind", "mutated");
    }
    expect(mock.lastRequest()?.body).toMatchObject({
      kind: "unavailable",
      reason: "not-structured-cloneable",
    });
  });

  it("copies nested shared memory into isolated history snapshots", async () => {
    const mock = schmock();
    const shared = new SharedArrayBuffer(4);
    const source = new Uint8Array(shared);
    source.set([1, 2, 3, 4]);
    mock("POST /shared", { accepted: true });

    await mock.handle("POST", "/shared", {
      body: {
        buffer: shared,
        view: new Uint8Array(shared, 1, 2),
      },
    });
    source.fill(9);

    const first = requireRecord(mock.lastRequest()?.body);
    expect(first.buffer).toBeInstanceOf(ArrayBuffer);
    expect(first.view).toBeInstanceOf(Uint8Array);
    if (!(first.buffer instanceof ArrayBuffer)) {
      throw new Error("Expected an ordinary ArrayBuffer snapshot");
    }
    if (!(first.view instanceof Uint8Array)) {
      throw new Error("Expected a Uint8Array snapshot");
    }
    expect(first.view.buffer).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(first.buffer)]).toEqual([1, 2, 3, 4]);
    expect([...first.view]).toEqual([2, 3]);
    new Uint8Array(first.buffer).fill(8);
    first.view.fill(7);

    const second = requireRecord(mock.lastRequest()?.body);
    if (!(second.buffer instanceof ArrayBuffer)) {
      throw new Error("Expected an ordinary ArrayBuffer snapshot");
    }
    if (!(second.view instanceof Uint8Array)) {
      throw new Error("Expected a Uint8Array snapshot");
    }
    expect([...new Uint8Array(second.buffer)]).toEqual([1, 2, 3, 4]);
    expect([...second.view]).toEqual([2, 3]);
  });

  it("copies shared memory from non-enumerable structured-clone fields", async () => {
    const mock = schmock();
    const shared = new SharedArrayBuffer(3);
    const source = new Uint8Array(shared);
    source.set([4, 5, 6]);
    mock("POST /error-cause", { accepted: true });

    await mock.handle("POST", "/error-cause", {
      body: new Error("request failed", { cause: shared }),
    });
    source.fill(9);

    const first = mock.lastRequest()?.body;
    if (!(first instanceof Error) || !(first.cause instanceof ArrayBuffer)) {
      throw new Error("Expected an Error with an ordinary buffer cause");
    }
    expect([...new Uint8Array(first.cause)]).toEqual([4, 5, 6]);
    new Uint8Array(first.cause).fill(8);

    const second = mock.lastRequest()?.body;
    if (!(second instanceof Error) || !(second.cause instanceof ArrayBuffer)) {
      throw new Error("Expected an isolated Error cause snapshot");
    }
    expect([...new Uint8Array(second.cause)]).toEqual([4, 5, 6]);
  });
});

describe("terminal HEAD responses", () => {
  it("normalizes unmatched HEAD responses while retaining route provenance", async () => {
    const response = await schmock().handle("HEAD", "/missing");

    expect(response.status).toBe(404);
    expect(response.body).toBeUndefined();
    expect(isRouteNotFound(response)).toBe(true);
  });

  it("does not mark a custom HEAD 404 as an unmatched route", async () => {
    const mock = schmock();
    mock("HEAD /custom", () => [404, { code: "CUSTOM_NOT_FOUND" }]);

    const response = await mock.handle("HEAD", "/custom");

    expect(response.status).toBe(404);
    expect(response.body).toBeUndefined();
    expect(isRouteNotFound(response)).toBe(false);
  });

  it("normalizes thrown HEAD responses while retaining the exception", async () => {
    const mock = schmock();
    mock("HEAD /throws", () => {
      throw new Error("head failure");
    });

    const response = await mock.handle("HEAD", "/throws");

    expect(response.status).toBe(500);
    expect(response.body).toBeUndefined();
    expect(getResponseException(response)?.message).toBe("head failure");
  });
});
