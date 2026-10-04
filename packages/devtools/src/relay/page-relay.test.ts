import { readFileSync } from "node:fs";
import { SchmockError, schmock } from "@schmock/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRelayHarness,
  type FakePage,
  type FakeWorkerScope,
  type RelayHarness,
} from "../test-support/relay-harness.js";
import type { ServiceWorkerRelay } from "../types.js";
import {
  createServiceWorkerRelay,
  startServiceWorkerRelay,
} from "./page-relay.js";
import type {
  ClientLike,
  ExtendableMessageEventLike,
  RelayContainer,
  RelayEnvironment,
  RelayWorker,
  RequestMessage,
} from "./types.js";

// Harness plus stub workers only: worker.ts is never imported. The protocol
// constants are restated here from the contract (A.2) so these tests do not
// depend on protocol.ts landing first.
const PROTOCOL = 1;
const VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;
const SCRIPT = "http://localhost/schmock-sw.js";
const USERS = [{ id: 1, name: "Ada" }];

const TEXT = {
  unsupported:
    "Schmock relay: service workers are unavailable here, so mocked requests stay in the page and do not appear in the Network panel.",
  insecure:
    "Schmock relay: service workers need a secure context (https or localhost), so mocked requests stay in the page.",
  reload:
    "Schmock relay: this page is not controlled by the Schmock service worker (a hard reload bypasses service workers); reload normally.",
  scopeTaken: (script: string) =>
    `Schmock relay: ${script} already controls this scope; Schmock will not replace it. Unregister it while developing, or give Schmock its own scope.`,
  foreign: (script: string) =>
    `Schmock relay: this page is controlled by ${script}, which Schmock will not replace. Unregister it while developing, or give Schmock a scope that covers this page.`,
  mismatch: (n: number) =>
    `Schmock relay: ${SCRIPT} speaks relay protocol ${n}, this page expects ${PROTOCOL}. Run "npx schmock-devtools init <publicDir>" again.`,
  timeout: (ms: number) =>
    `Schmock relay: the service worker did not get ready within ${ms} ms, so mocked requests stay in the page.`,
  version: (v: string) =>
    `Schmock relay: ${SCRIPT} comes from @schmock/devtools ${v}, this page uses ${VERSION}. Run "npx schmock-devtools init <publicDir>" to update it.`,
  mockFailureFormat:
    "Schmock relay: %s %s failed in the mock, so the page receives a network error.",
};

interface Seen {
  readonly type: string | undefined;
  readonly data: unknown;
  readonly ports: number;
}

interface StubOptions {
  seen?: Seen[];
  onHello?: (event: ExtendableMessageEventLike, scope: FakeWorkerScope) => void;
  onGoodbye?: (event: ExtendableMessageEventLike) => void;
  activateGate?: Promise<void>;
  installGate?: Promise<void>;
  installFails?: boolean;
}

function typeOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const type: unknown = Reflect.get(data, "type");
  return typeof type === "string" ? type : undefined;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function answerReady(
  event: ExtendableMessageEventLike,
  over?: { protocol?: number; version?: string },
): void {
  const [port] = event.ports;
  port?.postMessage({
    type: "schmock:ready",
    protocol: over?.protocol ?? PROTOCOL,
    version: over?.version ?? VERSION,
  });
  port?.close();
}

function answerReleased(event: ExtendableMessageEventLike): void {
  const [port] = event.ports;
  port?.postMessage({ type: "schmock:released" });
  port?.close();
}

function stubWorker(
  options: StubOptions = {},
): (scope: FakeWorkerScope) => void {
  return (scope) => {
    scope.addEventListener("install", (event) => {
      event.waitUntil(
        options.installFails
          ? Promise.reject(new Error("install failed"))
          : (options.installGate ?? Promise.resolve()).then(() =>
              scope.skipWaiting(),
            ),
      );
    });
    scope.addEventListener("activate", (event) => {
      event.waitUntil(
        (options.activateGate ?? Promise.resolve()).then(() =>
          scope.clients.claim(),
        ),
      );
    });
    scope.addEventListener("message", (event) => {
      const type = typeOf(event.data);
      options.seen?.push({
        type,
        data: event.data,
        ports: event.ports.length,
      });
      if (type === "schmock:hello") {
        (options.onHello ?? ((e) => answerReady(e)))(event, scope);
      } else if (type === "schmock:claim") {
        event.waitUntil(scope.clients.claim());
      } else if (type === "schmock:goodbye") {
        (options.onGoodbye ?? answerReleased)(event);
      }
    });
  };
}

function ofType(seen: readonly Seen[], type: string): Seen[] {
  return seen.filter((m) => m.type === type);
}

const frameFor = (
  url = "http://localhost/api/users",
  method = "GET",
): RequestMessage => ({
  type: "schmock:request",
  request: { url, method, headers: [], body: null },
});

interface Probe {
  readonly replies: unknown[];
  closed: boolean;
  readonly port: MessagePort;
}

function postFrame(client: ClientLike, frame: RequestMessage): Probe {
  const channel = new MessageChannel();
  const probe: Probe = { replies: [], closed: false, port: channel.port1 };
  channel.port1.addEventListener("close", () => {
    probe.closed = true;
  });
  channel.port1.onmessage = (e: MessageEvent) => {
    probe.replies.push(e.data);
  };
  client.postMessage(frame, [channel.port2]);
  return probe;
}

