import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ask,
  DEFAULT_WORKER_URL,
  deserializeRequest,
  deserializeResponse,
  isAbortRequestMessage,
  isPageToWorkerMessage,
  isReadyMessage,
  isRelayReply,
  isReleasedMessage,
  isRequestMessage,
  NULL_BODY_STATUSES,
  REGISTRY_KEY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_REGISTRY_CACHE,
  RELAY_VERSION,
  serializeRequest,
  serializeResponse,
  transferablesOf,
} from "./protocol.js";

const bytesOf = (buffer: ArrayBuffer | null): number[] =>
  buffer === null ? [] : [...new Uint8Array(buffer)];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const serializedRequest = {
  url: "http://localhost/a",
  method: "POST",
  headers: [["x-a", "1"]] as [string, string][],
  body: new Uint8Array([1, 2]).buffer,
};
const serializedResponse = {
  status: 200,
  statusText: "OK",
  headers: [["x-a", "1"]] as [string, string][],
  body: null,
};

const hello = { type: "schmock:hello", protocol: 1, version: "2.5.0" };
const goodbye = { type: "schmock:goodbye" };
const claim = { type: "schmock:claim" };
const ready = { type: "schmock:ready", protocol: 1, version: "2.5.0" };
const released = { type: "schmock:released" };
const requestMessage = { type: "schmock:request", request: serializedRequest };
const replies = {
  response: { type: "schmock:response", response: serializedResponse },
  passthrough: { type: "schmock:passthrough" },
  error: { type: "schmock:error", error: { name: "Error", message: "x" } },
  aborted: { type: "schmock:aborted" },
};
const abortMessage = { type: "schmock:abort" };

describe("relay protocol constants", () => {
  it("P1 pins the constants", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(RELAY_PROTOCOL_VERSION).toBe(1);
    expect(RELAY_VERSION).toBe(manifest.version);
    expect(DEFAULT_WORKER_URL).toBe("/schmock-sw.js");
    expect(RELAY_REGISTRY_CACHE).toBe("schmock-relay-v1");
    expect(REGISTRY_KEY_PATH).toBe("__schmock-relay/clients");
    expect([...NULL_BODY_STATUSES].sort()).toEqual([204, 205, 304]);
  });
});

describe("relay type guards", () => {
  it("P2 accepts each exact shape, extra properties included", () => {
    for (const m of [hello, goodbye, claim]) {
      expect(isPageToWorkerMessage(m)).toBe(true);
      expect(isPageToWorkerMessage({ ...m, extra: 1 })).toBe(true);
    }
    expect(isReadyMessage(ready)).toBe(true);
    expect(isReadyMessage({ ...ready, extra: 1 })).toBe(true);
    expect(isReleasedMessage(released)).toBe(true);
    expect(isReleasedMessage({ ...released, extra: 1 })).toBe(true);
    expect(isRequestMessage(requestMessage)).toBe(true);
    expect(isRequestMessage({ ...requestMessage, extra: 1 })).toBe(true);
    expect(
      isRequestMessage({
        ...requestMessage,
        request: { ...serializedRequest, body: null },
      }),
    ).toBe(true);
    for (const r of Object.values(replies)) {
      expect(isRelayReply(r)).toBe(true);
      expect(isRelayReply({ ...r, extra: 1 })).toBe(true);
    }
    expect(isAbortRequestMessage(abortMessage)).toBe(true);
    expect(isAbortRequestMessage({ ...abortMessage, extra: 1 })).toBe(true);
  });

  it("P3 rejects non-objects, foreign shapes and wrong field types", () => {
    const guards: [(v: unknown) => boolean, unknown[]][] = [
      [isPageToWorkerMessage, [hello, goodbye, claim]],
      [isReadyMessage, [ready]],
      [isReleasedMessage, [released]],
      [isRequestMessage, [requestMessage]],
      [isRelayReply, Object.values(replies)],
      [isAbortRequestMessage, [abortMessage]],
    ];
    const allValid = guards.flatMap(([, v]) => v);
    for (const [guard, own] of guards) {
      for (const bad of [null, undefined, "schmock:ready", 1, [], {}]) {
        expect(guard(bad)).toBe(false);
      }
      for (const foreign of allValid.filter((v) => !own.includes(v))) {
        expect(guard(foreign)).toBe(false);
      }
    }
    expect(isPageToWorkerMessage({ ...hello, version: 1 })).toBe(false);
    expect(isReadyMessage({ ...ready, protocol: "1" })).toBe(false);
    const withBody = (body: unknown) => ({
      type: "schmock:request",
      request: { ...serializedRequest, body },
    });
    expect(
      isRequestMessage({
        type: "schmock:request",
        request: { ...serializedRequest, headers: [["a"]] },
      }),
    ).toBe(false);
    expect(isRequestMessage(withBody("x"))).toBe(false);
    expect(isRequestMessage(withBody(new Uint8Array([1])))).toBe(false);
    const { statusText: _s, ...noStatusText } = serializedResponse;
    expect(
      isRelayReply({ type: "schmock:response", response: noStatusText }),
    ).toBe(false);
    expect(
      isRelayReply({
        type: "schmock:error",
        error: { name: "Error", message: 5 },
      }),
    ).toBe(false);
  });
});

