import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRelayHarness,
  type FakePage,
  type FakeWorkerScope,
  type RelayHarness,
} from "../test-support/relay-harness.js";
import type {
  ExtendableMessageEventLike,
  PageToWorkerMessage,
  RelayWorkerScope,
} from "./types.js";
import { installRelayWorker, isRelayCandidate } from "./worker.js";

// The protocol constants are pinned as literals from the contract so this
// file does not depend on protocol.ts landing first.
const PROTOCOL = 1;
const REGISTRY_CACHE = "schmock-relay-v1";
const REGISTRY_URL = "http://localhost/__schmock-relay/clients";
const VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

const originalFetch = globalThis.fetch;
let h: RelayHarness;
let sentinel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sentinel = vi.fn(async () => {
    throw new Error("global fetch used");
  });
  globalThis.fetch = sentinel;
  h = createRelayHarness();
});

afterEach(() => {
  h.dispose();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const delay = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

function controllerOf(page: FakePage) {
  const controller = page.environment.container?.controller;
  if (!controller) throw new Error("page is not controlled");
  return controller;
}

/** Send a message to the page's controller; resolves with the first reply on the sent port. */
function send(page: FakePage, message: unknown, withPort = true) {
  const channel = new MessageChannel();
  const replies: unknown[] = [];
  let closed = false;
  channel.port1.addEventListener("close", () => {
    closed = true;
  });
  channel.port1.onmessage = (event) => {
    replies.push(event.data);
  };
  // Foreign messages are deliberately not PageToWorkerMessage.
  const post = controllerOf(page).postMessage as any;
  post.call(controllerOf(page), message, withPort ? [channel.port2] : []);
  return {
    replies,
    isClosed: () => closed,
    first: () =>
      vi.waitFor(
        () => {
          if (replies.length === 0) throw new Error("no reply yet");
          return replies[0];
        },
        { timeout: 2000 },
      ),
  };
}

function hello(page: FakePage, protocol = PROTOCOL) {
  const message: PageToWorkerMessage = {
    type: "schmock:hello",
    protocol,
    version: VERSION,
  };
  return send(page, message);
}

const READY = { type: "schmock:ready", protocol: PROTOCOL, version: VERSION };

async function stored(key = REGISTRY_URL): Promise<unknown> {
  const cache = await h.caches.open(REGISTRY_CACHE);
  const response = await cache.match(key);
  return response ? await response.json() : undefined;
}

interface Frame {
  readonly data: unknown;
  readonly ports: number;
  readonly port: MessagePort | undefined;
}

/** Make `page` answer every relayed frame with reply(frame); records the frames. */
function answerFrames(
  page: FakePage,
  reply: ((frame: Frame) => unknown) | undefined,
) {
  const frames: Frame[] = [];
  const container = page.environment.container;
  if (!container) throw new Error("no container");
  container.addEventListener("message", (event) => {
    const frame = {
      data: event.data,
      ports: event.ports.length,
      port: event.ports[0],
    };
    frames.push(frame);
    if (reply) {
      frame.port?.postMessage(reply(frame));
      frame.port?.close();
    }
  });
  container.startMessages();
  return frames;
}

function req(
  props: { mode?: string; destination?: string; cache?: string } = {},
) {
  const request = new Request("http://localhost/x");
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(request, key, { value });
  }
  return request;
}

async function registered(path?: string): Promise<FakePage> {
  const page = h.openPage(path ? { path } : undefined);
  expect(await hello(page).first()).toEqual(READY);
  return page;
}

async function relayWorker(): Promise<void> {
  h.installWorker(installRelayWorker);
  await h.activateWorker();
  await h.flush();
}

function bytesOf(value: unknown): number[] {
  if (!(value instanceof ArrayBuffer)) throw new Error("not an ArrayBuffer");
  return [...new Uint8Array(value)];
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

describe("isRelayCandidate", () => {
  it("W1 rejects navigations, subresources and uncontrolled clients, accepts fetch/XHR shapes", () => {
    expect(isRelayCandidate(req({ mode: "cors" }), "")).toBe(false);
    expect(isRelayCandidate(req({ mode: "navigate" }), "c1")).toBe(false);
    expect(isRelayCandidate(req({ destination: "script" }), "c1")).toBe(false);
    expect(isRelayCandidate(req({ destination: "image" }), "c1")).toBe(false);
    expect(
      isRelayCandidate(req({ cache: "only-if-cached", mode: "cors" }), "c1"),
    ).toBe(false);
    expect(isRelayCandidate(req({ destination: "", mode: "cors" }), "c1")).toBe(
      true,
    );
    expect(
      isRelayCandidate(
        req({ cache: "only-if-cached", mode: "same-origin" }),
        "c1",
      ),
    ).toBe(true);
  });
});

describe("lifecycle", () => {
  it("W2 skips waiting on install, claims before matchAll on activate, and takes over uncontrolled pages", async () => {
    const scopes: FakeWorkerScope[] = [];
    const wrapped = (installed: FakeWorkerScope) => {
      vi.spyOn(installed, "skipWaiting");
      vi.spyOn(installed.clients, "claim");
      vi.spyOn(installed.clients, "matchAll");
      scopes.push(installed);
      installRelayWorker(installed);
    };
    h.installWorker(wrapped);
    await h.activateWorker();
    const scope = scopes[0];
    expect(scope.skipWaiting).toHaveBeenCalledTimes(1);
    expect(scope.clients.claim).toHaveBeenCalled();
    expect(scope.clients.matchAll).toHaveBeenCalledWith({
      includeUncontrolled: true,
      type: "all",
    });
    const claimOrder = vi.mocked(scope.clients.claim).mock
      .invocationCallOrder[0];
    const matchOrder = vi.mocked(scope.clients.matchAll).mock
      .invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(matchOrder);

    const pageB = h.openPage({ controlled: false });
    expect(pageB.environment.container?.controller).toBeNull();
    const pageA = h.openPage();
    send(pageA, { type: "schmock:claim" }, false);
    await h.flush();
    expect(pageB.environment.container?.controller?.scriptURL).toBe(
      "http://localhost/schmock-sw.js",
    );
  });

  it("W2 activates an in-use update without waiting", async () => {
    h.installWorker(installRelayWorker);
    await h.activateWorker();
    const page = h.openPage();
    const container = page.environment.container;
    if (!container) throw new Error("no container");
    h.installWorker(installRelayWorker);
    await container.register("/schmock-sw.js");
    await h.flush();
    const registration = await container.getRegistration();
    expect(registration?.waiting).toBeNull();
    expect(registration?.active?.state).toBe("activated");
  });
});

describe("messages", () => {
  it("W3 registers durably before answering ready", async () => {
    await relayWorker();
    const page = h.openPage();
    const release = h.caches.hold();
    const sent = hello(page);
    let flushed = false;
    const flushing = h.flush().then(() => {
      flushed = true;
    });
    await delay();
    expect(sent.replies).toEqual([]);
    expect(flushed).toBe(false);

    release();
    expect(await sent.first()).toEqual(READY);
    await flushing;
    expect(await stored()).toContain(page.id);
    await vi.waitFor(() => expect(sent.isClosed()).toBe(true), {
      timeout: 2000,
    });
  });

  it("W4 answers ready to a mismatched protocol but does not register", async () => {
    await relayWorker();
    const page = h.openPage();
    const reply = await hello(page, 2).first();
    expect(reply).toEqual({
      type: "schmock:ready",
      protocol: 1,
      version: VERSION,
    });
    await h.flush();
    expect(await stored()).not.toContain(page.id);
    const response = await page.xhr("/api/x");
    expect(await response.text()).toBe("real network");
    expect(page.browserLog.at(-1)?.servedBy).toBe("network");
    expect(page.relayedFrames).toEqual([]);
  });

  it("W5 goodbye deletes durably before released", async () => {
    await relayWorker();
    const page = await registered();
    expect(await stored()).toContain(page.id);
    const release = h.caches.hold();
    const bye = send(page, { type: "schmock:goodbye" });
    await delay();
    expect(bye.replies).toEqual([]);
    release();
    expect(await bye.first()).toEqual({ type: "schmock:released" });
    expect(await stored()).not.toContain(page.id);
    const response = await page.xhr("/api/x");
    expect(await response.text()).toBe("real network");
    expect(page.browserLog.at(-1)?.servedBy).toBe("network");
    expect(page.relayedFrames).toEqual([]);
  });

  it("W5 goodbye without a port deletes the id and posts nothing", async () => {
    await relayWorker();
    const page = await registered();
    expect(await stored()).toContain(page.id);
    const bye = send(page, { type: "schmock:goodbye" }, false);
    await h.flush();
    expect(bye.replies).toEqual([]);
    expect(await stored()).not.toContain(page.id);
    await page.xhr("/api/x");
    expect(page.browserLog.at(-1)?.servedBy).toBe("network");
  });

  it("W7 ignores foreign messages", async () => {
    await relayWorker();
    const known = await registered();
    const intruder = h.openPage();
    const before = await stored();
    expect(before).toEqual([known.id]);
    const attempts = [
      send(intruder, { type: "other" }),
      send(intruder, "x"),
      send(intruder, null),
      send(intruder, { type: "schmock:hello", protocol: "1", version: "v" }),
    ];
    await h.flush();
    await delay();
    for (const attempt of attempts) expect(attempt.replies).toEqual([]);
    expect(await stored()).toEqual(before);
  });

  it("W7 handles a message without a source in waitUntil and ignores it", async () => {
    await relayWorker();
    const listeners: ((event: ExtendableMessageEventLike) => void)[] = [];
    const fake: RelayWorkerScope = {
      addEventListener(
        type: string,
        listener: (event: ExtendableMessageEventLike) => void,
      ) {
        if (type === "message") listeners.push(listener);
      },
      skipWaiting: async () => {},
      clients: {
        claim: async () => {},
        get: async () => undefined,
        matchAll: async () => [],
      },
      caches: undefined,
      registration: { scope: "http://localhost/" },
      fetch: async () => new Response("net"),
    };
    installRelayWorker(fake);
    expect(listeners).toHaveLength(1);
    const validHello = {
      type: "schmock:hello",
      protocol: PROTOCOL,
      version: VERSION,
    };

    // positive control: with a source the hello is answered
    const withSource = new MessageChannel();
    const got: unknown[] = [];
    withSource.port1.onmessage = (e) => got.push(e.data);
    const waitA = vi.fn();
    listeners[0]({
      data: validHello,
      source: { id: "c1" },
      ports: [withSource.port2],
      waitUntil: waitA,
    });
    expect(waitA).toHaveBeenCalledTimes(1);
    await waitA.mock.calls[0][0];
    await vi.waitFor(() => expect(got).toEqual([READY]), { timeout: 2000 });

    const sourceless = new MessageChannel();
    const none: unknown[] = [];
    sourceless.port1.onmessage = (e) => none.push(e.data);
    const waitB = vi.fn();
    listeners[0]({
      data: validHello,
      source: null,
      ports: [sourceless.port2],
      waitUntil: waitB,
    });
    expect(waitB).toHaveBeenCalledTimes(1);
    await waitB.mock.calls[0][0];
    await delay();
    expect(none).toEqual([]);
    withSource.port1.close();
    sourceless.port1.close();
  });
});

describe("fetch", () => {
  it("W8 stays out of non-candidates and unregistered clients", async () => {
    await relayWorker();
    const page = h.openPage();
    await page.respondToRelaysWith({ tab: "A" });
    const other = h.openPage();

    await page.load("/a.js", { destination: "script" });
    await page.load("/next.html", { mode: "navigate" });
    await other.xhr("/api/x");

    expect(page.browserLog.map((e) => e.servedBy)).toEqual([
      "network",
      "network",
    ]);
    expect(other.browserLog.map((e) => e.servedBy)).toEqual(["network"]);
    expect(page.relayedFrames).toEqual([]);

    // positive control: the registered page's XHR is relayed
    const relayed = await page.xhr("/api/users");
    expect(await relayed.json()).toEqual({ tab: "A" });
    expect(page.relayedFrames).toHaveLength(1);
  });

  it("W9 relays to the requesting client only and rebuilds the reply", async () => {
    await relayWorker();
    const a = await registered();
    const b = await registered();
    const body = new Uint8Array([9, 8, 7]).buffer;
    const framesA = answerFrames(a, () => ({
      type: "schmock:response",
      response: {
        status: 201,
        statusText: "Created",
        headers: [["x-total-count", "42"]],
        body,
      },
    }));
    const framesB = answerFrames(b, () => ({ type: "schmock:passthrough" }));

    const response = await a.xhr("/api/blob", {
      method: "POST",
      body: Uint8Array.from([0, 1, 2, 255]),
      headers: { "content-type": "application/octet-stream" },
    });

    expect(framesA).toHaveLength(1);
    expect(framesB).toEqual([]);
    const frame = framesA[0];
    expect(frame.data).toMatchObject({
      type: "schmock:request",
      request: { url: "http://localhost/api/blob", method: "POST" },
    });
    expect(frame.ports).toBe(1);
    const request = field(frame.data, "request");
    expect(field(request, "headers")).toContainEqual([
      "content-type",
      "application/octet-stream",
    ]);
    expect(bytesOf(field(request, "body"))).toEqual([0, 1, 2, 255]);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-total-count")).toBe("42");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      9, 8, 7,
    ]);
    expect(a.browserLog.at(-1)?.servedBy).toBe("worker");
  });

  it("W10 rebuilds a 204 with or without a body", async () => {
    await relayWorker();
    const page = await registered();
    let withBody = false;
    answerFrames(page, () => ({
      type: "schmock:response",
      response: {
        status: 204,
        statusText: "",
        headers: [],
        body: withBody ? new Uint8Array([1, 2]).buffer : null,
      },
    }));
    const plain = await page.xhr("/api/x");
    expect(plain.status).toBe(204);
    expect(await plain.text()).toBe("");
    withBody = true;
    const odd = await page.xhr("/api/x");
    expect(odd.status).toBe(204);
    expect(await odd.text()).toBe("");
  });

  it("W11 passes through with scope.fetch and an unread body", async () => {
    await relayWorker();
    const page = await registered();
    answerFrames(page, () => ({ type: "schmock:passthrough" }));

    const response = await page.xhr("/api/p", {
      method: "POST",
      body: "payload",
    });

    expect(await response.text()).toBe("real network");
    expect(h.network).toHaveBeenCalledTimes(1);
    const forwarded = h.network.mock.calls[0][0];
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe("http://localhost/api/p");
    expect(forwarded.bodyUsed).toBe(false);
    expect(await forwarded.text()).toBe("payload");
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("W12 maps error, aborted and unknown replies to a network error", async () => {
    await relayWorker();
    const page = await registered();
    const replies = [
      { type: "schmock:error", error: { name: "Error", message: "x" } },
      { type: "schmock:aborted" },
      { type: "nope" },
    ];
    let index = 0;
    answerFrames(page, () => replies[index++]);
    for (let i = 0; i < replies.length; i++) {
      await expect(page.xhr("/api/x")).rejects.toMatchObject({
        name: "TypeError",
        message: "Failed to fetch",
      });
    }
    expect(index).toBe(3);
  });

  it("W13 forwards an abort to the page on the request port", async () => {
    await relayWorker();
    const page = await registered();
    const frames = answerFrames(page, undefined);
    const portMessages: unknown[] = [];
    const controller = new AbortController();
    const pending = page.xhr("/api/slow", { signal: controller.signal });
    await vi.waitFor(() => expect(frames).toHaveLength(1), { timeout: 2000 });
    const port = frames[0].port;
    if (!port) throw new Error("no port");
    port.onmessage = (event) => portMessages.push(event.data);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(
      () => expect(portMessages).toContainEqual({ type: "schmock:abort" }),
      { timeout: 2000 },
    );
    port.close();
  });

  it("W14 falls back to scope.fetch for a client it cannot find, and keeps its id", async () => {
    await relayWorker();
    const page = h.openPage();
    await page.respondToRelaysWith({ tab: "A" });
    expect(await stored()).toContain(page.id);

    page.close();
    const response = await page.xhr("/api/x");

    expect(await response.text()).toBe("real network");
    expect(page.browserLog.at(-1)?.servedBy).toBe("worker");
    expect(h.network).toHaveBeenCalled();
    await h.flush();
    expect(await stored()).toContain(page.id);
    expect(sentinel).not.toHaveBeenCalled();
  });
});

describe("restarts", () => {
  it("W15 reloads the registry from caches after a restart", async () => {
    await relayWorker();
    const page = h.openPage();
    await page.respondToRelaysWith({ tab: "A" });
    h.restartWorker();
    const response = await page.xhr("/api/users");
    expect(await response.json()).toEqual({ tab: "A" });
    expect(page.browserLog.at(-1)?.servedBy).toBe("worker");
  });

  it("W16 responds at once while the registry loads, then relays or forwards", async () => {
    await relayWorker();
    const a = h.openPage();
    await a.respondToRelaysWith({ tab: "A" });
    const b = h.openPage();
    await h.flush();

    const release = h.caches.hold();
    h.restartWorker();
    let aSettled = false;
    let bSettled = false;
    const pa = a.xhr("/api/users").finally(() => {
      aSettled = true;
    });
    const pb = b.xhr("/api/users").finally(() => {
      bSettled = true;
    });
    await delay();
    expect(aSettled).toBe(false);
    expect(bSettled).toBe(false);
    expect(h.network).not.toHaveBeenCalled();
    // respondWith happened at once: the browser logged neither as network
    expect(a.browserLog).toEqual([]);
    expect(b.browserLog).toEqual([]);

    release();
    const ra = await pa;
    const rb = await pb;
    expect(await ra.json()).toEqual({ tab: "A" });
    expect(a.browserLog.at(-1)?.servedBy).toBe("worker");
    expect(await rb.text()).toBe("real network");
    expect(b.browserLog.at(-1)?.servedBy).toBe("worker");
    expect(h.network).toHaveBeenCalledTimes(1);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("W17 a restart prunes nothing, only activation prunes", async () => {
    await relayWorker();
    const a = h.openPage();
    await a.respondToRelaysWith({ tab: "A" });
    a.hide(true);
    h.restartWorker();
    await h.flush();
    expect(await stored()).toContain(a.id);

    a.show();
    await h.flush();
    const response = await a.xhr("/api/users");
    expect(await response.json()).toEqual({ tab: "A" });
    expect(a.browserLog.at(-1)?.servedBy).toBe("worker");

    a.hide(true);
    await h.replaceWorker();
    expect(await stored()).not.toContain(a.id);

    expect(
      readFileSync(new URL("./worker.ts", import.meta.url), "utf8"),
    ).toContain("Never prune on worker start");
  });
});

describe("registry location", () => {
  it("W18 stores under the cache name and a key derived from the scope", async () => {
    await relayWorker();
    const root = await registered();
    expect(await stored("http://localhost/__schmock-relay/clients")).toContain(
      root.id,
    );
  });

  it("W18 derives the key from a nested scope", async () => {
    h.installWorker(installRelayWorker, "/mocks/schmock-sw.js");
    await h.activateWorker();
    await h.flush();
    const page = await registered("/mocks/index.html");
    expect(
      await stored("http://localhost/mocks/__schmock-relay/clients"),
    ).toContain(page.id);
    expect(await stored("http://localhost/__schmock-relay/clients")).toBe(
      undefined,
    );
  });
});
