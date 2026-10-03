import { afterEach, describe, expect, it } from "vitest";
import type {
  ExtendableMessageEventLike,
  FetchEventLike,
  HelloMessage,
  ReadyMessage,
  RelayContainer,
  RelayWorker,
  RequestMessage,
} from "../relay/types.js";
import {
  createRelayHarness,
  type FakePage,
  type FakeWorkerScope,
  type RelayHarness,
} from "./relay-harness.js";

// The harness carries fidelity no slice owns (plan E.6 rule 8), so these
// tests pin it with stub workers and stub pages only: no worker.ts, no
// page-relay.ts.

let harness: RelayHarness | undefined;

function setUp(): RelayHarness {
  harness = createRelayHarness();
  return harness;
}

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

/** A worker shaped like the relay's: skipWaiting on install, claim on activate. */
function claimingWorker(
  extra?: (scope: FakeWorkerScope) => void,
): (scope: FakeWorkerScope) => void {
  return (scope) => {
    scope.addEventListener("install", (event) => {
      event.waitUntil(scope.skipWaiting());
    });
    scope.addEventListener("activate", (event) => {
      event.waitUntil(scope.clients.claim());
    });
    extra?.(scope);
  };
}

/** A worker that answers every fetch with `body`. */
function answeringWorker(body: string): (scope: FakeWorkerScope) => void {
  return claimingWorker((scope) => {
    scope.addEventListener("fetch", (event) => {
      event.respondWith(Promise.resolve(new Response(body)));
    });
  });
}

function containerOf(page: FakePage): RelayContainer {
  const { container } = page.environment;
  if (container === undefined) throw new Error("page has no container");
  return container;
}

function recordStates(
  worker: RelayWorker,
  read: () => boolean,
): [string, boolean][] {
  const states: [string, boolean][] = [];
  worker.addEventListener("statechange", () => {
    states.push([worker.state, read()]);
  });
  return states;
}

function countControllerChanges(page: FakePage): { count: number } {
  const counter = { count: 0 };
  containerOf(page).addEventListener("controllerchange", () => {
    counter.count += 1;
  });
  return counter;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function settledFlag(promise: Promise<unknown>): { settled: boolean } {
  const flag = { settled: false };
  promise.then(
    () => {
      flag.settled = true;
    },
    () => {
      flag.settled = true;
    },
  );
  return flag;
}

function openMessagePorts(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "MessagePort").length;
}