describe("request serialization", () => {
  it("P4 serializeRequest", async () => {
    const get = await serializeRequest(
      new Request("http://localhost/a", { headers: { "x-a": "1" } }),
    );
    expect(get).toEqual({
      url: "http://localhost/a",
      method: "GET",
      headers: [["x-a", "1"]],
      body: null,
    });
    expect(
      (
        await serializeRequest(
          new Request("http://localhost/a", { method: "HEAD" }),
        )
      ).body,
    ).toBeNull();
    expect(
      (
        await serializeRequest(
          new Request("http://localhost/a", { method: "POST" }),
        )
      ).body,
    ).toBeNull();

    const empty = await serializeRequest(
      new Request("http://localhost/a", {
        method: "POST",
        body: new ArrayBuffer(0),
      }),
    );
    expect(empty.body).toBeInstanceOf(ArrayBuffer);
    expect(empty.body?.byteLength).toBe(0);

    const json = await serializeRequest(
      new Request("http://localhost/a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"Ada"}',
      }),
    );
    expect(bytesOf(json.body)).toEqual([
      ...new TextEncoder().encode('{"name":"Ada"}'),
    ]);
    expect(json.headers).toContainEqual(["content-type", "application/json"]);

    const form = new FormData();
    form.append("k", "v");
    const multipart = await serializeRequest(
      new Request("http://localhost/a", { method: "POST", body: form }),
    );
    const contentType =
      multipart.headers.find(([n]) => n === "content-type")?.[1] ?? "";
    expect(contentType.startsWith("multipart/form-data; boundary=")).toBe(true);
    const boundary = contentType.slice("multipart/form-data; boundary=".length);
    expect(
      new TextDecoder().decode(multipart.body ?? new ArrayBuffer(0)),
    ).toContain(boundary);
  });

  it("P5 deserializeRequest restores the request and carries the signal", async () => {
    const original = await serializeRequest(
      new Request("http://localhost/a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"Ada"}',
      }),
    );
    const controller = new AbortController();
    const request = deserializeRequest(original, controller.signal);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost/a");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.text()).toBe('{"name":"Ada"}');
    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);

    const get = deserializeRequest(
      { url: "http://localhost/g", method: "GET", headers: [], body: null },
      new AbortController().signal,
    );
    expect(get.method).toBe("GET");
    expect(get.url).toBe("http://localhost/g");
  });
});

describe("response serialization", () => {
  it("P6 round trips a binary response; empty bodies are null", async () => {
    const serialized = await serializeResponse(
      new Response(Uint8Array.from([0, 1, 2, 255]), {
        status: 201,
        statusText: "Created",
        headers: { "x-total-count": "42" },
      }),
    );
    expect(serialized.status).toBe(201);
    expect(serialized.statusText).toBe("Created");
    expect(serialized.headers).toContainEqual(["x-total-count", "42"]);
    expect(bytesOf(serialized.body)).toEqual([0, 1, 2, 255]);
    const back = deserializeResponse(serialized);
    expect(back.status).toBe(201);
    expect(back.statusText).toBe("Created");
    expect(back.headers.get("x-total-count")).toBe("42");
    expect([...new Uint8Array(await back.arrayBuffer())]).toEqual([
      0, 1, 2, 255,
    ]);

    expect((await serializeResponse(new Response(""))).body).toBeNull();
    expect((await serializeResponse(new Response(null))).body).toBeNull();
  });

  it("P7 null-body statuses never throw and carry no body", () => {
    for (const status of [204, 205, 304]) {
      const response = deserializeResponse({
        status,
        statusText: "",
        headers: [],
        body: new Uint8Array([1]).buffer,
      });
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    }
  });

  it("P8 transferablesOf", () => {
    const body = new ArrayBuffer(2);
    const list = transferablesOf({ ...serializedResponse, body });
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(body);
    expect(transferablesOf(serializedResponse)).toEqual([]);
    expect(transferablesOf({ ...serializedRequest, body: null })).toEqual([]);
  });
});

