import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schmock } from "./index.js";
import * as interceptor from "./interceptor.js";
import {
  acquireFetchRelay,
  createFetchLease,
  routeRelayedRequest,
} from "./interceptor.js";

const USERS = [{ id: 1, name: "Ada" }];
const URL_USERS = "http://localhost/api/users";

describe("fetch relay hold and router", () => {
  let originalFetch: typeof globalThis.fetch;
  let baseline: ReturnType<typeof vi.fn>;
  let mock: Schmock.CallableMockInstance;
  let holds: Schmock.FetchRelay[];
  let handles: Schmock.InterceptHandle[];
  let gates: Array<() => void>;

  const lease = (
    target: Schmock.CallableMockInstance = mock,
    options?: Schmock.InterceptOptions,
  ) => {
    const handle = target.intercept(options);
    handles.push(handle);
    return handle;
  };
  const hold = () => {
    const h = acquireFetchRelay();
    holds.push(h);
    return h;
  };
  const gate = () => {
    let release = () => {};
    const promise = new Promise<void>((r) => {
      release = r;
    });
    gates.push(release);
    return { promise, release };
  };
  const track = (target: Schmock.CallableMockInstance = mock) => {
    const events: string[] = [];
    for (const name of [
      "request:start",
      "request:match",
      "request:notfound",
      "request:end",
    ] as const) {
      target.on(name, () => {
        events.push(name);
      });
    }
    return events;
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    baseline = vi.fn(async () => new Response("network"));
    globalThis.fetch = baseline;
    mock = schmock();
    holds = [];
    handles = [];
    gates = [];
  });

  afterEach(() => {
    for (const release of gates) release();
    for (const h of holds) h.release();
    for (const h of handles.reverse()) h.restore();
    globalThis.fetch = originalFetch;
  });

  it("F1 a hold forwards the raw input and init to the baseline", async () => {
    mock("GET /api/users", USERS);
    lease();
    const events = track();
    hold();
    const init = { headers: { "x-trace": "abc" } };

    const res = await fetch(URL_USERS, init);
    expect(await res.text()).toBe("network");
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(baseline.mock.calls[0][0]).toBe(URL_USERS);
    expect(baseline.mock.calls[0][1]).toBe(init);
    expect(mock.callCount()).toBe(0);
    expect(events).toEqual([]);

    const req = new Request(URL_USERS);
    await fetch(req);
    expect(baseline.mock.calls[1][0]).toBe(req);
    expect(baseline.mock.calls[1][1]).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("F2 a held fetch skips request normalization", async () => {
    mock("GET /x", USERS);
    lease();
    hold();
    const init = { method: "GET", body: "x" };
    const res = await fetch("http://localhost/x", init);
    expect(await res.text()).toBe("network");
    expect(baseline.mock.calls[0][1]).toBe(init);
  });

  it("F3 two holds need two releases", async () => {
    mock("GET /api/users", USERS);
    lease();
    const h1 = hold();
    const h2 = hold();

    h1.release();
    expect(await (await fetch(URL_USERS)).text()).toBe("network");
    expect(baseline).toHaveBeenCalledTimes(1);

    h2.release();
    const res = await fetch(URL_USERS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(USERS);
    expect(baseline).toHaveBeenCalledTimes(1);
  });

  it("F4 release is idempotent and scoped to its own hold", async () => {
    mock("GET /api/users", USERS);
    lease();
    const h1 = hold();
    const h2 = hold();
    h1.release();
    h1.release();
    expect(await (await fetch(URL_USERS)).text()).toBe("network");
    expect(h1.active).toBe(false);
    expect(h2.active).toBe(true);
  });

  it("F5 active reflects acquire and release", async () => {
    mock("GET /api/users", USERS);
    lease();
    const h = hold();
    expect(h.active).toBe(true);
    // behavioural anchor: the hold is really in force
    expect(await (await fetch(URL_USERS)).text()).toBe("network");
    h.release();
    expect(h.active).toBe(false);
    h.release();
    expect(h.active).toBe(false);
    expect((await fetch(URL_USERS)).status).toBe(200);
  });

  it("F6 the hold never touches globalThis.fetch", async () => {
    const before = globalThis.fetch;
    const h = hold();
    expect(globalThis.fetch).toBe(before);
    h.release();
    expect(globalThis.fetch).toBe(before);

    mock("GET /api/users", USERS);
    const handle = lease();
    const patched = globalThis.fetch;
    expect(patched).not.toBe(baseline);
    hold();
    expect(globalThis.fetch).toBe(patched);
    handle.restore();
    expect(globalThis.fetch).toBe(baseline);
    // behavioural anchor: the hold forwards raw to the baseline
    await fetch(URL_USERS);
    expect(baseline).toHaveBeenCalledTimes(1);
  });

  it("F7 a lease taken while held is forwarded", async () => {
    mock("GET /api/users", USERS);
    hold();
    lease();
    const init = { headers: { a: "b" } };
    await fetch(URL_USERS, init);
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(baseline.mock.calls[0][0]).toBe(URL_USERS);
    expect(baseline.mock.calls[0][1]).toBe(init);
    expect(mock.callCount()).toBe(0);
  });

  it("F8 a captured dispatcher obeys holds", async () => {
    mock("GET /api/users", USERS);
    lease();
    const dispatcher = globalThis.fetch;
    globalThis.fetch = vi.fn((i, n) => dispatcher(i, n));
    hold();
    const res = await dispatcher(URL_USERS);
    expect(await res.text()).toBe("network");
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(mock.callCount()).toBe(0);
  });

  it("F9 routes an answered request, with and without a hold", async () => {
    mock("GET /api/users", USERS);
    lease();

    const plain = await routeRelayedRequest(new Request(`${URL_USERS}#frag`));
    expect(plain?.status).toBe(200);
    expect(await plain?.json()).toEqual(USERS);
    expect(plain?.url).toBe(URL_USERS);

    hold();
    const held = await routeRelayedRequest(new Request(`${URL_USERS}#frag`));
    expect(held?.status).toBe(200);
    expect(await held?.json()).toEqual(USERS);
    expect(held?.url).toBe(URL_USERS);
    expect(baseline).not.toHaveBeenCalled();
  });

  it("F10 resolves undefined on a route miss and never hits the baseline", async () => {
    mock("GET /api/users", USERS);
    lease();
    const hit = await routeRelayedRequest(new Request(URL_USERS));
    expect(hit?.status).toBe(200);
    const miss = await routeRelayedRequest(
      new Request("http://localhost/api/other"),
    );
    expect(miss).toBeUndefined();
    expect(baseline).not.toHaveBeenCalled();
  });

  it("F11 resolves undefined with no session, even when pre-aborted", async () => {
    mock("GET /api/users", USERS);
    // positive control: a lease answers, restoring it removes the answer
    const handle = lease();
    expect((await routeRelayedRequest(new Request(URL_USERS)))?.status).toBe(
      200,
    );
    handle.restore();

    expect(await routeRelayedRequest(new Request(URL_USERS))).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    expect(
      await routeRelayedRequest(
        new Request(URL_USERS, { signal: controller.signal }),
      ),
    ).toBeUndefined();
  });

  it("F12 passthrough false answers a miss with 404 ROUTE_NOT_FOUND", async () => {
    mock("GET /api/users", USERS);
    lease(mock, { passthrough: false });
    const res = await routeRelayedRequest(
      new Request("http://localhost/api/other"),
    );
    expect(res?.status).toBe(404);
    expect(await res?.json()).toMatchObject({ code: "ROUTE_NOT_FOUND" });
  });

  it("F13 abort mid-handle rejects AbortError and ends with 499", async () => {
    const g = gate();
    let announce = () => {};
    const started = new Promise<void>((r) => {
      announce = r;
    });
    mock("GET /api/slow", async () => {
      announce();
      await g.promise;
      return { ok: true };
    });
    const statuses: number[] = [];
    mock.on("request:end", (e) => {
      statuses.push(e.status);
    });
    lease();

    const controller = new AbortController();
    const pending = routeRelayedRequest(
      new Request("http://localhost/api/slow", { signal: controller.signal }),
    );
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await started;
    controller.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(statuses).toEqual([499]), { timeout: 2000 });
  });

  it("F14 a pre-aborted request with a lease rejects and emits no start", async () => {
    mock("GET /api/users", USERS);
    lease();
    const events = track();
    const controller = new AbortController();
    controller.abort();
    await expect(
      routeRelayedRequest(
        new Request(URL_USERS, { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(events).not.toContain("request:start");
  });

  it("F15 two leases of one mock consult it once per call", async () => {
    mock("GET /api/users", USERS);
    lease();
    lease();
    const events = track();

    expect(
      await routeRelayedRequest(new Request("http://localhost/api/other")),
    ).toBeUndefined();
    expect(events).toEqual([
      "request:start",
      "request:notfound",
      "request:end",
    ]);

    events.length = 0;
    const a = await routeRelayedRequest(new Request(URL_USERS));
    const b = await routeRelayedRequest(new Request(URL_USERS));
    expect(a?.status).toBe(200);
    expect(b?.status).toBe(200);
    expect(events.filter((e) => e === "request:start")).toHaveLength(2);
  });

  it("F16 an origin-form baseUrl matches the request origin", async () => {
    mock("GET /api/users", USERS);
    const matching = lease(mock, { baseUrl: "http://localhost/api" });
    expect((await routeRelayedRequest(new Request(URL_USERS)))?.status).toBe(
      200,
    );
    matching.restore();

    const other = schmock();
    other("GET /api/users", USERS);
    lease(other, { baseUrl: "http://example.test/api" });
    // a lease for another origin does not answer this one
    expect(await routeRelayedRequest(new Request(URL_USERS))).toBeUndefined();
  });

  it("F17 a JSON body reaches the route and the caller's body stays unread", async () => {
    mock("POST /api/echo", ({ body }) => body);
    lease();
    const request = new Request("http://localhost/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"Ada"}',
    });
    const res = await routeRelayedRequest(request);
    expect(await res?.json()).toEqual({ name: "Ada" });
    expect(request.bodyUsed).toBe(false);
  });

  it("F18 a hook error rejects with the identical error", async () => {
    mock("GET /api/users", USERS);
    const hookError = new Error("hook failed");
    lease(mock, {
      beforeResponse: () => {
        throw hookError;
      },
    });
    const caught = await routeRelayedRequest(new Request(URL_USERS)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBe(hookError);
  });

  it("F19 an observer opener on the lease sees the answered exchange", async () => {
    mock("GET /api/users", USERS);
    const observer = vi.fn();
    const opener = vi.fn(() => observer);
    handles.push(
      createFetchLease({
        handle: (m, p, o) => mock.handle(m, p, o),
        observe: opener,
      }),
    );
    const t0 = performance.now();
    await routeRelayedRequest(new Request(`${URL_USERS}#x`));
    expect(opener).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(1);
    const exchange = observer.mock.calls[0][0];
    expect(exchange.outcome).toBe("answered");
    expect(exchange.response.status).toBe(200);
    expect(exchange.request.url).toBe(URL_USERS);
    expect(exchange.startTime).toBeGreaterThanOrEqual(t0);
    expect(exchange.startTime).toBeLessThanOrEqual(exchange.endTime);
  });

  it("F20 routes through the newest session only", async () => {
    const a = schmock();
    a("GET /a", { who: "a" });
    lease(a);
    globalThis.fetch = vi.fn(async () => new Response("third party"));
    const b = schmock();
    b("GET /b", { who: "b" });
    lease(b);

    const hitB = await routeRelayedRequest(new Request("http://localhost/b"));
    expect(hitB?.status).toBe(200);
    expect(
      await routeRelayedRequest(new Request("http://localhost/a")),
    ).toBeUndefined();
  });

  it("F21 the adapter entry re-exports the relay functions", async () => {
    const adapter = await import("./adapter.js");
    expect(Object.keys(adapter).sort()).toEqual([
      "abortReason",
      "acquireFetchRelay",
      "acquireRequestAdmission",
      "awaitWithAbort",
      "createFetchInterceptor",
      "routeRelayedRequest",
    ]);
    expect(adapter.acquireFetchRelay).toBe(interceptor.acquireFetchRelay);
    expect(adapter.routeRelayedRequest).toBe(interceptor.routeRelayedRequest);

    mock("GET /api/users", USERS);
    lease();
    const res = await adapter.routeRelayedRequest(new Request(URL_USERS));
    expect(res?.status).toBe(200);
  });
});