describe("registration lifecycle", () => {
  it("resolves register() with installing set and active null, then installs and activates in order", async () => {
    const h = setUp();
    const events: string[] = [];
    h.installWorker((scope) => {
      scope.addEventListener("install", () => events.push("install"));
      scope.addEventListener("activate", () => events.push("activate"));
    });
    const page = h.openPage();

    const registration = await containerOf(page).register("/schmock-sw.js", {
      updateViaCache: "none",
    });

    expect(registration.scope).toBe("http://localhost/");
    expect(registration.active).toBeNull();
    expect(registration.waiting).toBeNull();
    const installing = registration.installing;
    expect(installing?.state).toBe("installing");
    expect(installing?.scriptURL).toBe("http://localhost/schmock-sw.js");
    expect(events).toEqual([]);
    if (installing === null) return;
    const states = recordStates(
      installing,
      () => registration.active === installing,
    );

    await h.flush();

    expect(events).toEqual(["install", "activate"]);
    expect(states).toEqual([
      ["installed", false],
      ["activating", true],
      ["activated", true],
    ]);
    expect(registration.installing).toBeNull();
    expect(registration.active).toBe(installing);
    expect(h.registerCalls).toEqual([
      { url: "/schmock-sw.js", options: { updateViaCache: "none" } },
    ]);
    expect(h.registrations).toEqual([
      {
        scope: "http://localhost/",
        scriptURL: "http://localhost/schmock-sw.js",
      },
    ]);
  });

  it("makes a worker whose install waitUntil rejects redundant and clears installing", async () => {
    const h = setUp();
    h.installWorker((scope) => {
      scope.addEventListener("install", (event) => {
        event.waitUntil(Promise.reject(new Error("boom")));
      });
    });
    const container = containerOf(h.openPage());

    const registration = await container.register("/schmock-sw.js");
    const installing = registration.installing;
    if (installing === null) throw new Error("no installing worker");
    const states = recordStates(installing, () => true);
    await h.flush();

    expect(states.map(([state]) => state)).toEqual(["redundant"]);
    expect(registration.installing).toBeNull();
    expect(registration.waiting).toBeNull();
    expect(registration.active).toBeNull();
    expect(await container.getRegistration()).toBeUndefined();
  });

  it("rejects a scope wider than the script's directory with a SecurityError", async () => {
    const h = setUp();
    h.installWorker(claimingWorker(), "/mocks/schmock-sw.js");
    const container = containerOf(h.openPage());

    const error = await rejectionOf(
      container.register("/mocks/schmock-sw.js", { scope: "/" }),
    );

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "SecurityError" });
    expect(h.registrations).toEqual([]);
    expect(h.registerCalls).toEqual([
      { url: "/mocks/schmock-sw.js", options: { scope: "/" } },
    ]);
  });

  it("resolves a scope option against the page and the default scope against the script", async () => {
    const h = setUp();
    h.installWorker(claimingWorker(), "/mocks/schmock-sw.js");
    const container = containerOf(h.openPage({ path: "/mocks/index.html" }));

    const relative = await container.register("/mocks/schmock-sw.js", {
      scope: "sub/",
    });
    const byDefault = await container.register("/mocks/schmock-sw.js");

    expect(relative.scope).toBe("http://localhost/mocks/sub/");
    expect(byDefault.scope).toBe("http://localhost/mocks/");
  });

  it("rejects like a 404 while the script is not served, or for an unknown script", async () => {
    const h = setUp();
    h.installWorker(claimingWorker());
    const container = containerOf(h.openPage());

    h.serveScript(false);
    const notServed = await rejectionOf(container.register("/schmock-sw.js"));
    h.serveScript(true);
    const unknown = await rejectionOf(container.register("/other-sw.js"));

    for (const error of [notServed, unknown]) {
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({
        message:
          "Failed to register a ServiceWorker: A bad HTTP response code (404) was received",
      });
    }
    expect(h.registrations).toEqual([]);
  });

  it("rejects register() with a TypeError when the script throws while evaluating", async () => {
    const h = setUp();
    h.installWorker(() => {
      throw new Error("syntax");
    });

    const error = await rejectionOf(
      containerOf(h.openPage()).register("/schmock-sw.js"),
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ cause: { message: "syntax" } });
    expect(h.registrations).toEqual([]);
  });

  it("re-registering the byte-identical script resolves with the same registration and reinstalls nothing", async () => {
    const h = setUp();
    let installs = 0;
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("install", () => {
          installs += 1;
        });
      }),
    );
    const container = containerOf(h.openPage());

    const first = await container.register("/schmock-sw.js");
    await h.flush();
    const worker = h.worker;
    const second = await container.register("/schmock-sw.js", {
      updateViaCache: "none",
    });
    await h.flush();

    expect(second).toBe(first);
    expect(second.installing).toBeNull();
    expect(installs).toBe(1);
    expect(h.worker).toBe(worker);
    expect(h.registerCalls).toHaveLength(2);
  });

  it("installs a new version when other bytes are served at the same URL", async () => {
    const h = setUp();
    h.installWorker(answeringWorker("v1"));
    const page = h.openPage();
    const container = containerOf(page);
    await container.register("/schmock-sw.js");
    await h.flush();
    const v1 = container.controller;

    h.installWorker(answeringWorker("v2"));
    await container.register("/schmock-sw.js");
    await h.flush();

    expect(v1?.state).toBe("redundant");
    expect(await (await page.xhr("/api")).text()).toBe("v2");
  });

  it("finds the registration whose scope is the longest prefix of the URL", async () => {
    const h = setUp();
    h.seedForeignRegistration("/app-sw.js");
    h.installWorker(claimingWorker(), "/app/schmock-sw.js");
    const container = containerOf(h.openPage({ path: "/app/index.html" }));
    await container.register("/app/schmock-sw.js", { scope: "/app/" });

    expect((await container.getRegistration())?.scope).toBe(
      "http://localhost/app/",
    );
    expect(
      (await container.getRegistration("http://localhost/app/deep/x"))?.scope,
    ).toBe("http://localhost/app/");
    expect(
      (await container.getRegistration("http://localhost/other"))?.scope,
    ).toBe("http://localhost/");
    expect(
      (await container.getRegistration("http://localhost/"))?.active?.scriptURL,
    ).toBe("http://localhost/app-sw.js");
  });

  it("finds nothing above a narrower registration", async () => {
    const h = setUp();
    h.seedForeignRegistration("/app/app-sw.js", "/app/");
    const container = containerOf(h.openPage());

    expect(
      await container.getRegistration("http://localhost/"),
    ).toBeUndefined();
  });

  it("activateWorker() registers, installs and activates as an earlier visit did", async () => {
    const h = setUp();
    const events: string[] = [];
    h.installWorker((scope) => {
      scope.addEventListener("install", () => events.push("install"));
      scope.addEventListener("activate", () => events.push("activate"));
    });

    await h.activateWorker();
    const controlled = h.openPage();
    const reloaded = h.openPage({ controlled: false });

    expect(events).toEqual(["install", "activate"]);
    expect(h.registerCalls).toEqual([]);
    expect(h.registrations).toEqual([
      {
        scope: "http://localhost/",
        scriptURL: "http://localhost/schmock-sw.js",
      },
    ]);
    expect(containerOf(controlled).controller?.state).toBe("activated");
    expect(containerOf(reloaded).controller).toBeNull();
  });

  it("activateWorker() rejects with the script's own error", async () => {
    const h = setUp();
    h.installWorker(() => {
      throw new Error("not implemented: setup");
    });

    await expect(h.activateWorker()).rejects.toThrow("not implemented: setup");
  });
});