function decodeBody(reply: unknown): unknown {
  const body = field(field(reply, "response"), "body");
  if (!(body instanceof ArrayBuffer)) throw new Error("no ArrayBuffer body");
  return JSON.parse(new TextDecoder().decode(body));
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function settledFlag(promise: Promise<unknown>): { settled: boolean } {
  const flag = { settled: false };
  const done = () => {
    flag.settled = true;
  };
  promise.then(done, done);
  return flag;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (rejection) {
    return rejection;
  }
  throw new Error("expected the promise to reject");
}

function containerOf(page: FakePage): RelayContainer {
  const { container } = page.environment;
  if (container === undefined) throw new Error("page has no container");
  return container;
}

function neverContainer(
  over: Partial<Pick<RelayContainer, "getRegistration" | "register">> = {},
): RelayContainer {
  return {
    controller: null,
    register: () => new Promise(() => {}),
    getRegistration: () => new Promise(() => {}),
    startMessages: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    ...over,
  };
}

function envOf(container: RelayContainer | undefined): RelayEnvironment {
  return {
    container,
    secureContext: true,
    baseUrl: "http://localhost/",
    onPageHide: () => () => {},
  };
}

// ── shared state ─────────────────────────────────────────────────────

let h: RelayHarness | undefined;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let mock: ReturnType<typeof schmock>;
const relays: ServiceWorkerRelay[] = [];
const handles: { restore(): void }[] = [];
const releases: (() => void)[] = [];
const probes: Probe[] = [];
const originalFetch = globalThis.fetch;
const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();

function harness(): RelayHarness {
  h = createRelayHarness();
  return h;
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}

async function start(
  page: FakePage,
  options?: Parameters<typeof createServiceWorkerRelay>[1],
): Promise<ServiceWorkerRelay> {
  const relay = await createServiceWorkerRelay(page.environment, options);
  relays.push(relay);
  return relay;
}

function begin(
  page: FakePage,
  options?: Parameters<typeof createServiceWorkerRelay>[1],
): Promise<ServiceWorkerRelay> {
  const promise = createServiceWorkerRelay(page.environment, options);
  promise.catch(() => {});
  return promise;
}

function lease(
  page: FakePage,
  interceptOptions?: Parameters<typeof mock.intercept>[0],
  routes?: (m: typeof mock) => void,
): void {
  globalThis.fetch = page.networkFetch;
  mock = schmock();
  mock("GET /api/users", USERS);
  routes?.(mock);
  handles.push(mock.intercept(interceptOptions));
}

async function clientOf(page: FakePage): Promise<ClientLike> {
  const client = await h?.worker.clients.get(page.id);
  if (client === undefined) throw new Error("no client");
  return client;
}

async function sendFrame(page: FakePage, frame = frameFor()): Promise<Probe> {
  const probe = postFrame(await clientOf(page), frame);
  probes.push(probe);
  return probe;
}

async function replyOf(probe: Probe): Promise<unknown> {
  await vi.waitFor(() => expect(probe.replies).toHaveLength(1), {
    timeout: 2000,
  });
  return probe.replies[0];
}

function expectFallback(
  relay: ServiceWorkerRelay,
  reason: string,
  text: string,
): void {
  expect(relay.active).toBe(false);
  expect(relay.fallbackReason).toBe(reason);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(text);
}

function stubGetter(name: string, value: () => unknown): void {
  if (!savedDescriptors.has(name)) {
    savedDescriptors.set(
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    );
  }
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get: value,
  });
}

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const relay of relays.splice(0)) await relay.stop().catch(() => {});
  for (const handle of handles.splice(0).reverse()) handle.restore();
  for (const probe of probes.splice(0)) probe.port.close();
  h?.dispose();
  h = undefined;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of savedDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  savedDescriptors.clear();
});

// ── tests ────────────────────────────────────────────────────────────

