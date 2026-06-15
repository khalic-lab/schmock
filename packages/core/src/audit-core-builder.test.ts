import { describe, expect, it } from "vitest";
import { schmock } from "./index";

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
});