describe("claim", () => {
  it("takes only open, claimable pages outside the bfcache whose longest-prefix registration is the claimer's", async () => {
    const h = setUp();
    h.seedForeignRegistration("/app/app-sw.js", "/app/");
    h.installWorker(claimingWorker());
    const page = h.openPage();
    const underApp = h.openPage({ path: "/app/index.html" });
    const unclaimable = h.openPage({ claimable: false });
    const hidden = h.openPage({ path: "/hidden.html" });
    hidden.hide(true);
    const changes = [page, underApp, unclaimable, hidden].map(
      countControllerChanges,
    );

    await containerOf(page).register("/schmock-sw.js");
    await h.flush();

    expect(containerOf(page).controller?.scriptURL).toBe(
      "http://localhost/schmock-sw.js",
    );
    expect(containerOf(underApp).controller?.scriptURL).toBe(
      "http://localhost/app/app-sw.js",
    );
    expect(containerOf(unclaimable).controller).toBeNull();
    expect(containerOf(hidden).controller).toBeNull();
    expect(changes.map((counter) => counter.count)).toEqual([1, 0, 0, 0]);
  });

  it("claims a page that registered while it was uncontrolled (a hard reload)", async () => {
    const h = setUp();
    let claims = 0;
    h.installWorker((scope) => {
      scope.addEventListener("message", (event) => {
        claims += 1;
        event.waitUntil(scope.clients.claim());
      });
    });
    await h.activateWorker();
    const page = h.openPage({ controlled: false });
    const changes = countControllerChanges(page);
    const registration = await containerOf(page).getRegistration();

    registration?.active?.postMessage({ type: "schmock:claim" }, []);
    await h.flush();

    expect(claims).toBe(1);
    expect(changes.count).toBe(1);
    expect(containerOf(page).controller).toBe(registration?.active);
  });

  it("rejects a claim from a worker that is not active yet", async () => {
    const h = setUp();
    const outcome: { name?: string } = {};
    h.installWorker((scope) => {
      scope.addEventListener("install", () => {
        scope.clients.claim().catch((error: unknown) => {
          outcome.name = error instanceof DOMException ? error.name : "other";
        });
      });
    });

    await containerOf(h.openPage()).register("/schmock-sw.js");
    await h.flush();

    expect(outcome.name).toBe("InvalidStateError");
  });
});

