import { existsSync, readFileSync } from "node:fs";
import { Server } from "node:http";
import { resolve } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRequestAdmission } from "./admission";
import { isRouteNotFound } from "./constants";
import { DebugLogger } from "./debug-logger";
import { SchmockError } from "./errors";
import { RequestGenerations } from "./generations";
import { RequestHistory } from "./history";
import { schmock } from "./index";
import { createFetchInterceptor } from "./interceptor";
import { NodeServerController } from "./node-server";
import { RouteTable } from "./route-table";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schmockErrorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof SchmockError ? error.code : "not-a-schmock-error";
  }
  return undefined;
}

function okResponse(): Schmock.Response {
  return {
    status: 200,
    body: { ok: true },
    headers: { "content-type": "application/json" },
  };
}

// ---------------------------------------------------------------------------
// Browser safety of the split (#395)
// ---------------------------------------------------------------------------

const distRoot = resolve(__dirname, "..", "dist");

function staticNodeImports(src: string): string[] {
  return src.match(/from\s*["']node:[^"']+["']/g) ?? [];
}

function relativeImports(src: string): string[] {
  return [...src.matchAll(/from\s*["'](\.\/[^"']+)["']/g)].map(
    (match) => match[1],
  );
}

describe.skipIf(!existsSync(distRoot))(
  "dist shape of every module builder.js loads (#395)",
  () => {
    it("statically imports node:* nowhere in builder.js's module graph", () => {
      const visited = new Set<string>();
      const pending = ["./builder.js"];
      while (pending.length > 0) {
        const specifier = pending.pop();
        if (specifier === undefined || visited.has(specifier)) continue;
        visited.add(specifier);
        const src = readFileSync(resolve(distRoot, specifier), "utf8");
        expect(staticNodeImports(src), specifier).toEqual([]);
        pending.push(...relativeImports(src));
      }

      for (const module of [
        "./node-server.js",
        "./history.js",
        "./route-table.js",
        "./plugin-hooks.js",
        "./generations.js",
        "./events.js",
        "./delay.js",
        "./debug-logger.js",
      ]) {
        expect(visited).toContain(module);
      }
    });

    it("keeps node:http a dynamic import inside node-server.js", () => {
      const src = readFileSync(resolve(distRoot, "node-server.js"), "utf8");
      expect(src).toMatch(/import\(\s*["']node:http["']\s*\)/);
    });
  },
);

// ---------------------------------------------------------------------------
// RequestHistory
// ---------------------------------------------------------------------------

describe("RequestHistory", () => {
  const entryFor = (
    history: RequestHistory,
    overrides: Partial<{ generation: symbol; path: string; status: number }>,
  ) => ({
    generation: overrides.generation ?? history.generation,
    method: "GET" as const,
    path: overrides.path ?? "/users",
    params: { id: "1" },
    snapshot: history.snapshotRequest({
      query: { q: "1" },
      headers: { accept: "json" },
      body: { sent: true },
    }) ?? { query: {}, headers: {}, body: undefined },
    response: { ...okResponse(), status: overrides.status ?? 200 },
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects maxHistorySize %s with INVALID_CONFIG",
    (limit) => {
      expect(schmockErrorCode(() => new RequestHistory(limit))).toBe(
        "INVALID_CONFIG",
      );
    },
  );

  it("accepts 0 and undefined", () => {
    expect(schmockErrorCode(() => new RequestHistory(0))).toBeUndefined();
    expect(
      schmockErrorCode(() => new RequestHistory(undefined)),
    ).toBeUndefined();
  });

  it("snapshots nothing and records nothing when disabled", () => {
    const history = new RequestHistory(0);
    expect(
      history.snapshotRequest({ query: {}, headers: {}, body: "x" }),
    ).toBeUndefined();
    history.record(entryFor(history, {}));
    expect(history.callCount()).toBe(0);
  });

  it("snapshots the request as sent, so later edits do not reach the record", () => {
    const history = new RequestHistory(undefined);
    const request = {
      query: { q: "1" },
      headers: { accept: "json" },
      body: { nested: { value: 1 } },
    };
    const snapshot = history.snapshotRequest(request);
    request.query.q = "edited";
    request.headers.accept = "edited";
    request.body.nested.value = 2;
    expect(snapshot).toEqual({
      query: { q: "1" },
      headers: { accept: "json" },
      body: { nested: { value: 1 } },
    });
  });

  it("keeps recording the current generation across clear(), but not an ended one", () => {
    const history = new RequestHistory(undefined);
    const admitted = history.generation;

    history.clear();
    history.record(entryFor(history, { generation: admitted }));
    expect(history.callCount()).toBe(1);

    history.startGeneration();
    history.record(entryFor(history, { generation: admitted }));
    expect(history.callCount()).toBe(1);
    expect(history.generation).not.toBe(admitted);
  });

  it("evicts the oldest records beyond the limit", () => {
    const history = new RequestHistory(2);
    for (const status of [201, 202, 203]) {
      history.record(entryFor(history, { status }));
    }
    expect(history.history().map((record) => record.response.status)).toEqual([
      202, 203,
    ]);
  });

  it("returns deep copies from every read", () => {
    const history = new RequestHistory(undefined);
    history.record(entryFor(history, {}));

    const first = history.lastRequest();
    if (first === undefined || !isRecord(first.body)) {
      throw new Error("expected a recorded body");
    }
    first.body.sent = false;
    first.params.id = "edited";

    expect(history.history()[0]?.body).toEqual({ sent: true });
    expect(history.lastRequest("GET", "/users")?.params).toEqual({ id: "1" });
  });

  it("matches a filter in either spelling of the canonical path", () => {
    const history = new RequestHistory(undefined);
    history.record(entryFor(history, { path: "/caf%C3%A9" }));

    expect(history.called("GET", "/café")).toBe(true);
    expect(history.callCount("GET", "/caf%c3%a9/")).toBe(1);
    expect(history.called("POST", "/café")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RequestGenerations
// ---------------------------------------------------------------------------

describe("RequestGenerations", () => {
  const plugin = (name: string): Schmock.Plugin => ({
    name,
    process: (context, response) => ({ context, response }),
  });

  it("uninstalls a retired idle generation at once", () => {
    const uninstall = vi.fn();
    const generations = new RequestGenerations(uninstall);
    const installed = [plugin("a")];

    const retired = generations.advance();
    expect(generations.isCurrent(retired)).toBe(false);
    generations.retire(retired, installed);

    expect(uninstall).toHaveBeenCalledOnce();
    expect(uninstall).toHaveBeenCalledWith(installed);
  });

  it("waits for the last in-flight request of a retired generation", () => {
    const uninstall = vi.fn();
    const generations = new RequestGenerations(uninstall);
    const installed = [plugin("a")];

    const first = generations.admit();
    const second = generations.admit();
    expect(generations.isCurrent(first)).toBe(true);
    generations.retire(generations.advance(), installed);

    generations.release(first);
    expect(uninstall).not.toHaveBeenCalled();
    generations.release(second);
    expect(uninstall).toHaveBeenCalledOnce();
  });

  it("settles an owed uninstall before the same plugin is installed again", () => {
    const uninstall = vi.fn();
    const generations = new RequestGenerations(uninstall);
    const reused = plugin("reused");
    const other = plugin("other");

    const inFlight = generations.admit();
    generations.retire(generations.advance(), [reused, other]);

    generations.uninstallBeforeReinstall(reused);
    expect(uninstall).toHaveBeenCalledWith([reused]);

    // The retired generation still owes only `other` when it drains.
    generations.release(inFlight);
    expect(uninstall).toHaveBeenLastCalledWith([other]);
    expect(uninstall).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// RouteTable
// ---------------------------------------------------------------------------

describe("RouteTable", () => {
  const logger = new DebugLogger(false);

  it("never changes a snapshot an admission holds (copy-on-write)", () => {
    const table = new RouteTable();
    table.define({ route: "GET /a", generator: "a", config: {}, logger });

    const snapshot = table.share();
    table.define({ route: "GET /b", generator: "b", config: {}, logger });

    expect(snapshot.routes.map((route) => route.path)).toEqual(["/a"]);
    expect([...snapshot.staticRoutes.keys()]).toEqual(["GET /a"]);
    expect(table.list().map((route) => route.path)).toEqual(["/a", "/b"]);
  });

  it("rolls a checkpoint back to exactly the table it started from", () => {
    const table = new RouteTable();
    table.define({ route: "GET /a", generator: "a", config: {}, logger });
    const shared = table.share();

    const checkpoint = table.checkpoint();
    table.define({ route: "GET /b", generator: "b", config: {}, logger });
    table.rollback(checkpoint);

    expect(table.list().map((route) => route.path)).toEqual(["/a"]);
    // The rolled-back containers are still the shared ones, so the next
    // registration copies them instead of editing an admission's snapshot.
    table.define({ route: "GET /c", generator: "c", config: {}, logger });
    expect(shared.routes.map((route) => route.path)).toEqual(["/a"]);
  });

  it("keeps the first of two routes that match the same requests", () => {
    const table = new RouteTable();
    table.define({ route: "GET /users/:id", generator: 1, config: {}, logger });
    table.define({
      route: "GET /users/:userId",
      generator: 2,
      config: {},
      logger,
    });
    table.define({ route: "GET /users/", generator: 3, config: {}, logger });
    table.define({ route: "GET /users", generator: 4, config: {}, logger });

    const snapshot = table.share();
    expect(table.list()).toEqual([
      { method: "GET", path: "/users/:id", hasParams: true },
      { method: "GET", path: "/users", hasParams: false },
    ]);
    // The first of the two static spellings is the one registered.
    expect(snapshot.staticRoutes.get("GET /users")?.generator).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// NodeServerController
// ---------------------------------------------------------------------------

describe("NodeServerController", () => {
  const logger = new DebugLogger(false);
  let controller: NodeServerController | undefined;

  afterEach(() => {
    controller?.close();
    controller = undefined;
  });

  it("refuses a second listen() synchronously", async () => {
    const release = vi.fn();
    controller = new NodeServerController({
      admitRequest: () => ({ handle: async () => okResponse(), release }),
      logger,
    });
    const started = controller.listen(0, "127.0.0.1");
    const running = controller;

    expect(schmockErrorCode(() => running.listen(0, "127.0.0.1"))).toBe(
      "SERVER_ALREADY_RUNNING",
    );
    await started;
  });

  it("cancels a start that close() interrupts", async () => {
    controller = new NodeServerController({
      admitRequest: () => ({
        handle: async () => okResponse(),
        release: () => {},
      }),
      logger,
    });
    const started = controller.listen(0, "127.0.0.1");
    controller.close();

    await expect(started).rejects.toMatchObject({
      code: "SERVER_START_CANCELLED",
    });
  });

  it("drops a server whose start close() cancelled before its listening callback ran", async () => {
    const running = new NodeServerController({
      admitRequest: () => ({
        handle: async () => okResponse(),
        release: () => {},
      }),
      logger,
    });
    controller = running;
    const originalListen = Server.prototype.listen;
    let created: Server | undefined;
    let bound: Promise<void> | undefined;
    // close() lands after the socket bound but before the controller's
    // listening callback runs. (On Node 26 a close() before the bind never
    // gets here: node:http's own close() cancels a bind still waiting on its
    // lookup.)
    const listenSpy = vi
      .spyOn(Server.prototype, "listen")
      .mockImplementationOnce(function (this: Server, ...args: unknown[]) {
        created = this;
        this.prependOnceListener("listening", () => running.close());
        Reflect.apply(originalListen, this, args);
        bound = new Promise((settle) => this.once("listening", settle));
        return this;
      });

    try {
      const started = running.listen(0, "127.0.0.1");
      await expect(started).rejects.toMatchObject({
        code: "SERVER_START_CANCELLED",
      });
      await bound;
      if (!created) throw new Error("Expected a created server");
      expect(created.listening).toBe(false);
    } finally {
      listenSpy.mockRestore();
    }

    const restarted = await running.listen(0, "127.0.0.1");
    expect(restarted.port).toBeGreaterThan(0);
  });

  it("admits each request on arrival and releases it once answered", async () => {
    const release = vi.fn();
    const admitRequest = vi.fn(() => ({
      handle: async () => okResponse(),
      release,
    }));
    controller = new NodeServerController({ admitRequest, logger });
    const { port } = await controller.listen(0, "127.0.0.1");

    const response = await fetch(`http://127.0.0.1:${port}/anything`);
    expect(await response.json()).toEqual({ ok: true });

    expect(admitRequest).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });
});

// ---------------------------------------------------------------------------
// The split request handler
// ---------------------------------------------------------------------------

describe("handle() after the split", () => {
  it("finalizes a failing generator with the route's delay and a history record", async () => {
    const mock = schmock({ delay: 0 });
    mock(
      "GET /fails/:id",
      () => {
        throw new Error("generator failed");
      },
      { delay: 30 },
    );

    const started = performance.now();
    const response = await mock.handle("GET", "/fails/7");

    expect(response.status).toBe(500);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(mock.lastRequest()).toMatchObject({
      method: "GET",
      path: "/fails/7",
      params: { id: "7" },
      response: { status: 500 },
    });
  });

  it("applies the delay a plugin set on this request's route copy only", async () => {
    const mock = schmock();
    mock("GET /slow", { ok: true }).pipe({
      name: "slower",
      process: (context, response) => {
        context.route.delay = 30;
        return { context, response };
      },
    });

    const started = performance.now();
    await mock.handle("GET", "/slow");
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(mock.getRoutes()).toEqual([
      { method: "GET", path: "/slow", hasParams: false },
    ]);
  });

  it("reports a namespace miss and a route miss as the same 404", async () => {
    const mock = schmock({ namespace: "/api" });
    mock("GET /users", []);
    const events: string[] = [];
    mock.on("request:notfound", ({ path }) => {
      events.push(path);
    });

    const outside = await mock.handle("GET", "/other/users");
    const unknown = await mock.handle("GET", "/api/unknown");

    expect([outside.status, unknown.status]).toEqual([404, 404]);
    expect(isRouteNotFound(outside) && isRouteNotFound(unknown)).toBe(true);
    expect(events).toEqual(["/other/users", "/api/unknown"]);
  });
});

// ---------------------------------------------------------------------------
// Route probe (review finding #128)
// ---------------------------------------------------------------------------

function routeProbe(
  admission: Schmock.RequestAdmission,
): (method: Schmock.HttpMethod, path: string) => unknown {
  const { hasRoute } = admission;
  if (hasRoute === undefined) {
    throw new Error("the admission carries no route probe");
  }
  return (method, path) => hasRoute.call(admission, method, path);
}

describe("the admission's route probe", () => {
  const namespaces = [undefined, "/", "/api", "/api/", "http://host.test/api"];
  const segments = [
    "api",
    "users",
    "1",
    "items",
    "tags",
    "café",
    "caf%C3%A9",
    "a b",
    "%2F",
    "",
  ];
  const methods: Schmock.HttpMethod[] = [
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "HEAD",
    "OPTIONS",
  ];

  function mockWith(namespace: string | undefined) {
    const mock = schmock(namespace === undefined ? {} : { namespace });
    mock("GET /users", []);
    mock("GET /users/:id", ({ params }) => ({ id: params.id }));
    mock("POST /items/:id/tags", { tagged: true });
    mock("PATCH /café", { ok: true });
    return mock;
  }

  it("agrees with handle() on every request", async () => {
    const mocks = namespaces.map((namespace) => mockWith(namespace));
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: mocks.length - 1 }),
        fc.constantFrom(...methods),
        fc.array(fc.constantFrom(...segments), { maxLength: 4 }),
        fc.boolean(),
        async (mockIndex, method, parts, trailingSlash) => {
          const path = `/${parts.join("/")}${trailingSlash ? "/" : ""}`;
          const admission = acquireRequestAdmission(mocks[mockIndex]);
          if (admission === undefined) throw new Error("no admission");
          try {
            const predicted = routeProbe(admission)(method, path);
            const response = await admission.handle(method, path);
            expect(predicted).toBe(!isRouteNotFound(response));
          } finally {
            admission.release();
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it.each([
    [undefined, "PATCH", "/café"],
    [undefined, "PATCH", "/caf%c3%a9/"],
    [undefined, "GET", "/users/a%2Fb"],
    [undefined, "GET", "/users/1/"],
    [undefined, "GET", "/Users"],
    ["/api/", "GET", "/api/users/"],
    ["/api/", "GET", "/api//users"],
    ["/api", "GET", "/apiv2/users"],
    ["/api", "GET", "/api"],
    ["/", "POST", "/items/7/tags"],
    ["http://host.test/api", "GET", "/api/users/42"],
    ["http://host.test/api", "GET", "/users/42"],
  ] satisfies Array<[string | undefined, Schmock.HttpMethod, string]>)(
    "agrees with handle() under namespace %s for %s %s",
    async (namespace, method, path) => {
      const admission = acquireRequestAdmission(mockWith(namespace));
      if (admission === undefined) throw new Error("no admission");
      try {
        const predicted = routeProbe(admission)(method, path);
        const response = await admission.handle(method, path);
        expect(predicted).toBe(!isRouteNotFound(response));
      } finally {
        admission.release();
      }
    },
  );

  it("answers from the routes the admission captured", () => {
    const mock = schmock();
    const admission = acquireRequestAdmission(mock);
    if (admission === undefined) throw new Error("no admission");
    mock("GET /late", { ok: true });

    try {
      expect(routeProbe(admission)("GET", "/late")).toBe(false);
    } finally {
      admission.release();
    }
    const later = acquireRequestAdmission(mock);
    if (later === undefined) throw new Error("no admission");
    expect(routeProbe(later)("GET", "/late")).toBe(true);
    later.release();
  });
});

describe("intercept() with the route probe", () => {
  let originalFetch: typeof globalThis.fetch;
  let network: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  let handles: Schmock.InterceptHandle[];

  const jsonPost = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    network = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("network"));
    globalThis.fetch = network;
    handles = [];
  });

  afterEach(() => {
    for (const handle of handles.reverse()) handle.restore();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("never reads the body of an unmocked passthrough request", async () => {
    const mock = schmock();
    mock("POST /api/items", { created: true });
    const events: string[] = [];
    for (const event of [
      "request:start",
      "request:notfound",
      "request:end",
    ] as const) {
      mock.on(event, () => {
        events.push(event);
      });
    }
    handles.push(mock.intercept());
    const clone = vi.spyOn(Request.prototype, "clone");

    const response = await fetch(
      "http://localhost/upload",
      jsonPost({ large: "x".repeat(1024) }),
    );

    expect(await response.text()).toBe("network");
    expect(clone).not.toHaveBeenCalled();
    expect(events).toEqual([
      "request:start",
      "request:notfound",
      "request:end",
    ]);
    const forwarded = network.mock.calls[0]?.[0];
    if (!(forwarded instanceof Request)) {
      throw new Error("expected the original Request to reach the network");
    }
    expect(await forwarded.json()).toEqual({ large: "x".repeat(1024) });
  });

  it("still reads the body of a request a route answers", async () => {
    const mock = schmock();
    mock("POST /api/items", ({ body }) => ({ received: body }));
    handles.push(mock.intercept());
    const clone = vi.spyOn(Request.prototype, "clone");

    const response = await fetch(
      "http://localhost/api/items",
      jsonPost({ name: "a" }),
    );

    expect(await response.json()).toEqual({ received: { name: "a" } });
    expect(clone).toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("still reads the body for a beforeRequest hook, which may reroute it", async () => {
    const mock = schmock();
    mock("POST /items", ({ body }) => ({ received: body }));
    handles.push(
      mock.intercept({
        beforeRequest: (request) => ({
          ...request,
          path: request.path.replace(/^\/v1/, ""),
        }),
      }),
    );

    const response = await fetch(
      "http://localhost/v1/items",
      jsonPost({ name: "b" }),
    );

    expect(await response.json()).toEqual({ received: { name: "b" } });
  });

  it("keeps the 400 for a malformed JSON body when passthrough is off", async () => {
    const mock = schmock();
    mock("POST /api/items", { created: true });
    handles.push(mock.intercept({ passthrough: false }));

    const response = await fetch("http://localhost/unmocked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "MALFORMED_JSON" });
  });

  it("probes with the method handle() sees, so a lowercase patch still routes", async () => {
    const mock = schmock();
    mock("PATCH /api/items/:id", ({ body, params }) => ({
      id: params.id,
      body,
    }));
    handles.push(mock.intercept());

    const response = await fetch("http://localhost/api/items/9", {
      method: "patch",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: true }),
    });

    expect(await response.json()).toEqual({ id: "9", body: { done: true } });
  });

  // Behaviour change: an unreadable body used to reject the fetch even when
  // no route could answer it. Unmocked, it now reaches the network untouched.
  it("passes an unreadable body to an unmocked URL through to the network", async () => {
    const mock = schmock();
    mock("POST /api/form", { ok: true });
    handles.push(mock.intercept());
    const multipart: RequestInit = {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "not multipart at all",
    };

    const unmocked = await fetch("http://localhost/elsewhere", multipart);
    expect(await unmocked.text()).toBe("network");

    await expect(
      fetch("http://localhost/api/form", multipart),
    ).rejects.toBeInstanceOf(TypeError);
  });

  // Behaviour change: the debug log of a request whose body was never read
  // reports no body.
  it("logs bodyType none for an unmocked request whose body was skipped", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "time").mockImplementation(() => {});
    vi.spyOn(console, "timeEnd").mockImplementation(() => {});
    const mock = schmock({ debug: true });
    mock("POST /api/items", { created: true });
    handles.push(mock.intercept());

    await fetch("http://localhost/upload", jsonPost({ a: 1 }));
    await fetch("http://localhost/api/items", jsonPost({ a: 1 }));

    const bodyTypes = log.mock.calls
      .filter(
        ([message]) =>
          typeof message === "string" && message.includes("[SCHMOCK:REQUEST]"),
      )
      .map(([message, data]) => [
        String(message).split("] ").pop(),
        isRecord(data) ? data.bodyType : undefined,
      ]);
    expect(bodyTypes).toEqual([
      ["POST /upload", "none"],
      ["POST /api/items", "object"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Cold-review fixes (2026-09-25)
// ---------------------------------------------------------------------------

describe("a hand-written admission passed to createFetchInterceptor", () => {
  let originalFetch: typeof globalThis.fetch;
  let lease: Schmock.InterceptHandle | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("network"));
  });

  afterEach(() => {
    lease?.restore();
    lease = undefined;
    globalThis.fetch = originalFetch;
  });

  function interceptWithRawAdmission(): void {
    const rawHandle: Schmock.MockRequestHandler = async () => ({
      status: 200,
      body: { answer: "from a hand-written admission" },
      headers: { connection: "close", "content-length": "999" },
    });
    const refuse: Schmock.MockRequestHandler = async () => {
      throw new Error("the admission's handle must answer");
    };
    lease = createFetchInterceptor(refuse, {}, () => ({
      handle: rawHandle,
      release() {},
    }));
  }

  it("has its responses normalized: framing headers are dropped", async () => {
    interceptWithRawAdmission();

    const response = await fetch("http://localhost/raw");

    expect(response.status).toBe(200);
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("content-length")).not.toBe("999");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      answer: "from a hand-written admission",
    });
  });

  it("has a HEAD body stripped", async () => {
    interceptWithRawAdmission();

    const response = await fetch("http://localhost/raw", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("connection")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("is asked for hasRoute, when it declares one, before the body is read", async () => {
    const asked: string[] = [];
    const handled: unknown[] = [];
    lease = createFetchInterceptor(
      async () => {
        throw new Error("the admission's handle must answer");
      },
      {},
      () => ({
        handle: async (_method, _path, options) => {
          handled.push(options?.body);
          return { status: 404, body: null, headers: {} };
        },
        release() {},
        hasRoute: (method, path) => {
          asked.push(`${method} ${path}`);
          return false;
        },
      }),
    );
    const clone = vi.spyOn(Request.prototype, "clone");

    await fetch("http://localhost/elsewhere", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skipped: true }),
    });

    expect(asked).toEqual(["POST /elsewhere"]);
    expect(handled).toEqual([undefined]);
    expect(clone).not.toHaveBeenCalled();
    clone.mockRestore();
  });
});

describe("static route data copied for plugins", () => {
  it("keeps an own __proto__ key as data once a plugin is piped", async () => {
    const data = JSON.parse('{"__proto__":{"isAdmin":true},"name":"x"}');
    const plain = schmock();
    plain("GET /f", data);
    const withPlugin = schmock();
    withPlugin("GET /f", data);
    const seen: unknown[] = [];
    withPlugin.pipe({
      name: "observer",
      process(context, response) {
        seen.push(
          typeof response === "object" && response !== null
            ? Reflect.get(response, "isAdmin")
            : "not an object",
        );
        return { context, response };
      },
    });

    const expected = (await plain.handle("GET", "/f")).body;
    const body: unknown = (await withPlugin.handle("GET", "/f")).body;

    if (typeof body !== "object" || body === null) {
      throw new Error("expected an object body");
    }
    expect(Object.hasOwn(body, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
    expect(JSON.stringify(body)).toBe(JSON.stringify(expected));
    expect(JSON.stringify(body)).toBe(
      '{"__proto__":{"isAdmin":true},"name":"x"}',
    );
    expect(seen).toEqual([undefined]);
  });
});
