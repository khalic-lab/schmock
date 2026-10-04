import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schmock } from "./index";

const USERS = [{ id: 1, name: "Ada" }];

function observer(name: string, sink: any[], order?: string[]) {
  return {
    name,
    process: (context: any, response: any) => ({ context, response }),
    onExchange(exchange: any) {
      order?.push(name);
      sink.push(exchange);
    },
  };
}

function gate() {
  let release!: () => void;
  let started!: () => void;
  const opened = new Promise<void>((r) => {
    release = r;
  });
  const routeStarted = new Promise<void>((r) => {
    started = r;
  });
  return { opened, release, started, routeStarted };
}

describe("exchange observation through intercept()", () => {
  const originalFetch = globalThis.fetch;
  let network: ReturnType<typeof vi.fn>;
  const handles: { restore(): void }[] = [];

  beforeEach(() => {
    network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("network"));
    globalThis.fetch = network as typeof fetch;
  });

  afterEach(() => {
    for (const handle of handles.splice(0).reverse()) handle.restore();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    performance.clearMeasures();
  });

  function intercepted(mock: ReturnType<typeof schmock>) {
    const handle = mock.intercept();
    handles.push(handle);
    return handle;
  }

  it("observes when the plugin is piped before intercept()", async () => {
    const seen: any[] = [];
    const mock = schmock();
    mock("GET /api/users", USERS);
    mock.pipe(observer("obs", seen));
    intercepted(mock);

    const res = await fetch("http://localhost/api/users");

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].outcome).toBe("answered");
    expect(seen[0].response.status).toBe(200);
    expect(seen[0].response.body).toEqual(USERS);
    expect(seen[0].request.url).toBe("http://localhost/api/users");
  });

  it("observes when the plugin is piped after intercept() but before the fetch", async () => {
    const seen: any[] = [];
    const mock = schmock();
    mock("GET /api/users", USERS);
    intercepted(mock);
    mock.pipe(observer("obs", seen));

    await fetch("http://localhost/api/users");

    expect(seen).toHaveLength(1);
  });

  it("does not show a request to a plugin piped after the request arrived", async () => {
    const seen: any[] = [];
    const g = gate();
    const mock = schmock();
    mock("GET /api/slow", async () => {
      g.started();
      await g.opened;
      return USERS;
    });
    intercepted(mock);

    const first = fetch("http://localhost/api/slow");
    await g.routeStarted;
    mock.pipe(observer("late", seen));
    g.release();
    const res = await first;

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);

    const second = await fetch("http://localhost/api/slow");
    expect(second.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("shows an in-flight request only to the observers piped when it arrived", async () => {
    const a: any[] = [];
    const b: any[] = [];
    const g = gate();
    const mock = schmock();
    mock("GET /api/slow", async () => {
      g.started();
      await g.opened;
      return USERS;
    });
    mock.pipe(observer("A", a));
    intercepted(mock);

    const first = fetch("http://localhost/api/slow");
    await g.routeStarted;
    mock.pipe(observer("B", b));
    g.release();
    const res = await first;

    expect(res.status).toBe(200);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);

    const second = await fetch("http://localhost/api/slow");
    expect(second.status).toBe(200);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });

  it("runs observers in pipe order with distinct frozen snapshots", async () => {
    const order: string[] = [];
    const a: any[] = [];
    const b: any[] = [];
    const mock = schmock();
    mock("GET /api/users", USERS);
    mock.pipe(observer("A", a, order)).pipe(observer("B", b, order));
    intercepted(mock);

    await fetch("http://localhost/api/users");

    expect(order).toEqual(["A", "B"]);
    expect(a[0]).not.toBe(b[0]);
    expect(a[0]).toEqual(b[0]);
    for (const ex of [a[0], b[0]]) {
      expect(Object.isFrozen(ex)).toBe(true);
      expect(Object.isFrozen(ex.request)).toBe(true);
      expect(Object.isFrozen(ex.request.headers)).toBe(true);
      expect(Object.isFrozen(ex.response)).toBe(true);
      expect(Object.isFrozen(ex.response.headers)).toBe(true);
    }
  });

  it("answers an in-flight request after reset() without observing it or running onExchange after uninstall", async () => {
    const log: string[] = [];
    const q: any[] = [];
    const g = gate();
    const mock = schmock();
    mock("GET /api/slow", async () => {
      g.started();
      await g.opened;
      return USERS;
    });
    mock.pipe({
      name: "P",
      process: (context: any, response: any) => ({ context, response }),
      onExchange: () => {
        log.push("exchange");
      },
      uninstall: () => {
        log.push("uninstall");
      },
    });
    intercepted(mock);

    const inflight = fetch("http://localhost/api/slow");
    await g.routeStarted;
    mock.reset();
    mock("GET /api/slow", USERS);
    mock.pipe(observer("Q", q));
    g.release();
    const res = await inflight;

    expect(res.status).toBe(200);
    expect(log).toEqual(["uninstall"]);
    expect(q).toHaveLength(0);
  });

  it("keeps answering unobserved after reset() until a plugin is re-piped", async () => {
    const seen: any[] = [];
    const P = observer("P", seen);
    const mock = schmock();
    mock("GET /api/users", USERS);
    mock.pipe(P);
    intercepted(mock);

    mock.reset();
    mock("GET /api/users", USERS);
    const res = await fetch("http://localhost/api/users");
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);

    mock.pipe(P);
    await fetch("http://localhost/api/users");
    expect(seen).toHaveLength(1);
  });

  it("never observes mock.handle()", async () => {
    const seen: any[] = [];
    const mock = schmock();
    mock("GET /api/users", USERS);
    mock.pipe(observer("obs", seen));
    intercepted(mock);

    await mock.handle("GET", "/api/users");

    expect(seen).toHaveLength(0);
  });

  it("only the answering mock observes", async () => {
    const aSeen: any[] = [];
    const bSeen: any[] = [];
    const a = schmock();
    a("GET /api/users", USERS);
    a.pipe(observer("A", aSeen));
    intercepted(a);
    const b = schmock();
    b.pipe(observer("B", bSeen));
    intercepted(b);

    const res = await fetch("http://localhost/api/users");

    expect(res.status).toBe(200);
    expect(aSeen).toHaveLength(1);
    expect(bSeen).toHaveLength(0);
  });

  it("behaves as before when no plugin has onExchange", async () => {
    const process = vi.fn((context: any, response: any) => ({
      context,
      response,
    }));
    const mock = schmock();
    mock("GET /api/users", USERS);
    mock.pipe({ name: "plain", process });
    const events: string[] = [];
    for (const name of [
      "request:start",
      "request:match",
      "request:notfound",
      "request:end",
    ] as const) {
      mock.on(name, () => {
        events.push(name);
      });
    }
    intercepted(mock);

    const miss = await fetch("http://localhost/api/other");
    expect(await miss.text()).toBe("network");
    const hit = await fetch("http://localhost/api/users");
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual(USERS);

    expect(events).toEqual([
      "request:start",
      "request:notfound",
      "request:end",
      "request:start",
      "request:match",
      "request:end",
    ]);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("builds no exchange when no plugin has onExchange", async () => {
    const mock = schmock();
    mock("GET /api/users", USERS);
    mock.pipe({
      name: "plain",
      process: (context: any, response: any) => ({ context, response }),
    });
    intercepted(mock);
    const enumerated = vi.spyOn(Headers.prototype, "forEach");

    const unobserved = await fetch("http://localhost/api/users");
    expect(enumerated.mock.contexts).not.toContain(unobserved.headers);
    expect(unobserved.status).toBe(200);

    // Control: an observed exchange records the caller's response headers.
    mock.pipe(observer("obs", []));
    const observed = await fetch("http://localhost/api/users");
    expect(enumerated.mock.contexts).toContain(observed.headers);
  });

  it("logs a throwing observer in debug mode and leaves the response unchanged", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "time").mockImplementation(() => {});
    vi.spyOn(console, "timeEnd").mockImplementation(() => {});
    const mock = schmock({ debug: true });
    mock("GET /api/users", USERS);
    mock.pipe({
      name: "thrower",
      process: (context: any, response: any) => ({ context, response }),
      onExchange() {
        throw new Error("observer failed");
      },
    });
    intercepted(mock);

    const res = await fetch("http://localhost/api/users");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(USERS);
    const logged = logSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("[SCHMOCK:PLUGIN]") &&
        call[0].includes("Plugin thrower onExchange failed: observer failed"),
    );
    expect(logged).toBeDefined();
  });
  it("reports the request body as sent, whatever the hook and the route do to it in place", async () => {
    const seen: any[] = [];
    const mock = schmock();
    mock("POST /api/items", ({ body }: any) => {
      body.routeTouched = true;
      return { ok: true };
    });
    mock.pipe(observer("obs", seen));
    handles.push(
      mock.intercept({
        beforeRequest: (request) => {
          Reflect.set(request.body as object, "hookTouched", true);
          return request;
        },
      }),
    );

    await fetch("http://localhost/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a" }),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].request.body).toEqual({ name: "a" });
  });

  it("stops reporting to observers that a reset() inside an earlier observer uninstalled", async () => {
    const order: string[] = [];
    const mock = schmock();
    mock("GET /api/users", USERS);
    mock.pipe({
      name: "a",
      process: (context: any, response: any) => ({ context, response }),
      onExchange() {
        order.push("a.onExchange");
        mock.reset();
      },
      uninstall() {
        order.push("a.uninstall");
      },
    });
    mock.pipe({
      name: "b",
      process: (context: any, response: any) => ({ context, response }),
      onExchange() {
        order.push("b.onExchange");
      },
      uninstall() {
        order.push("b.uninstall");
      },
    });
    intercepted(mock);

    await fetch("http://localhost/api/users");

    expect(order).toContain("a.onExchange");
    expect(order).not.toContain("b.onExchange");
  });

  it.each(["beforeRequest", "beforeResponse"] as const)(
    "reports a %s hook error as failed when an abort lands one microtask later",
    async (hook) => {
      const seen: any[] = [];
      const mock = schmock();
      mock("GET /api/users", USERS);
      const controller = new AbortController();
      let abortedWhenObserved: boolean | undefined;
      mock.pipe({
        ...observer("obs", seen),
        onExchange(exchange: any) {
          abortedWhenObserved = controller.signal.aborted;
          seen.push(exchange);
        },
      });
      const hookError = new Error("hook failed");
      handles.push(
        mock.intercept({
          [hook]: () => {
            void Promise.resolve()
              .then(() => {})
              .then(() => controller.abort());
            throw hookError;
          },
        }),
      );
      await expect(
        fetch("http://localhost/api/users", { signal: controller.signal }),
      ).rejects.toBe(hookError);
      // The abort must land before observation, or this proves nothing.
      expect(abortedWhenObserved).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ outcome: "failed", error: hookError });
    },
  );
});