describe("PR1 option validation", () => {
  const cases: [string, unknown, string][] = [
    ["null", null, "options"],
    ["a string", "x", "options"],
    ["an array", [], "options"],
    ["empty url", { url: "" }, "url"],
    ["numeric url", { url: 5 }, "url"],
    ["empty scope", { scope: "" }, "scope"],
    ["zero timeout", { timeout: 0 }, "timeout"],
    ["negative timeout", { timeout: -1 }, "timeout"],
    ["NaN timeout", { timeout: Number.NaN }, "timeout"],
    ["infinite timeout", { timeout: Number.POSITIVE_INFINITY }, "timeout"],
    ["string timeout", { timeout: "100" }, "timeout"],
  ];

  it.each(cases)(
    "rejects %s with DEVTOOLS_CONFIG_INVALID",
    async (_n, bad, option) => {
      const page = harness().openPage();
      let promise: Promise<unknown> = Promise.resolve();
      expect(() => {
        promise = createServiceWorkerRelay(page.environment, bad as never);
      }).not.toThrow();
      const rejected = await rejectionOf(promise);
      expect(rejected).toBeInstanceOf(SchmockError);
      expect(rejected).toMatchObject({
        code: "DEVTOOLS_CONFIG_INVALID",
        context: { option },
      });
      expect(String((rejected as Error).message)).toMatch(
        /^startServiceWorkerRelay: /,
      );
    },
  );

  it("validates before looking at the container and logs no warning", async () => {
    const rejected = await rejectionOf(
      createServiceWorkerRelay(envOf(undefined), { timeout: -5 }),
    );
    expect(rejected).toBeInstanceOf(SchmockError);
    expect(rejected).toMatchObject({
      code: "DEVTOOLS_CONFIG_INVALID",
      context: { option: "timeout" },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("PR2 environment fallbacks", () => {
  it("falls back unsupported without a container, with one warning", async () => {
    const relay = await createServiceWorkerRelay(envOf(undefined));
    expectFallback(relay, "unsupported", TEXT.unsupported);
  });

  it("checks unsupported before insecure-context", async () => {
    const relay = await createServiceWorkerRelay({
      ...envOf(undefined),
      secureContext: false,
    });
    expectFallback(relay, "unsupported", TEXT.unsupported);
  });

  it("clears an environment fallback's reason on stop()", async () => {
    const unsupported = await createServiceWorkerRelay(envOf(undefined));
    await unsupported.stop();
    expect(unsupported.fallbackReason).toBeUndefined();
    expect(unsupported.active).toBe(false);

    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const insecure = await start(harnessed.openPage({ secure: false }));
    expect(insecure.fallbackReason).toBe("insecure-context");
    await insecure.stop();
    expect(insecure.fallbackReason).toBeUndefined();
  });

  it("falls back insecure-context for an insecure page, registering nothing", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage({ secure: false });
    const relay = await start(page);
    expectFallback(relay, "insecure-context", TEXT.insecure);
    expect(harnessed.registerCalls).toEqual([]);
  });
});

describe("PR3 scope check", () => {
  it("is scope-taken for a foreign worker at a relative scope, without registering", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    harnessed.seedForeignRegistration("/pages/sub/app-sw.js", "/pages/sub/");
    const page = harnessed.openPage({ path: "/pages/index.html" });
    const relay = await start(page, { scope: "sub/" });
    expectFallback(
      relay,
      "scope-taken",
      TEXT.scopeTaken("http://localhost/pages/sub/app-sw.js"),
    );
    expect(harnessed.registerCalls).toEqual([]);
  });

  it("derives the default scope from the script directory", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker(), "/mocks/schmock-sw.js");
    harnessed.seedForeignRegistration("/mocks/app-sw.js", "/mocks/");
    const page = harnessed.openPage();
    const relay = await start(page, { url: "/mocks/schmock-sw.js" });
    expectFallback(
      relay,
      "scope-taken",
      TEXT.scopeTaken("http://localhost/mocks/app-sw.js"),
    );
    expect(harnessed.registerCalls).toEqual([]);
  });

  it("is not scope-taken when our own script already holds the scope", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    await harnessed.activateWorker();
    const page = harnessed.openPage();
    const relay = await start(page);
    expect(relay.active).toBe(true);
    expect(relay.fallbackReason).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("registers beside a foreign worker at a parent scope and goes active", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    harnessed.seedForeignRegistration("/app-sw.js", "/");
    const page = harnessed.openPage({ path: "/app/index.html" });
    const relay = await start(page, { scope: "/app/" });
    expect(relay.active).toBe(true);
    expect(harnessed.registerCalls[0]).toEqual({
      url: "/schmock-sw.js",
      options: { scope: "/app/", updateViaCache: "none" },
    });
    expect(harnessed.registrations).toContainEqual({
      scope: "http://localhost/",
      scriptURL: "http://localhost/app-sw.js",
    });
  });
});

describe("PR4 register arguments", () => {
  it("passes no scope key by default", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const relay = await start(harnessed.openPage());
    expect(relay.active).toBe(true);
    expect(harnessed.registerCalls).toStrictEqual([
      { url: "/schmock-sw.js", options: { updateViaCache: "none" } },
    ]);
  });

  it("passes the url exactly as the caller gave it", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const relay = await start(harnessed.openPage(), {
      url: "./schmock-sw.js",
    });
    expect(relay.active).toBe(true);
    expect(harnessed.registerCalls[0].url).toBe("./schmock-sw.js");
  });
});

describe("PR5 activation", () => {
  it("waits for activation before claiming or saying hello", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    const activation = gate();
    harnessed.installWorker(
      stubWorker({ seen, activateGate: activation.promise }),
    );
    const page = harnessed.openPage();
    const starting = begin(page);
    const flag = settledFlag(starting);
    await delay(30);
    expect(flag.settled).toBe(false);
    expect(seen).toEqual([]);
    activation.release();
    const relay = await starting;
    relays.push(relay);
    expect(relay.active).toBe(true);
    expect(ofType(seen, "schmock:hello")).toHaveLength(1);
  });

  it("passes at once for an already-activated registration", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    harnessed.installWorker(stubWorker({ seen }));
    await harnessed.activateWorker();
    const page = harnessed.openPage();
    const relay = await start(page);
    expect(relay.active).toBe(true);
    expect(ofType(seen, "schmock:claim")).toHaveLength(0);
    expect(ofType(seen, "schmock:hello")).toHaveLength(1);
  });

  it("removes every statechange listener it added", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    const container = containerOf(page);
    const original = container.register.bind(container);
    const added: (() => void)[] = [];
    const removed: (() => void)[] = [];
    vi.spyOn(container, "register").mockImplementation(async (url, options) => {
      const registration = await original(url, options);
      for (const worker of [
        registration.installing,
        registration.waiting,
        registration.active,
      ]) {
        if (worker === null) continue;
        const target: RelayWorker = worker;
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        vi.spyOn(target, "addEventListener").mockImplementation((t, l) => {
          added.push(l);
          add(t, l);
        });
        vi.spyOn(target, "removeEventListener").mockImplementation((t, l) => {
          removed.push(l);
          remove(t, l);
        });
      }
      return registration;
    });
    const relay = await start(page);
    expect(relay.active).toBe(true);
    expect(added.length).toBeGreaterThan(0);
    for (const listener of added) expect(removed).toContain(listener);
  });
});