describe("clients", () => {
  it("matchAll omits bfcached and closed pages; get still finds a hidden page", async () => {
    const h = setUp();
    h.installWorker(claimingWorker());
    await h.activateWorker();
    const shown = h.openPage();
    const hidden = h.openPage();
    const closed = h.openPage();
    hidden.hide(true);
    closed.close();
    const all = { includeUncontrolled: true, type: "all" } as const;

    expect(
      (await h.worker.clients.matchAll(all)).map((client) => client.id),
    ).toEqual([shown.id]);
    expect((await h.worker.clients.get(hidden.id))?.id).toBe(hidden.id);
    expect(await h.worker.clients.get(closed.id)).toBeUndefined();

    hidden.show();
    expect(
      (await h.worker.clients.matchAll(all)).map((client) => client.id),
    ).toEqual([shown.id, hidden.id]);
  });

  it("fires pagehide listeners with persisted, and stops after unsubscribe", () => {
    const h = setUp();
    const page = h.openPage();
    const seen: boolean[] = [];
    const unsubscribe = page.environment.onPageHide((persisted) => {
      seen.push(persisted);
    });

    page.hide(false);
    page.hide(true);
    page.show();
    unsubscribe();
    page.hide(false);

    expect(seen).toEqual([false, true]);
  });
});

