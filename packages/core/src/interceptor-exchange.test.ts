import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRequestAdmission } from "./admission.js";
import { schmock } from "./index.js";
import { createFetchInterceptor, createFetchLease } from "./interceptor.js";

const USERS = [{ id: 1, name: "Ada" }];

function admit(mock: Schmock.CallableMockInstance): Schmock.RequestAdmission {
  const admission = acquireRequestAdmission(mock);
  if (admission === undefined)
    throw new Error("expected a schmock() admission");
  return admission;
}

function gate() {
  let release: () => void = () => {};
  let started: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hasStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  return { release, started, released, hasStarted };
}

function hangingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createFetchLease exchange observation", () => {
  let originalFetch: typeof globalThis.fetch;
  let network: ReturnType<typeof vi.fn<typeof fetch>>;
  let handles: Schmock.InterceptHandle[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    network = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("network"));
    globalThis.fetch = network;
    handles = [];
  });

  afterEach(() => {
    for (const handle of [...handles].reverse()) {
      try {
        handle.restore();
      } catch {
        // already restored
      }
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    performance.clearMeasures();
  });

  function lease(
    mock: Schmock.CallableMockInstance,
    options?: Schmock.InterceptOptions,
    opener?: () => ((exchange: Schmock.Exchange) => void) | undefined,
    owner: symbol = Symbol("owner"),
    admitRequest: () => Schmock.RequestAdmission = () => admit(mock),
  ): Schmock.InterceptHandle {
    const handle = createFetchLease({
      handle: (m, p, o) => mock.handle(m, p, o),
      options,
      admitRequest,
      owner,
      observe: opener,
    });
    handles.push(handle);
    return handle;
  }

  function recorder() {
    const observer = vi.fn();
    const opener = vi.fn(() => observer);
    return { observer, opener };
  }

  function usersMock(): Schmock.CallableMockInstance {
    const mock = schmock();
    mock("GET /api/users", USERS);
    return mock;
  }

  function lastExchange(observer: ReturnType<typeof vi.fn>): Schmock.Exchange {
    return observer.mock.calls[0][0];
  }

  describe("A. the opener", () => {
    it("is called once and the observer once for one routed GET", async () => {
      const { observer, opener } = recorder();
      lease(usersMock(), undefined, opener);
      await fetch("http://localhost/api/users");
      expect(opener).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledTimes(1);
    });

    it("is called synchronously before the lease runs", async () => {
      const mock = usersMock();
      const log: string[] = [];
      const observer = vi.fn();
      const opener = () => {
        log.push("open");
        queueMicrotask(() => log.push("microtask"));
        return observer;
      };
      lease(mock, undefined, opener, Symbol("o"), () => {
        log.push("admit");
        return admit(mock);
      });
      await fetch("http://localhost/api/users");
      expect(log.slice(0, 3)).toEqual(["open", "admit", "microtask"]);
    });

    it("is never called for a pre-aborted signal", async () => {
      const { opener } = recorder();
      lease(usersMock(), undefined, opener);
      await expect(
        fetch("http://localhost/api/users", { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(opener).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    });

    it("is not called with zero leases", async () => {
      const { opener } = recorder();
      const handle = lease(usersMock(), undefined, opener);
      handle.restore();
      const res = await fetch("http://localhost/api/users");
      expect(await res.text()).toBe("network");
      expect(opener).not.toHaveBeenCalled();
      expect(network).toHaveBeenCalledTimes(1);
    });
  });

  describe("B. answered", () => {
    it("reports the exchange the caller's Response corresponds to", async () => {
      const { observer, opener } = recorder();
      lease(usersMock(), undefined, opener);
      const res = await fetch("http://localhost/api/users?page=2#top", {
        headers: { "X-Trace": "abc" },
      });
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(Object.keys(exchange).sort()).toEqual([
        "endTime",
        "outcome",
        "request",
        "response",
        "startTime",
      ]);
      expect(exchange.outcome).toBe("answered");
      expect(exchange.request.method).toBe("GET");
      expect(exchange.request.url).toBe("http://localhost/api/users?page=2");
      expect(exchange.request.headers["x-trace"]).toBe("abc");
      for (const key of Object.keys(exchange.request.headers)) {
        expect(key).toBe(key.toLowerCase());
      }
      expect("body" in exchange.request).toBe(false);
      expect(exchange.response.status).toBe(200);
      expect(exchange.response.headers["content-type"]).toBe(
        "application/json",
      );
      expect(exchange.response.body).toEqual(USERS);
      expect(res.status).toBe(200);
      expect(res.bodyUsed).toBe(false);
      expect(await res.json()).toEqual(USERS);
    });

    it("takes startTime before the lease runs and endTime after", async () => {
      const mock = schmock();
      let inRoute = -1;
      mock("GET /api/users", () => {
        inRoute = performance.now();
        return USERS;
      });
      const { observer, opener } = recorder();
      lease(mock, undefined, opener);
      const before = performance.now();
      await fetch("http://localhost/api/users");
      const after = performance.now();
      expect(observer).toHaveBeenCalledTimes(1);
      const { startTime, endTime } = lastExchange(observer);
      expect(before).toBeLessThanOrEqual(startTime);
      expect(startTime).toBeLessThanOrEqual(inRoute);
      expect(inRoute).toBeLessThanOrEqual(endTime);
      expect(endTime).toBeLessThanOrEqual(after);
    });

    it("reports a beforeResponse rewrite", async () => {
      const { observer, opener } = recorder();
      lease(
        usersMock(),
        {
          beforeResponse: (r) => ({
            ...r,
            status: 202,
            headers: { ...r.headers, "X-Hooked": "yes" },
            body: { hooked: true },
          }),
        },
        opener,
      );
      const res = await fetch("http://localhost/api/users");
      expect(res.status).toBe(202);
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("answered");
      expect(exchange.response.status).toBe(202);
      expect(exchange.response.headers["x-hooked"]).toBe("yes");
      expect(exchange.response.body).toEqual({ hooked: true });
    });

    it("reports the errorFormatter body of a thrown route", async () => {
      const mock = schmock();
      mock("GET /api/users", () => {
        throw new Error("boom");
      });
      const { observer, opener } = recorder();
      lease(mock, { errorFormatter: () => ({ formatted: true }) }, opener);
      await fetch("http://localhost/api/users");
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("answered");
      expect(exchange.response.status).toBe(500);
      expect(exchange.response.body).toEqual({ formatted: true });
    });

    it("reports the unrouted 404 with passthrough off", async () => {
      const { observer, opener } = recorder();
      lease(usersMock(), { passthrough: false }, opener);
      const res = await fetch("http://localhost/api/missing");
      expect(res.status).toBe(404);
      expect(network).not.toHaveBeenCalled();
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("answered");
      expect(exchange.response.status).toBe(404);
      expect(exchange.response.body).toEqual({
        error: "No matching mock route found",
        code: "ROUTE_NOT_FOUND",
      });
    });

    it("reports a non-standard method as a 404 with the method as sent", async () => {
      const { observer, opener } = recorder();
      lease(usersMock(), { passthrough: false }, opener);
      await fetch("http://localhost/api/users", { method: "PROPFIND" });
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("answered");
      expect(exchange.response.status).toBe(404);
      expect(exchange.response.body).toMatchObject({ code: "ROUTE_NOT_FOUND" });
      expect(exchange.request.method).toBe("PROPFIND");
    });

    it("reports a malformed JSON 400 with the raw request text", async () => {
      const mock = schmock();
      mock("POST /api/users", ({ body }: { body: unknown }) => body);
      const { observer, opener } = recorder();
      lease(mock, { passthrough: false }, opener);
      await fetch("http://localhost/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{oops",
      });
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("answered");
      expect(exchange.response.status).toBe(400);
      expect(exchange.response.body).toEqual({
        error: "Malformed JSON request body",
        code: "MALFORMED_JSON",
      });
      expect(exchange.request.body).toBe("{oops");
    });

    it("reports the request body as read before beforeRequest", async () => {
      const mock = schmock();
      mock("POST /api/users", ({ body }: { body: unknown }) => body);
      const { observer, opener } = recorder();
      lease(
        mock,
        { beforeRequest: (r) => ({ ...r, body: { name: "Changed" } }) },
        opener,
      );
      await fetch("http://localhost/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.request.body).toEqual({ name: "Ada" });
      expect(exchange.response.body).toEqual({ name: "Changed" });
    });

    it("omits the response body key for a 204", async () => {
      const mock = schmock();
      mock("DELETE /api/users/1", () => [204, undefined]);
      const { observer, opener } = recorder();
      lease(mock, undefined, opener);
      await fetch("http://localhost/api/users/1", { method: "DELETE" });
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("answered");
      expect(exchange.response.status).toBe(204);
      expect("body" in exchange.response).toBe(false);
    });

    it("notifies only the answering mock of two leases", async () => {
      const a = recorder();
      const b = recorder();
      lease(usersMock(), undefined, a.opener, Symbol("a"));
      lease(schmock(), undefined, b.opener, Symbol("b"));
      await fetch("http://localhost/api/users");
      expect(b.opener).toHaveBeenCalledTimes(1);
      expect(b.observer).toHaveBeenCalledTimes(0);
      expect(a.observer).toHaveBeenCalledTimes(1);
      expect(lastExchange(a.observer).outcome).toBe("answered");
    });

    it("never notifies a FILTERED lease", async () => {
      const a = recorder();
      const b = recorder();
      lease(usersMock(), undefined, a.opener, Symbol("a"));
      lease(schmock(), { baseUrl: "/other" }, b.opener, Symbol("b"));
      await fetch("http://localhost/api/users");
      expect(b.opener).toHaveBeenCalledTimes(1);
      expect(b.observer).toHaveBeenCalledTimes(0);
      expect(a.observer).toHaveBeenCalledTimes(1);
    });

    it("never notifies an ALREADY_CONSULTED lease", async () => {
      const mock = schmock();
      mock("GET /api/users", USERS);
      const owner = Symbol("shared");
      const o1 = recorder();
      const o2 = recorder();
      lease(mock, { passthrough: false }, o1.opener, owner);
      lease(mock, {}, o2.opener, owner);
      const res = await fetch("http://localhost/api/missing");
      expect(await res.text()).toBe("network");
      expect(o1.opener).toHaveBeenCalledTimes(1);
      expect(o1.observer).toHaveBeenCalledTimes(0);
      expect(o2.observer).toHaveBeenCalledTimes(0);
    });
  });

  describe("C. failed", () => {
    it("reports a throwing beforeResponse with the identical error", async () => {
      const hookError = new Error("hook failed");
      const { observer, opener } = recorder();
      lease(
        usersMock(),
        {
          beforeResponse: () => {
            throw hookError;
          },
        },
        opener,
      );
      await expect(fetch("http://localhost/api/users")).rejects.toBe(hookError);
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("failed");
      expect(exchange.error).toBe(hookError);
      expect(Object.keys(exchange).sort()).toEqual([
        "endTime",
        "error",
        "outcome",
        "request",
        "startTime",
      ]);
    });

    it("reports a throwing beforeRequest with the body as read", async () => {
      const reqError = new Error("request hook failed");
      const mock = schmock();
      mock("POST /api/users", USERS);
      const { observer, opener } = recorder();
      lease(
        mock,
        {
          beforeRequest: () => {
            throw reqError;
          },
        },
        opener,
      );
      await expect(
        fetch("http://localhost/api/users", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Ada" }),
        }),
      ).rejects.toBe(reqError);
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("failed");
      expect(exchange.error).toBe(reqError);
      expect(exchange.request.body).toEqual({ name: "Ada" });
    });

    it("reports a throwing errorFormatter", async () => {
      const formatterError = new Error("formatter failed");
      const mock = usersMock();
      const { observer, opener } = recorder();
      lease(
        mock,
        {
          beforeResponse: () => {
            throw new Error("boom");
          },
          errorFormatter: () => {
            throw formatterError;
          },
        },
        opener,
      );
      await expect(fetch("http://localhost/api/users")).rejects.toBe(
        formatterError,
      );
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("failed");
      expect(exchange.error).toBe(formatterError);
    });
  });

  describe("D. aborted", () => {
    function slowMock() {
      const g = gate();
      const mock = schmock();
      mock("GET /api/users", async () => {
        g.started();
        await g.released;
        return USERS;
      });
      return { mock, g };
    }

    it("aborts while handle() runs (answers branch)", async () => {
      const { mock, g } = slowMock();
      const { observer, opener } = recorder();
      lease(mock, undefined, opener);
      const controller = new AbortController();
      const pending = fetch("http://localhost/api/users", {
        signal: controller.signal,
      });
      await g.hasStarted;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("aborted");
      expect(Object.keys(exchange).sort()).toEqual([
        "endTime",
        "outcome",
        "request",
        "startTime",
      ]);
      g.release();
      await tick();
      expect(observer).toHaveBeenCalledTimes(1);
    });

    it("does not report aborted for a newer passthrough mock with no route", async () => {
      const older = recorder();
      lease(usersMock(), undefined, older.opener, Symbol("older"));
      const newerMock = schmock();
      const newer = recorder();
      const g = gate();
      lease(newerMock, undefined, newer.opener, Symbol("newer"), () => {
        const admission = admit(newerMock);
        const handle = admission.handle.bind(admission);
        Object.defineProperty(admission, "handle", {
          configurable: true,
          value: async (...args: Parameters<typeof handle>) => {
            g.started();
            await g.released;
            return handle(...args);
          },
        });
        return admission;
      });
      const controller = new AbortController();
      const pending = fetch("http://localhost/api/users", {
        signal: controller.signal,
      });
      await g.hasStarted;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(newer.opener).toHaveBeenCalledTimes(1);
      expect(newer.observer).toHaveBeenCalledTimes(0);
      g.release();
      await tick();
      expect(newer.observer).toHaveBeenCalledTimes(0);
    });

    async function abortDuringBodyRead(
      path: string,
      options?: Schmock.InterceptOptions,
    ) {
      const mock = schmock();
      mock("POST /api/users", USERS);
      const { observer, opener } = recorder();
      let admitted: () => void = () => {};
      const admittedPromise = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      lease(mock, options, opener, Symbol("o"), () => {
        const admission = admit(mock);
        admitted();
        return admission;
      });
      const controller = new AbortController();
      const pending = fetch(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: hangingBody(),
        duplex: "half",
        signal: controller.signal,
      } as RequestInit);
      await admittedPromise;
      await tick();
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      return observer;
    }

    it("aborts during the body read of a routed POST", async () => {
      const observer = await abortDuringBodyRead("/api/users");
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("aborted");
      expect("body" in exchange.request).toBe(false);
    });

    it("aborts during the body read with passthrough off and no route", async () => {
      const observer = await abortDuringBodyRead("/api/missing", {
        passthrough: false,
      });
      expect(observer).toHaveBeenCalledTimes(1);
      expect(lastExchange(observer).outcome).toBe("aborted");
    });

    it("does not observe while the lease's own beforeRequest is pending", async () => {
      const mock = usersMock();
      const { observer, opener } = recorder();
      const started = gate();
      lease(
        mock,
        {
          beforeRequest: async () => {
            started.started();
            await new Promise(() => {});
          },
        },
        opener,
      );
      const controller = new AbortController();
      const pending = fetch("http://localhost/api/users", {
        signal: controller.signal,
      });
      await started.hasStarted;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(opener).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledTimes(0);
    });

    it("reports aborted when beforeResponse aborts then returns", async () => {
      const controller = new AbortController();
      const { observer, opener } = recorder();
      lease(
        usersMock(),
        {
          beforeResponse: (r) => {
            controller.abort();
            return r;
          },
        },
        opener,
      );
      await expect(
        fetch("http://localhost/api/users", { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(observer).toHaveBeenCalledTimes(1);
      expect(lastExchange(observer).outcome).toBe("aborted");
    });

    it("reports aborted when the abort lands after the Response was built", async () => {
      const mock = usersMock();
      const controller = new AbortController();
      const beforeRequest = vi.fn((r: Schmock.AdapterRequest) => r);
      const { observer, opener } = recorder();
      lease(
        mock,
        { passthrough: false, beforeRequest },
        opener,
        Symbol("o"),
        () => {
          const admission = admit(mock);
          const release = admission.release.bind(admission);
          Object.defineProperty(admission, "release", {
            configurable: true,
            value: () => {
              release();
              controller.abort();
            },
          });
          return admission;
        },
      );
      await expect(
        fetch("http://localhost/api/users", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{oops",
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(observer).toHaveBeenCalledTimes(1);
      const exchange = lastExchange(observer);
      expect(exchange.outcome).toBe("aborted");
      expect(exchange.request.body).toBe("{oops");
      expect(beforeRequest).not.toHaveBeenCalled();
    });
  });

  describe("E. no observation and preserved behaviour", () => {
    it("does not observe a passthrough to the network", async () => {
      const { observer, opener } = recorder();
      lease(usersMock(), undefined, opener);
      const res = await fetch("http://localhost/api/other");
      expect(await res.text()).toBe("network");
      expect(network).toHaveBeenCalledTimes(1);
      expect(opener).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledTimes(0);
    });

    it("builds nothing when the opener returns undefined", async () => {
      const opener = vi.fn(() => undefined);
      lease(usersMock(), undefined, opener);
      const res = await fetch("http://localhost/api/users");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(USERS);
      expect(opener).toHaveBeenCalledTimes(1);
    });

    it("never lets a throwing observer change the outcome", async () => {
      const broken = vi.fn(() => {
        throw new Error("observer broke");
      });
      const opener = vi.fn(() => broken);

      const answered = lease(usersMock(), undefined, opener);
      const res = await fetch("http://localhost/api/users");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(USERS);
      answered.restore();

      const hookError = new Error("hook failed");
      const failing = lease(
        usersMock(),
        {
          beforeResponse: () => {
            throw hookError;
          },
        },
        opener,
      );
      await expect(fetch("http://localhost/api/users")).rejects.toBe(hookError);
      failing.restore();

      const g = gate();
      const slow = schmock();
      slow("GET /api/users", async () => {
        g.started();
        await g.released;
        return USERS;
      });
      lease(slow, undefined, opener);
      const controller = new AbortController();
      const pending = fetch("http://localhost/api/users", {
        signal: controller.signal,
      });
      await g.hasStarted;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      g.release();
      expect(broken).toHaveBeenCalledTimes(3);
    });

    it("still skips the body read on a passthrough miss", async () => {
      const mock = schmock();
      const { observer, opener } = recorder();
      const clone = vi.spyOn(Request.prototype, "clone");
      let hasRoute: ReturnType<typeof vi.spyOn> | undefined;
      lease(mock, undefined, opener, Symbol("o"), () => {
        const admission = admit(mock);
        hasRoute = vi.spyOn(admission, "hasRoute");
        return admission;
      });
      const payload = { large: "x".repeat(1024) };
      await fetch("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(opener).toHaveBeenCalledTimes(1);
      expect(clone).not.toHaveBeenCalled();
      expect(hasRoute).toHaveBeenCalledTimes(1);
      const forwarded = network.mock.calls[0][0];
      expect(forwarded).toBeInstanceOf(Request);
      expect(await (forwarded as Request).json()).toEqual(payload);
      expect(observer).toHaveBeenCalledTimes(0);
    });

    it("never probes the routes with passthrough off and no abort", async () => {
      const mock = usersMock();
      const { observer, opener } = recorder();
      let hasRoute: ReturnType<typeof vi.spyOn> | undefined;
      lease(mock, { passthrough: false }, opener, Symbol("o"), () => {
        const admission = admit(mock);
        hasRoute = vi.spyOn(admission, "hasRoute");
        return admission;
      });
      await fetch("http://localhost/api/users");
      expect(hasRoute).toHaveBeenCalledTimes(0);
      expect(observer).toHaveBeenCalledTimes(1);
    });

    it("createFetchInterceptor still answers", async () => {
      const mock = usersMock();
      const handle = createFetchInterceptor(
        (m, p, o) => mock.handle(m, p, o),
        {},
        () => admit(mock),
        Symbol("o"),
      );
      handles.push(handle);
      const res = await fetch("http://localhost/api/users");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(USERS);
    });

    it("createFetchLease with undefined options matches createFetchInterceptor", async () => {
      const mock = usersMock();
      const handleOf = (
        m: Schmock.HttpMethod,
        p: string,
        o?: Schmock.RequestOptions,
      ) => mock.handle(m, p, o);
      const outcomes: Array<{
        status: number;
        type: string | null;
        text: string;
      }> = [];
      for (const make of [
        () =>
          createFetchLease({
            handle: handleOf,
            options: undefined,
            admitRequest: () => admit(mock),
            owner: Symbol("a"),
          }),
        () =>
          createFetchInterceptor(handleOf, {}, () => admit(mock), Symbol("b")),
      ]) {
        const handle = make();
        handles.push(handle);
        const res = await fetch("http://localhost/api/users");
        outcomes.push({
          status: res.status,
          type: res.headers.get("content-type"),
          text: await res.text(),
        });
        const other = await fetch("http://localhost/api/other");
        expect(await other.text()).toBe("network");
        handle.restore();
      }
      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(outcomes[0].status).toBe(200);
    });

    it("keeps the module surface to ExchangeObserver among the new names", async () => {
      const mod = await import("./interceptor.js");
      for (const key of [
        "createFetchLease",
        "createFetchInterceptor",
        "NORMALIZED_ADMISSION_KEY",
      ]) {
        expect(Object.keys(mod)).toContain(key);
      }
      for (const key of [
        "notify",
        "routeThroughLeases",
        "answeredExchange",
        "failedExchange",
        "abortedExchange",
        "exchangeRequestOf",
        "headerRecordOf",
      ]) {
        expect(Object.keys(mod)).not.toContain(key);
      }
      const source = readFileSync(
        join(import.meta.dirname, "interceptor.ts"),
        "utf8",
      );
      expect(source).toMatch(/^export type ExchangeObserver\b/m);
      expect(source).toMatch(/^interface ExchangeDraft\b/m);
      expect(source).toMatch(/^type ExchangeObservationOpener\b/m);
      expect(source).not.toMatch(
        /export\s+(?:interface|type)\s+(?:ExchangeDraft|ExchangeObservationOpener|FetchLeaseSpec)\b/,
      );
    });
  });
});