describe("PR6 registration failures", () => {
  it("reports a worker that fails to install", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker({ installFails: true }));
    const relay = await start(harnessed.openPage());
    expectFallback(
      relay,
      "registration-failed",
      `Schmock relay: could not register ${SCRIPT} (the worker failed to install). Run "npx schmock-devtools init <publicDir>" and serve the file at ${SCRIPT}.`,
    );
  });

  it("reports a scope wider than the script directory with the browser's message", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker(), "/mocks/schmock-sw.js");
    const relay = await start(harnessed.openPage(), {
      url: "/mocks/schmock-sw.js",
      scope: "/",
    });
    expect(relay.active).toBe(false);
    expect(relay.fallbackReason).toBe("registration-failed");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "is not under the max scope allowed",
    );
  });

  it("reports a script that is not served", async () => {
    const harnessed = harness();
    harnessed.serveScript(false);
    const relay = await start(harnessed.openPage());
    expect(relay.fallbackReason).toBe("registration-failed");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "A bad HTTP response code (404)",
    );
  });
});

describe("PR7 deadline by stage", () => {
  it("is timeout while getRegistration never settles, registering nothing", async () => {
    const register = vi.fn(() => new Promise<never>(() => {}));
    const relay = await createServiceWorkerRelay(
      envOf(neverContainer({ register })),
      { timeout: 50 },
    );
    expect(relay.active).toBe(false);
    expect(relay.fallbackReason).toBe("timeout");
    expect(register).not.toHaveBeenCalled();
  });

  it("is timeout while register never settles", async () => {
    const relay = await createServiceWorkerRelay(
      envOf(
        neverContainer({ getRegistration: () => Promise.resolve(undefined) }),
      ),
      { timeout: 50 },
    );
    expect(relay.fallbackReason).toBe("timeout");
    expect(relay.active).toBe(false);
  });

  it("is timeout while the worker never finishes installing", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker({ installGate: new Promise(() => {}) }));
    const relay = await start(harnessed.openPage(), { timeout: 50 });
    expect(relay.fallbackReason).toBe("timeout");
    expect(relay.active).toBe(false);
  });

  it("is not-controlled with the reload text while waiting for control", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    await harnessed.activateWorker();
    const page = harnessed.openPage({ controlled: false, claimable: false });
    const relay = await start(page, { timeout: 50 });
    expectFallback(relay, "not-controlled", TEXT.reload);
  });

  it("is timeout when the hello is never answered", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker({ onHello: () => {} }));
    const relay = await start(harnessed.openPage(), { timeout: 50 });
    expectFallback(relay, "timeout", TEXT.timeout(50));
  });

  it("takes an unanswered hello back with a portless goodbye", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    harnessed.installWorker(stubWorker({ seen, onHello: () => {} }));
    const relay = await start(harnessed.openPage(), { timeout: 50 });
    expect(relay.fallbackReason).toBe("timeout");
    await harnessed.flush();
    const goodbyes = ofType(seen, "schmock:goodbye");
    expect(goodbyes).toHaveLength(1);
    expect(goodbyes[0].ports).toBe(0);
    expect(seen.map((m) => m.type).indexOf("schmock:hello")).toBeLessThan(
      seen.map((m) => m.type).indexOf("schmock:goodbye"),
    );
  });
});

describe("PR8 claim", () => {
  it("claims once for an uncontrolled page and goes active", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    harnessed.installWorker(stubWorker({ seen }));
    await harnessed.activateWorker();
    const page = harnessed.openPage({ controlled: false });
    expect(containerOf(page).controller).toBeNull();
    const relay = await start(page);
    expect(relay.active).toBe(true);
    const claims = ofType(seen, "schmock:claim");
    expect(claims).toHaveLength(1);
    expect(claims[0].ports).toBe(0);
    expect(containerOf(page).controller?.scriptURL).toBe(SCRIPT);
  });

  it("is not-controlled naming a foreign worker at a narrower scope", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    harnessed.seedForeignRegistration("/app/app-sw.js", "/app/");
    const page = harnessed.openPage({ path: "/app/index.html" });
    const relay = await start(page, { timeout: 100 });
    expectFallback(
      relay,
      "not-controlled",
      TEXT.foreign("http://localhost/app/app-sw.js"),
    );
  });
});

describe("PR9 hello", () => {
  it("sends protocol and version to the controller with one port", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    harnessed.installWorker(stubWorker({ seen }));
    const relay = await start(harnessed.openPage());
    expect(relay.active).toBe(true);
    const hellos = ofType(seen, "schmock:hello");
    expect(hellos).toHaveLength(1);
    expect(hellos[0].data).toEqual({
      type: "schmock:hello",
      protocol: PROTOCOL,
      version: VERSION,
    });
    expect(hellos[0].ports).toBe(1);
  });
});

describe("PR10 protocol mismatch", () => {
  it("says goodbye without a port, warns once and keeps mocks in the page", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    harnessed.installWorker(
      stubWorker({ seen, onHello: (e) => answerReady(e, { protocol: 99 }) }),
    );
    const page = harnessed.openPage();
    lease(page);
    const relay = await start(page);
    expectFallback(relay, "protocol-mismatch", TEXT.mismatch(99));
    await harnessed.flush();
    const goodbyes = ofType(seen, "schmock:goodbye");
    expect(goodbyes).toHaveLength(1);
    expect(goodbyes[0].ports).toBe(0);
    const logged = page.browserLog.length;
    const response = await fetch("/api/users");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(USERS);
    expect(page.browserLog.length).toBe(logged);
  });
});

describe("PR11 version mismatch", () => {
  it("warns once and stays active", async () => {
    const harnessed = harness();
    harnessed.installWorker(
      stubWorker({ onHello: (e) => answerReady(e, { version: "0.0.1" }) }),
    );
    const relay = await start(harnessed.openPage());
    expect(relay.active).toBe(true);
    expect(relay.fallbackReason).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(TEXT.version("0.0.1"));
  });
});