describe("fetch events", () => {
  it("sends a controlled page's requests to its controller with the page's client id", async () => {
    const h = setUp();
    const seen: { clientId: string; mode: string; destination: string }[] = [];
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("fetch", (event) => {
          seen.push({
            clientId: event.clientId,
            mode: event.request.mode,
            destination: event.request.destination,
          });
          event.respondWith(Promise.resolve(new Response("from worker")));
        });
      }),
    );
    await h.activateWorker();
    const page = h.openPage();

    const xhr = await page.xhr("/api/x");
    const fetched = await page.networkFetch("/api/y");
    await page.load("/app.js", { destination: "script" });
    await page.load("/next", { mode: "navigate" });

    expect(await xhr.text()).toBe("from worker");
    expect(await fetched.text()).toBe("from worker");
    expect(seen).toEqual([
      { clientId: page.id, mode: "cors", destination: "" },
      { clientId: page.id, mode: "cors", destination: "" },
      { clientId: page.id, mode: "cors", destination: "script" },
      { clientId: "", mode: "navigate", destination: "" },
    ]);
    expect(page.browserLog).toEqual([
      { method: "GET", url: "http://localhost/api/x", servedBy: "worker" },
      { method: "GET", url: "http://localhost/api/y", servedBy: "worker" },
      { method: "GET", url: "http://localhost/app.js", servedBy: "worker" },
      { method: "GET", url: "http://localhost/next", servedBy: "worker" },
    ]);
    expect(h.network).not.toHaveBeenCalled();
  });

  it("sends requests to the network when the page is uncontrolled, or its controller has no fetch listener, or nobody responds", async () => {
    const h = setUp();
    h.seedForeignRegistration("/app/app-sw.js", "/app/");
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("fetch", () => {});
      }),
    );
    await h.activateWorker();
    const uncontrolled = h.openPage({ controlled: false });
    const foreign = h.openPage({ path: "/app/index.html" });
    const unanswered = h.openPage();

    const responses = await Promise.all([
      uncontrolled.xhr("/a"),
      foreign.xhr("/app/b"),
      unanswered.xhr("/c"),
    ]);

    for (const response of responses) {
      expect(await response.text()).toBe("real network");
      expect(response.headers.get("x-from")).toBe("network");
    }
    expect(
      [uncontrolled, foreign, unanswered].map((page) => page.browserLog),
    ).toEqual([
      [{ method: "GET", url: "http://localhost/a", servedBy: "network" }],
      [{ method: "GET", url: "http://localhost/app/b", servedBy: "network" }],
      [{ method: "GET", url: "http://localhost/c", servedBy: "network" }],
    ]);
    expect(h.network).toHaveBeenCalledTimes(3);
  });

  it("throws an InvalidStateError from respondWith once the listener returned, or on a second call", async () => {
    const h = setUp();
    const captured: { unanswered?: FetchEventLike; second?: unknown } = {};
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("fetch", (event) => {
          if (event.request.url.endsWith("/later")) {
            captured.unanswered = event;
            return;
          }
          event.respondWith(Promise.resolve(new Response("first")));
          try {
            event.respondWith(Promise.resolve(new Response("second")));
          } catch (error) {
            captured.second = error;
          }
        });
      }),
    );
    await h.activateWorker();
    const page = h.openPage();

    expect(await (await page.xhr("/twice")).text()).toBe("first");
    expect(captured.second).toBeInstanceOf(DOMException);
    expect(captured.second).toMatchObject({ name: "InvalidStateError" });

    expect(await (await page.xhr("/later")).text()).toBe("real network");
    let late: unknown;
    try {
      captured.unanswered?.respondWith(Promise.resolve(new Response("late")));
    } catch (error) {
      late = error;
    }
    expect(late).toBeInstanceOf(DOMException);
    expect(late).toMatchObject({ name: "InvalidStateError" });
  });

  it("turns Response.error() or a rejected respondWith into TypeError: Failed to fetch", async () => {
    const h = setUp();
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("fetch", (event) => {
          event.respondWith(
            event.request.url.endsWith("/error")
              ? Promise.resolve(Response.error())
              : Promise.reject(new Error("worker failed")),
          );
        });
      }),
    );
    await h.activateWorker();
    const page = h.openPage();

    for (const path of ["/error", "/reject"]) {
      const error = await rejectionOf(page.xhr(path));
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ message: "Failed to fetch" });
    }
    expect(page.browserLog).toEqual([]);
  });

  it("rejects an aborted request with an AbortError at once and aborts the worker's request signal", async () => {
    const h = setUp();
    const workerSaw: string[] = [];
    let respond = (_response: Response) => {};
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("fetch", (event) => {
          event.request.signal.addEventListener("abort", () => {
            workerSaw.push("abort");
          });
          event.respondWith(
            new Promise<Response>((resolve) => {
              respond = resolve;
            }),
          );
        });
      }),
    );
    await h.activateWorker();
    const page = h.openPage();
    const controller = new AbortController();

    const pending = page.xhr("/slow", { signal: controller.signal });
    await h.flush();
    controller.abort();
    const error = await rejectionOf(pending);
    respond(new Response("too late"));

    expect(error).toMatchObject({ name: "AbortError" });
    expect(workerSaw).toEqual(["abort"]);
    const preAborted = await rejectionOf(
      page.xhr("/never", { signal: AbortSignal.abort() }),
    );
    expect(preAborted).toMatchObject({ name: "AbortError" });
  });
});