describe("ask", () => {
  const channels: MessageChannel[] = [];
  afterEach(() => {
    for (const c of channels.splice(0)) {
      c.port1.close();
      c.port2.close();
    }
    vi.useRealTimers();
  });

  function setup() {
    const relay = new MessageChannel();
    channels.push(relay);
    const received: { data: unknown; ports: readonly MessagePort[] }[] = [];
    relay.port2.onmessage = (e) =>
      received.push({ data: e.data, ports: e.ports });
    const target = {
      postMessage: (m: unknown, t: Transferable[]) =>
        relay.port1.postMessage(m, t),
    };
    return { relay, received, target };
  }
  const closed = (port: MessagePort) => {
    let flag = false;
    port.addEventListener("close", () => {
      flag = true;
    });
    return () => flag;
  };

  it("P9 round trip: first reply wins, transfer detaches, port closes", async () => {
    const { received, target } = setup();
    const buffer = new Uint8Array([7, 8, 9]).buffer;
    const pending = ask(target, { type: "x", n: 1 }, { transfer: [buffer] });
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    expect(received[0].data).toEqual({ type: "x", n: 1 });
    expect(received[0].ports).toHaveLength(1);
    expect(buffer.byteLength).toBe(0);
    const port = received[0].ports[0];
    const isClosed = closed(port);
    port.postMessage("first");
    port.postMessage("second");
    expect(await pending).toBe("first");
    await vi.waitFor(() => expect(isClosed()).toBe(true), { timeout: 2000 });
  });

  it("P9b a transferred buffer arrives intact", async () => {
    const relay = new MessageChannel();
    channels.push(relay);
    const target = {
      postMessage: (m: unknown, t: Transferable[]) =>
        relay.port1.postMessage(m, t),
    };
    const arrived = new Promise<MessageEvent>((r) => {
      relay.port2.onmessage = r;
    });
    const buffer = new Uint8Array([7, 8, 9]).buffer;
    const pending = ask(
      target,
      { type: "x", body: buffer },
      { transfer: [buffer] },
    );
    const event = await arrived;
    const sent = Reflect.get(event.data, "body");
    expect(bytesOf(sent)).toEqual([7, 8, 9]);
    event.ports[0].postMessage("ok");
    expect(await pending).toBe("ok");
  });

  it("P10 abortSignal posts schmock:abort and keeps waiting", async () => {
    const { received, target } = setup();
    const controller = new AbortController();
    let settled = false;
    const pending = ask(
      target,
      { type: "x" },
      { abortSignal: controller.signal },
    ).then((v) => {
      settled = true;
      return v;
    });
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    const port = received[0].ports[0];
    const onPort: unknown[] = [];
    port.onmessage = (e) => onPort.push(e.data);
    controller.abort();
    await vi.waitFor(
      () => expect(onPort).toEqual([{ type: "schmock:abort" }]),
      { timeout: 2000 },
    );
    await delay(30);
    expect(settled).toBe(false);
    port.postMessage({ type: "schmock:aborted" });
    expect(await pending).toEqual({ type: "schmock:aborted" });
  });

  it("P10b a pre-aborted abortSignal still posts the request, then the abort", async () => {
    const { received, target } = setup();
    const controller = new AbortController();
    controller.abort();
    const pending = ask(
      target,
      { type: "x" },
      { abortSignal: controller.signal },
    );
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    const port = received[0].ports[0];
    const onPort: unknown[] = [];
    port.onmessage = (e) => onPort.push(e.data);
    await vi.waitFor(
      () => expect(onPort).toEqual([{ type: "schmock:abort" }]),
      { timeout: 2000 },
    );
    port.postMessage("done");
    expect(await pending).toBe("done");
  });

  it("P11 timeoutMs resolves undefined and closes the port", async () => {
    const { relay, target } = setup();
    // Watch the port as soon as it arrives: the 30 ms timeout closes it
    // before a polling wait would notice the request.
    let isClosed: (() => boolean) | undefined;
    relay.port2.onmessage = (e) => {
      isClosed = closed(e.ports[0]);
    };
    const pending = ask(target, { type: "x" }, { timeoutMs: 30 });
    expect(await pending).toBeUndefined();
    await vi.waitFor(() => expect(isClosed?.()).toBe(true), { timeout: 2000 });
  });

  it("P12 cancelSignal resolves undefined, closes, never posts abort", async () => {
    const { received, target } = setup();
    const controller = new AbortController();
    const pending = ask(
      target,
      { type: "x" },
      { cancelSignal: controller.signal },
    );
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    const port = received[0].ports[0];
    const onPort: unknown[] = [];
    port.onmessage = (e) => onPort.push(e.data);
    const isClosed = closed(port);
    controller.abort();
    expect(await pending).toBeUndefined();
    await vi.waitFor(() => expect(isClosed()).toBe(true), { timeout: 2000 });
    expect(onPort).toEqual([]);
  });

  it("P12b a pre-cancelled ask never posts", async () => {
    const controller = new AbortController();
    controller.abort();
    const postMessage = vi.fn();
    expect(
      await ask(
        { postMessage },
        { type: "x" },
        { cancelSignal: controller.signal },
      ),
    ).toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("P13 the timeout timer is cleared on reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { target } = setup();
    const relayPort = channels[0].port2;
    relayPort.onmessage = (e) => e.ports[0].postMessage("pong");
    expect(await ask(target, { type: "x" }, { timeoutMs: 1000 })).toBe("pong");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("P14 a throwing postMessage rejects with that identical error", async () => {
    const boom = new Error("boom");
    const target = {
      postMessage: () => {
        throw boom;
      },
    };
    await expect(ask(target, { type: "x" })).rejects.toBe(boom);
  });
});