describe("PR12 takeover mid-hello", () => {
  it("discards the stale reply and handshakes the new controller", async () => {
    const harnessed = harness();
    const seen2: Seen[] = [];
    let stalePortClosed = false;
    harnessed.installWorker(
      stubWorker({
        onHello: (event) => {
          const [port] = event.ports;
          port?.addEventListener("close", () => {
            stalePortClosed = true;
          });
          event.waitUntil(
            harnessed
              .replaceWorker(stubWorker({ seen: seen2 }))
              .then(() => answerReady(event, { protocol: 99 })),
          );
        },
      }),
    );
    const relay = await start(harnessed.openPage());
    expect(relay.active).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(ofType(seen2, "schmock:hello")).toHaveLength(1);
    await vi.waitFor(() => expect(stalePortClosed).toBe(true), {
      timeout: 2000,
    });
  });
});

describe("PR13 hold only after ready", () => {
  it("answers in the page until the worker is ready, then lets the network through", async () => {
    const harnessed = harness();
    const ready = gate();
    harnessed.installWorker(
      stubWorker({
        onHello: (event) => {
          void ready.promise.then(() => answerReady(event));
        },
      }),
    );
    const page = harnessed.openPage();
    lease(page);
    const starting = begin(page);
    await delay(30);
    const logged = page.browserLog.length;
    const during = await fetch("/api/users");
    expect(during.status).toBe(200);
    expect(await during.json()).toEqual(USERS);
    expect(page.browserLog.length).toBe(logged);
    ready.release();
    const relay = await starting;
    relays.push(relay);
    expect(relay.active).toBe(true);
    const after = await fetch("/api/users");
    expect(await after.text()).toBe("real network");
    expect(page.browserLog.at(-1)?.servedBy).toBe("network");
  });
});

describe("PR14 frames are routed", () => {
  it("routes a frame that arrives before ready", async () => {
    const harnessed = harness();
    const early: unknown[] = [];
    harnessed.installWorker(
      stubWorker({
        onHello: (event, scope) => {
          event.waitUntil(
            (async () => {
              const id = event.source?.id;
              const client =
                id === undefined ? undefined : await scope.clients.get(id);
              if (client === undefined) return;
              const probe = postFrame(client, frameFor());
              probes.push(probe);
              await vi.waitFor(() => expect(probe.replies).toHaveLength(1), {
                timeout: 2000,
              });
              early.push(probe.replies[0]);
              answerReady(event);
            })(),
          );
        },
      }),
    );
    const page = harnessed.openPage();
    lease(page);
    const relay = await start(page);
    expect(relay.active).toBe(true);
    expect(field(early[0], "type")).toBe("schmock:response");
    expect(field(field(early[0], "response"), "status")).toBe(200);
  });

  it("answers while live with a transferred body, passes misses through, closes the port", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    lease(page);
    const relay = await start(page);
    expect(relay.active).toBe(true);
    const postSpy = vi.spyOn(MessagePort.prototype, "postMessage");

    const probe = await sendFrame(page);
    const reply = await replyOf(probe);
    expect(field(reply, "type")).toBe("schmock:response");
    expect(field(field(reply, "response"), "status")).toBe(200);
    expect(decodeBody(reply)).toEqual(USERS);
    await vi.waitFor(() => expect(probe.closed).toBe(true), { timeout: 2000 });

    const call = postSpy.mock.calls.find(
      ([message]) => typeOf(message) === "schmock:response",
    );
    expect(call).toBeDefined();
    const body = field(field(call?.[0], "response"), "body");
    expect(call?.[1]).toHaveLength(1);
    expect(Array.isArray(call?.[1]) ? call?.[1][0] : undefined).toBe(body);
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect((body as ArrayBuffer).byteLength).toBe(0);

    const miss = await sendFrame(page, frameFor("http://localhost/api/nope"));
    expect(await replyOf(miss)).toEqual({ type: "schmock:passthrough" });
    await vi.waitFor(() => expect(miss.closed).toBe(true), { timeout: 2000 });
  });

  it("still answers after stop()", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    lease(page);
    const relay = await start(page);
    await relay.stop();
    const reply = await replyOf(await sendFrame(page));
    expect(field(field(reply, "response"), "status")).toBe(200);
  });
});

describe("PR15 aborted and error replies", () => {
  it("replies aborted after schmock:abort and the mock records 499", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    const routeGate = gate();
    let announce = () => {};
    const started = new Promise<void>((r) => {
      announce = r;
    });
    lease(page, undefined, (m) => {
      m("GET /api/slow", async () => {
        announce();
        await routeGate.promise;
        return USERS;
      });
    });
    const statuses: number[] = [];
    mock.on("request:end", (event) => {
      statuses.push(event.status);
    });
    const relay = await start(page);
    expect(relay.active).toBe(true);
    const probe = await sendFrame(page, frameFor("http://localhost/api/slow"));
    await started;
    probe.port.postMessage({ type: "schmock:abort" });
    expect(await replyOf(probe)).toEqual({ type: "schmock:aborted" });
    await vi.waitFor(() => expect(statuses).toEqual([499]), { timeout: 2000 });
  });

  it("replies error and logs the original error", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    const hookError = new Error("hook failed");
    lease(page, {
      beforeResponse: () => {
        throw hookError;
      },
    });
    const relay = await start(page);
    expect(relay.active).toBe(true);
    const reply = await replyOf(await sendFrame(page));
    expect(reply).toEqual({
      type: "schmock:error",
      error: { name: "Error", message: "hook failed" },
    });
    expect(error).toHaveBeenCalledTimes(1);
    const args = error.mock.calls[0];
    // Method and URL are arguments, never part of the format string.
    expect(args).toEqual([
      TEXT.mockFailureFormat,
      "GET",
      "http://localhost/api/users",
      hookError,
    ]);
  });
});