describe("messages", () => {
  it("delivers a page's message to the worker asynchronously, cloned, with ports and the source client", async () => {
    const h = setUp();
    const seen: ExtendableMessageEventLike[] = [];
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("message", (event) => {
          seen.push(event);
        });
      }),
    );
    await h.activateWorker();
    const page = h.openPage();
    const hello: HelloMessage = {
      type: "schmock:hello",
      protocol: 1,
      version: "1.0.0",
    };
    const channel = new MessageChannel();

    containerOf(page).controller?.postMessage(hello, [channel.port2]);
    expect(h.worker.received).toEqual([]);
    await h.flush();
    channel.port1.close();

    expect(h.worker.received).toEqual([{ data: hello, source: page.id }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].data).not.toBe(hello);
    expect(seen[0].data).toEqual(hello);
    expect(seen[0].source?.id).toBe(page.id);
    expect(seen[0].ports).toHaveLength(1);
  });

  it("queues a client's messages until startMessages(), transferring the body", async () => {
    const h = setUp();
    h.installWorker(claimingWorker());
    await h.activateWorker();
    const page = h.openPage();
    const container = containerOf(page);
    const received: { data: unknown; ports: number }[] = [];
    container.addEventListener("message", (event) => {
      received.push({ data: event.data, ports: event.ports.length });
    });
    const body = new Uint8Array([0, 1, 2, 255]).buffer;
    const frame: RequestMessage = {
      type: "schmock:request",
      request: {
        url: "http://localhost/api",
        method: "POST",
        headers: [],
        body,
      },
    };
    const channel = new MessageChannel();
    const client = await h.worker.clients.get(page.id);

    client?.postMessage(frame, [channel.port2, body]);
    expect(body.byteLength).toBe(0);
    await h.flush();
    expect(page.relayedFrames).toHaveLength(1);
    expect(received).toEqual([]);

    container.startMessages();
    await h.flush();
    channel.port1.close();

    expect(received).toHaveLength(1);
    expect(received[0].ports).toBe(1);
    expect(received[0].data).toMatchObject({
      type: "schmock:request",
      request: { url: "http://localhost/api", method: "POST" },
    });
    const delivered = page.relayedFrames[0];
    const deliveredBody =
      typeof delivered === "object" && delivered !== null
        ? Reflect.get(Reflect.get(delivered, "request"), "body")
        : undefined;
    expect(deliveredBody).toBeInstanceOf(ArrayBuffer);
    if (deliveredBody instanceof ArrayBuffer) {
      expect([...new Uint8Array(deliveredBody)]).toEqual([0, 1, 2, 255]);
    }
  });

  it("holds events for a page in the bfcache until show()", async () => {
    const h = setUp();
    h.installWorker(claimingWorker());
    await h.activateWorker();
    const page = h.openPage();
    const container = containerOf(page);
    container.startMessages();
    let deliveries = 0;
    container.addEventListener("message", () => {
      deliveries += 1;
    });
    const client = await h.worker.clients.get(page.id);
    const frame: RequestMessage = {
      type: "schmock:request",
      request: {
        url: "http://localhost/",
        method: "GET",
        headers: [],
        body: null,
      },
    };

    page.hide(true);
    client?.postMessage(frame, []);
    await h.flush();
    expect(deliveries).toBe(0);

    page.show();
    await h.flush();
    expect(deliveries).toBe(1);
  });
});