describe("PR16 ignored frames", () => {
  it("ignores foreign frames and portless frames, then answers a valid one", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    lease(page);
    const relay = await start(page);
    expect(relay.active).toBe(true);
    const client = await clientOf(page);

    const foreign = new MessageChannel();
    const foreignProbe: Probe = {
      replies: [],
      closed: false,
      port: foreign.port1,
    };
    probes.push(foreignProbe);
    foreign.port1.onmessage = (e: MessageEvent) => {
      foreignProbe.replies.push(e.data);
    };
    client.postMessage({ type: "other" } as never, [foreign.port2]);
    client.postMessage(frameFor(), []);
    await delay(30);
    expect(foreignProbe.replies).toEqual([]);
    expect(mock.callCount()).toBe(0);

    const reply = await replyOf(await sendFrame(page));
    expect(field(reply, "type")).toBe("schmock:response");
    expect(mock.callCount()).toBe(1);
  });
});

describe("PR17 listener installed once", () => {
  it("starts messages and adds the message listener once across restarts", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    lease(page);
    const container = containerOf(page);
    const startMessages = vi.spyOn(container, "startMessages");
    const addListener = vi.spyOn(container, "addEventListener");
    const first = await start(page);
    expect(first.active).toBe(true);
    await first.stop();
    const second = await start(page, { timeout: 4000 });
    expect(second.active).toBe(true);
    expect(startMessages).toHaveBeenCalledTimes(1);
    expect(
      addListener.mock.calls.filter(([type]) => type === "message"),
    ).toHaveLength(1);
    const reply = await replyOf(await sendFrame(page));
    expect(field(reply, "type")).toBe("schmock:response");
    expect(mock.callCount()).toBe(1);
  });
});

describe("PR18 controllerchange while live", () => {
  it("releases the hold, re-handshakes and re-acquires it", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    lease(page);
    const relay = await start(page);
    expect(relay.active).toBe(true);
    const ready = gate();
    await harnessed.replaceWorker(
      stubWorker({
        onHello: (event) => {
          void ready.promise.then(() => answerReady(event));
        },
      }),
    );
    await delay(30);
    expect(relay.active).toBe(false);
    const logged = page.browserLog.length;
    const during = await fetch("/api/users");
    expect(await during.json()).toEqual(USERS);
    expect(page.browserLog.length).toBe(logged);
    ready.release();
    await vi.waitFor(() => expect(relay.active).toBe(true), { timeout: 2000 });
    const after = await fetch("/api/users");
    expect(await after.text()).toBe("real network");
  });

  it("falls back protocol-mismatch when the new worker speaks another protocol", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const relay = await start(harnessed.openPage());
    expect(relay.active).toBe(true);
    await harnessed.replaceWorker(
      stubWorker({ onHello: (e) => answerReady(e, { protocol: 99 }) }),
    );
    await vi.waitFor(
      () => expect(relay.fallbackReason).toBe("protocol-mismatch"),
      { timeout: 2000 },
    );
    expect(relay.active).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(TEXT.mismatch(99));
  });

  it("falls back not-controlled naming a foreign controller", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const relay = await start(harnessed.openPage());
    expect(relay.active).toBe(true);
    await harnessed.replaceWorker(stubWorker(), "/other-sw.js");
    await vi.waitFor(
      () => expect(relay.fallbackReason).toBe("not-controlled"),
      { timeout: 2000 },
    );
    expect(relay.active).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      TEXT.foreign("http://localhost/other-sw.js"),
    );
  });
});

describe("PR19 pagehide", () => {
  it("ignores a persisted pagehide", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    harnessed.installWorker(stubWorker({ seen }));
    const page = harnessed.openPage();
    const relay = await start(page);
    expect(relay.active).toBe(true);
    const before = seen.length;
    page.hide(true);
    await harnessed.flush();
    expect(seen.length).toBe(before);
    expect(relay.active).toBe(true);
  });

  it("tears down on a final pagehide with a portless goodbye", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    harnessed.installWorker(stubWorker({ seen }));
    const page = harnessed.openPage();
    lease(page);
    const relay = await start(page);
    expect(relay.active).toBe(true);
    page.hide(false);
    await harnessed.flush();
    const goodbyes = ofType(seen, "schmock:goodbye");
    expect(goodbyes).toHaveLength(1);
    expect(goodbyes[0].ports).toBe(0);
    expect(relay.active).toBe(false);
    expect(relay.fallbackReason).toBeUndefined();
    const logged = page.browserLog.length;
    expect(await (await fetch("/api/users")).json()).toEqual(USERS);
    expect(page.browserLog.length).toBe(logged);
    await relay.stop();
    await harnessed.flush();
    expect(ofType(seen, "schmock:goodbye")).toHaveLength(1);
  });
});

describe("PR20 stop()", () => {
  it("releases the hold at once and posts an acknowledged goodbye", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    harnessed.installWorker(stubWorker({ seen }));
    const relay = await start(harnessed.openPage());
    expect(relay.active).toBe(true);
    const stopping = relay.stop();
    expect(relay.active).toBe(false);
    await stopping;
    const goodbyes = ofType(seen, "schmock:goodbye");
    expect(goodbyes).toHaveLength(1);
    expect(goodbyes[0].ports).toBe(1);
    expect(relay.fallbackReason).toBeUndefined();
  });

  it("stays pending until released arrives", async () => {
    const harnessed = harness();
    const released = gate();
    harnessed.installWorker(
      stubWorker({
        onGoodbye: (event) => {
          void released.promise.then(() => answerReleased(event));
        },
      }),
    );
    const relay = await start(harnessed.openPage());
    const stopping = relay.stop();
    const flag = settledFlag(stopping);
    await delay(30);
    expect(flag.settled).toBe(false);
    released.release();
    await stopping;
    expect(flag.settled).toBe(true);
  });

  it("gives up after the timeout when goodbye is never acknowledged", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker({ onGoodbye: () => {} }));
    const relay = await start(harnessed.openPage(), { timeout: 50 });
    expect(relay.active).toBe(true);
    const outcome = await Promise.race([
      relay.stop().then(() => "stopped"),
      delay(2000).then(() => "hung"),
    ]);
    expect(outcome).toBe("stopped");
  });

  it("is idempotent: one goodbye, both calls resolve", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    harnessed.installWorker(stubWorker({ seen }));
    const relay = await start(harnessed.openPage());
    expect(relay.active).toBe(true);
    await Promise.all([relay.stop(), relay.stop()]);
    expect(ofType(seen, "schmock:goodbye")).toHaveLength(1);
  });

  it("resolves at once and posts nothing for a relay that fell back", async () => {
    const harnessed = harness();
    const seen: Seen[] = [];
    harnessed.installWorker(
      stubWorker({ seen, onHello: (e) => answerReady(e, { protocol: 99 }) }),
    );
    const relay = await start(harnessed.openPage());
    expect(relay.fallbackReason).toBe("protocol-mismatch");
    await harnessed.flush();
    const before = ofType(seen, "schmock:goodbye").length;
    await relay.stop();
    await harnessed.flush();
    expect(ofType(seen, "schmock:goodbye")).toHaveLength(before);
    expect(relay.fallbackReason).toBeUndefined();
  });
});

describe("PR21 idempotency", () => {
  it("returns the identical promise for equivalent options", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    const first = begin(page, {});
    const second = begin(page, { url: "/schmock-sw.js", timeout: 5000 });
    expect(second).toBe(first);
    const relay = await first;
    relays.push(relay);
    expect(await second).toBe(relay);
    expect(relay.active).toBe(true);
  });

  it("rejects different options with DEVTOOLS_RELAY_ALREADY_STARTED", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    const relay = await start(page);
    expect(relay.active).toBe(true);
    const rejected = await rejectionOf(
      createServiceWorkerRelay(page.environment, { timeout: 100 }),
    );
    expect(rejected).toBeInstanceOf(SchmockError);
    expect(rejected).toMatchObject({ code: "DEVTOOLS_RELAY_ALREADY_STARTED" });
    const message = (rejected as Error).message;
    expect(message).toContain('"timeout":5000');
    expect(message).toContain('"timeout":100');
  });

  it("starts afresh after stop()", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    const first = begin(page);
    const firstRelay = await first;
    relays.push(firstRelay);
    await firstRelay.stop();
    const calls = harnessed.registerCalls.length;
    const second = begin(page);
    expect(second).not.toBe(first);
    const secondRelay = await second;
    relays.push(secondRelay);
    expect(secondRelay).not.toBe(firstRelay);
    expect(secondRelay.active).toBe(true);
    expect(harnessed.registerCalls.length).toBe(calls + 1);
  });

  it("starts afresh after a fallback", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker({ onHello: () => {} }));
    const page = harnessed.openPage();
    const first = await start(page, { timeout: 50 });
    expect(first.fallbackReason).toBe("timeout");
    const calls = harnessed.registerCalls.length;
    const second = await start(page, { timeout: 50 });
    expect(second).not.toBe(first);
    expect(harnessed.registerCalls.length).toBe(calls + 1);
  });
});