describe("worker instances", () => {
  it("restartWorker() runs setup in a fresh scope with no lifecycle events, keeping registration and caches", async () => {
    const h = setUp();
    const counts = { setup: 0, install: 0, activate: 0 };
    h.installWorker(
      claimingWorker((scope) => {
        counts.setup += 1;
        scope.addEventListener("install", () => {
          counts.install += 1;
        });
        scope.addEventListener("activate", () => {
          counts.activate += 1;
        });
        scope.addEventListener("fetch", (event) => {
          event.respondWith(
            Promise.resolve(new Response(`run ${counts.setup}`)),
          );
        });
      }),
    );
    await h.activateWorker();
    const page = h.openPage();
    const before = h.worker;
    containerOf(page).controller?.postMessage({ type: "schmock:claim" }, []);
    await h.flush();
    expect(before.received).toHaveLength(1);

    h.restartWorker();
    await h.flush();

    expect(counts).toEqual({ setup: 2, install: 1, activate: 1 });
    expect(h.worker).not.toBe(before);
    expect(h.worker.received).toEqual([]);
    expect(h.worker.registration.scope).toBe(before.registration.scope);
    expect(h.worker.caches).toBe(h.caches);
    expect(await (await page.xhr("/x")).text()).toBe("run 2");
  });

  it("replaceWorker() activates a new version that takes over the pages using the registration", async () => {
    const h = setUp();
    h.installWorker(answeringWorker("v1"));
    await h.activateWorker();
    const page = h.openPage();
    const old = containerOf(page).controller;
    const changes = countControllerChanges(page);

    // This version neither calls skipWaiting nor claims: replaceWorker()
    // activates it anyway, and the spec's Activate step hands it the pages
    // already using the registration.
    await h.replaceWorker((scope) => {
      scope.addEventListener("fetch", (event) => {
        event.respondWith(Promise.resolve(new Response("v2")));
      });
    });
    await h.flush();

    expect(old?.state).toBe("redundant");
    expect(changes.count).toBe(1);
    expect(containerOf(page).controller?.state).toBe("activated");
    expect(containerOf(page).controller?.scriptURL).toBe(old?.scriptURL);
    expect(await (await page.xhr("/x")).text()).toBe("v2");
    expect(h.worker.received).toEqual([]);
  });
});

describe("cache storage", () => {
  it("buffers put() bodies and answers every match() with a fresh Response", async () => {
    const h = setUp();
    const cache = await h.caches.open("c");
    await cache.put("http://localhost/k", new Response("[1,2]"));

    expect(await (await cache.match("http://localhost/k"))?.json()).toEqual([
      1, 2,
    ]);
    expect(await (await cache.match("http://localhost/k"))?.json()).toEqual([
      1, 2,
    ]);
    expect(await cache.match("http://localhost/missing")).toBeUndefined();
    expect(await h.caches.open("c")).toBe(cache);
  });

  it("hold() pauses open(), and match()/put() on an opened cache, until every hold is released", async () => {
    const h = setUp();
    const opened = await h.caches.open("c");
    const releaseFirst = h.caches.hold();
    const releaseSecond = h.caches.hold();

    const open = settledFlag(h.caches.open("d"));
    const match = settledFlag(opened.match("http://localhost/k"));
    const put = settledFlag(
      opened.put("http://localhost/k", new Response("x")),
    );
    await h.flush();
    expect([open.settled, match.settled, put.settled]).toEqual([
      false,
      false,
      false,
    ]);

    releaseFirst();
    await h.flush();
    expect(open.settled).toBe(false);

    releaseSecond();
    await h.flush();
    expect([open.settled, match.settled, put.settled]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("keeps a hold across restartWorker()", async () => {
    const h = setUp();
    h.installWorker(claimingWorker());
    await h.activateWorker();
    const release = h.caches.hold();

    h.restartWorker();
    const open = settledFlag(h.worker.caches?.open("c") ?? Promise.resolve());
    await h.flush();
    expect(open.settled).toBe(false);

    release();
    await h.flush();
    expect(open.settled).toBe(true);
  });
});

describe("stub tab", () => {
  it("says hello in the worker's protocol, then answers every relayed request with its JSON", async () => {
    const h = setUp();
    const registered = new Set<string>();
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("message", (event) => {
          const [port] = event.ports;
          const protocol: unknown =
            typeof event.data === "object" && event.data !== null
              ? Reflect.get(event.data, "protocol")
              : undefined;
          if (protocol === 7 && event.source) registered.add(event.source.id);
          const ready: ReadyMessage = {
            type: "schmock:ready",
            protocol: 7,
            version: "worker",
          };
          port?.postMessage(ready);
          port?.close();
        });
        scope.addEventListener("fetch", (event) => {
          if (!registered.has(event.clientId)) return;
          event.respondWith(
            scope.clients.get(event.clientId).then(
              (client) =>
                new Promise<Response>((resolve) => {
                  const channel = new MessageChannel();
                  channel.port1.onmessage = (reply: MessageEvent) => {
                    channel.port1.close();
                    const data: unknown = reply.data;
                    const response =
                      typeof data === "object" && data !== null
                        ? Reflect.get(data, "response")
                        : undefined;
                    const bytes =
                      typeof response === "object" && response !== null
                        ? Reflect.get(response, "body")
                        : undefined;
                    resolve(
                      new Response(bytes instanceof ArrayBuffer ? bytes : null),
                    );
                  };
                  const frame: RequestMessage = {
                    type: "schmock:request",
                    request: {
                      url: event.request.url,
                      method: event.request.method,
                      headers: [],
                      body: null,
                    },
                  };
                  client?.postMessage(frame, [channel.port2]);
                }),
            ),
          );
        });
      }),
    );
    await h.activateWorker();
    const tab = h.openPage();

    await tab.respondToRelaysWith({ tab: "second" });
    const response = await tab.xhr("/api/users");

    expect(
      h.worker.received.map(({ data }) =>
        typeof data === "object" && data !== null
          ? Reflect.get(data, "protocol")
          : undefined,
      ),
    ).toEqual([1, 7]);
    expect(await response.json()).toEqual({ tab: "second" });
    expect(tab.relayedFrames).toHaveLength(1);
    expect(tab.browserLog).toEqual([
      { method: "GET", url: "http://localhost/api/users", servedBy: "worker" },
    ]);
  });
});