describe("PR22 one teardown", () => {
  it("leaves nothing behind after a timeout fallback", async () => {
    const harnessed = harness();
    let helloCount = 0;
    let firstPortClosed = false;
    const seenB: Seen[] = [];
    harnessed.installWorker(
      stubWorker({
        onHello: (event) => {
          helloCount += 1;
          if (helloCount === 1) {
            event.ports[0]?.addEventListener("close", () => {
              firstPortClosed = true;
            });
            return;
          }
          answerReady(event);
        },
      }),
    );
    const page = harnessed.openPage();
    const first = await start(page, { timeout: 50 });
    expect(first.fallbackReason).toBe("timeout");
    await vi.waitFor(() => expect(firstPortClosed).toBe(true), {
      timeout: 2000,
    });
    const second = await start(page);
    expect(second.active).toBe(true);
    await harnessed.replaceWorker(stubWorker({ seen: seenB }));
    await vi.waitFor(() => expect(second.active).toBe(true), { timeout: 2000 });
    await harnessed.flush();
    expect(ofType(seenB, "schmock:hello")).toHaveLength(1);
  });

  it("warns once for an early fallback even after the deadline would have passed", async () => {
    const harnessed = harness();
    harnessed.installWorker(
      stubWorker({ onHello: (e) => answerReady(e, { protocol: 99 }) }),
    );
    const relay = await start(harnessed.openPage(), { timeout: 50 });
    expect(relay.fallbackReason).toBe("protocol-mismatch");
    await delay(120);
    expect(relay.fallbackReason).toBe("protocol-mismatch");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clears the deadline once live", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const relay = await start(harnessed.openPage(), { timeout: 50 });
    expect(relay.active).toBe(true);
    await delay(120);
    expect(relay.active).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("PR23 startServiceWorkerRelay reads globals at call time", () => {
  it("uses navigator, isSecureContext, document and pagehide", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const seen: Seen[] = [];
    harnessed.installWorker(stubWorker({ seen }));
    const page = harnessed.openPage();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: containerOf(page) });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("document", { baseURI: "http://localhost/index.html" });
    vi.stubGlobal("addEventListener", addEventListener);
    vi.stubGlobal("removeEventListener", removeEventListener);

    const relay = await startServiceWorkerRelay();
    relays.push(relay);
    expect(relay.active).toBe(true);
    const pagehide = addEventListener.mock.calls.filter(
      ([type]) => type === "pagehide",
    );
    expect(pagehide).toHaveLength(1);
    const handler: unknown = pagehide[0][1];
    expect(typeof handler).toBe("function");
    if (typeof handler === "function") handler({ persisted: false });
    await harnessed.flush();
    const goodbyes = ofType(seen, "schmock:goodbye");
    expect(goodbyes).toHaveLength(1);
    expect(goodbyes[0].ports).toBe(0);
    expect(removeEventListener).toHaveBeenCalledWith("pagehide", handler);
  });

  it("resolves the url against location.href, then document.baseURI", async () => {
    const harnessed = harness();
    harnessed.serveScript(false);
    const page = harnessed.openPage();
    vi.stubGlobal("navigator", { serviceWorker: containerOf(page) });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("location", { href: "http://localhost/x/index.html" });
    const viaLocation = await startServiceWorkerRelay({ url: "schmock-sw.js" });
    expect(viaLocation.fallbackReason).toBe("registration-failed");
    expect(String(warn.mock.calls[0][0])).toContain(
      "http://localhost/x/schmock-sw.js",
    );
    warn.mockClear();
    vi.stubGlobal("document", { baseURI: "http://localhost/y/" });
    // An explicit "/" scope keeps the /x/ page in scope of a /y/ script.
    const viaDocument = await startServiceWorkerRelay({
      url: "schmock-sw.js",
      scope: "/",
    });
    expect(viaDocument.fallbackReason).toBe("registration-failed");
    expect(String(warn.mock.calls[0][0])).toContain(
      "http://localhost/y/schmock-sw.js",
    );
  });

  it("is unsupported in Node", async () => {
    const relay = await startServiceWorkerRelay();
    expect(relay.active).toBe(false);
    expect(relay.fallbackReason).toBe("unsupported");
    expect(warn).toHaveBeenCalledWith(TEXT.unsupported);
  });
});

describe("PR26 scope pre-check", () => {
  it("falls back at once for a page outside the script's directory, registering nothing", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker(), "/mocks/schmock-sw.js");
    const page = harnessed.openPage({ path: "/index.html" });
    const relay = await start(page, {
      url: "/mocks/schmock-sw.js",
      timeout: 60_000,
    });
    expect(relay.fallbackReason).toBe("not-controlled");
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "can only control pages under http://localhost/mocks/",
    );
    expect(harnessed.registerCalls).toEqual([]);
  });

  it("checks the URL the document was created at, not the one pushState moved to", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker(), "/mocks/schmock-sw.js");
    const page = harnessed.openPage({ path: "/mocks/index.html" });
    vi.stubGlobal("navigator", { serviceWorker: containerOf(page) });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("location", { href: "http://localhost/elsewhere" });
    vi.spyOn(performance, "getEntriesByType").mockImplementation((type) =>
      type === "navigation"
        ? ([
            { name: "http://localhost/mocks/index.html" },
          ] as unknown as PerformanceEntryList)
        : [],
    );
    const relay = await startServiceWorkerRelay({
      url: "/mocks/schmock-sw.js",
    });
    relays.push(relay);
    expect(relay.active).toBe(true);
  });

  it("leaves a srcdoc document to register and claim as before", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    const page = harnessed.openPage();
    const relay = await createServiceWorkerRelay({
      ...page.environment,
      pageUrl: "about:srcdoc",
    });
    relays.push(relay);
    expect(harnessed.registerCalls).toHaveLength(1);
  });

  it("skips the check for a page the Schmock worker already controls", async () => {
    const harnessed = harness();
    harnessed.installWorker(stubWorker());
    await harnessed.activateWorker();
    const page = harnessed.openPage();
    // A srcdoc iframe inherits its parent's controller under another URL.
    const relay = await createServiceWorkerRelay({
      ...page.environment,
      pageUrl: "about:srcdoc",
    });
    relays.push(relay);
    expect(relay.active).toBe(true);
  });
});

describe("PR24 import has no side effects", () => {
  it("reads no global at import, only at call time", async () => {
    vi.resetModules();
    let reads = 0;
    const addEventListener = vi.fn();
    stubGetter("navigator", () => {
      reads += 1;
      return {};
    });
    stubGetter("document", () => {
      reads += 1;
      return { baseURI: "http://localhost/" };
    });
    stubGetter("location", () => {
      reads += 1;
      return { href: "http://localhost/" };
    });
    vi.stubGlobal("addEventListener", addEventListener);

    const mod = await import("./page-relay.js");
    await import("../index.js");
    expect(reads).toBe(0);
    expect(addEventListener).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    const relay = await mod.startServiceWorkerRelay();
    expect(relay.fallbackReason).toBe("unsupported");
    expect(reads).toBeGreaterThan(0);
  });
});

describe("PR25 package root entry", () => {
  it("re-exports the same function, exposes only the two runtime names", async () => {
    const root = await import("../index.js");
    const relayModule = await import("./page-relay.js");
    expect(root.startServiceWorkerRelay).toBe(
      relayModule.startServiceWorkerRelay,
    );
    expect(Object.keys(root).sort()).toEqual([
      "devtoolsPlugin",
      "startServiceWorkerRelay",
    ]);
    const relay = await root.startServiceWorkerRelay();
    expect(relay.fallbackReason).toBe("unsupported");
  });
});