describe("flush and dispose", () => {
  it("flush() waits for waitUntil promises", async () => {
    const h = setUp();
    const done = { value: false };
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("message", (event) => {
          event.waitUntil(
            new Promise<void>((resolve) => {
              setTimeout(() => {
                done.value = true;
                resolve();
              }, 20);
            }),
          );
        });
      }),
    );
    await h.activateWorker();
    const page = h.openPage();

    containerOf(page).controller?.postMessage({ type: "schmock:claim" }, []);
    await h.flush();

    expect(done.value).toBe(true);
  });

  it("flush() does not wait for a respondWith promise", async () => {
    const h = setUp();
    let respondedTo = 0;
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("fetch", (event) => {
          respondedTo += 1;
          event.respondWith(new Promise<Response>(() => {}));
        });
      }),
    );
    await h.activateWorker();
    const page = h.openPage();

    const pending = settledFlag(page.xhr("/held"));
    await h.flush();

    expect(respondedTo).toBe(1);
    expect(pending.settled).toBe(false);
  });

  it("flush() waits for a waitUntil that a cache hold blocks, until the hold is released", async () => {
    const h = setUp();
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("message", (event) => {
          event.waitUntil(scope.caches?.open("c") ?? Promise.resolve());
        });
      }),
    );
    await h.activateWorker();
    const page = h.openPage();
    const release = h.caches.hold();

    containerOf(page).controller?.postMessage({ type: "schmock:claim" }, []);
    const flushing = h.flush();
    const flushed = settledFlag(flushing);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed.settled).toBe(false);

    release();
    await flushing;
    expect(flushed.settled).toBe(true);
  });

  it("dispose() leaves no MessagePort open", async () => {
    // Ports closed by earlier tests are released on the next macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const baseline = openMessagePorts();
    const h = createRelayHarness();
    h.installWorker(
      claimingWorker((scope) => {
        scope.addEventListener("message", (event) => {
          // Listen on the port and never close it: dispose() must.
          for (const port of event.ports) port.onmessage = () => {};
        });
      }),
    );
    await h.activateWorker();
    const page = h.openPage();
    const container = containerOf(page);
    container.startMessages();
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {};
    container.controller?.postMessage({ type: "schmock:goodbye" }, [
      channel.port2,
    ]);
    await h.flush();
    expect(openMessagePorts()).toBeGreaterThan(baseline);

    // Leave our end open too: closing the worker's end in dispose() closes
    // both ends of the channel.
    h.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(openMessagePorts()).toBe(baseline);
  });
});
