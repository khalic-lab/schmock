/// <reference path="../../../core/schmock.d.ts" />

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { SchmockError, schmock } from "@schmock/core";
import { expect, vi } from "vitest";
import { devtoolsPlugin } from "../index.js";
import {
  createServiceWorkerRelay,
  startServiceWorkerRelay,
} from "../relay/page-relay.js";
import type {
  ExtendableEventLike,
  ExtendableMessageEventLike,
  FetchEventLike,
  ReadyMessage,
  RelayEnvironment,
  ReleasedMessage,
  RequestMessage,
} from "../relay/types.js";
import { installRelayWorker } from "../relay/worker.js";
import {
  createRelayHarness,
  type FakePage,
  type FakeWorkerScope,
  type RelayHarness,
} from "../test-support/relay-harness.js";
import type {
  ServiceWorkerRelay,
  ServiceWorkerRelayOptions,
} from "../types.js";

const feature = await loadFeature(
  "../../features/service-worker-relay.feature",
);

const USERS = [{ id: 1, name: "Ada" }];
const USERS_URL = "http://localhost/api/users";
/** Bounds every wait on the relay, so a broken relay fails a step instead of timing out the scenario. */
const SETTLE_MS = 5000;

interface HelloFields {
  readonly protocol: number;
  readonly version: string;
}

/** How a stub worker answers a hello: post on `port`, or not at all. */
type HelloAnswer = (
  hello: HelloFields,
  event: ExtendableMessageEventLike,
  port: MessagePort,
) => void;

function messageType(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const type: unknown = Reflect.get(data, "type");
  return typeof type === "string" ? type : undefined;
}

function readHello(data: unknown): HelloFields {
  if (typeof data !== "object" || data === null) {
    throw new Error("A hello must be an object");
  }
  const protocol: unknown = Reflect.get(data, "protocol");
  const version: unknown = Reflect.get(data, "version");
  if (typeof protocol !== "number" || typeof version !== "string") {
    throw new Error(`Not a hello: ${JSON.stringify(data)}`);
  }
  return { protocol, version };
}

function answerReady(port: MessagePort, ready: ReadyMessage): void {
  port.postMessage(ready);
  port.close();
}

/**
 * A hand-written worker script: skipWaiting on install, claim on activate and
 * on schmock:claim, released for a goodbye, and `answer` for a hello. It
 * relays nothing, so a page it controls fetches from the network.
 */
function stubWorker(answer: HelloAnswer): (scope: FakeWorkerScope) => void {
  return (scope) => {
    scope.addEventListener("install", (event) => {
      event.waitUntil(scope.skipWaiting());
    });
    scope.addEventListener("activate", (event) => {
      event.waitUntil(scope.clients.claim());
    });
    scope.addEventListener("message", (event) => {
      const type = messageType(event.data);
      const [port] = event.ports;
      if (type === "schmock:claim") {
        event.waitUntil(scope.clients.claim());
      } else if (type === "schmock:goodbye" && port !== undefined) {
        const released: ReleasedMessage = { type: "schmock:released" };
        port.postMessage(released);
        port.close();
      } else if (type === "schmock:hello" && port !== undefined) {
        answer(readHello(event.data), event, port);
      }
    });
  };
}

type ScopeListenerArgs =
  | ["install" | "activate", (event: ExtendableEventLike) => void]
  | ["message", (event: ExtendableMessageEventLike) => void]
  | ["fetch", (event: FetchEventLike) => void];

/**
 * The real worker script, except that each hello it receives goes to
 * `onHello` instead: `deliver` hands it to the worker's own listener.
 */
function relayWorkerFilteringHellos(
  onHello: (event: ExtendableMessageEventLike, deliver: () => void) => void,
): (scope: FakeWorkerScope) => void {
  return (scope) => {
    installRelayWorker({
      clients: scope.clients,
      caches: scope.caches,
      registration: scope.registration,
      skipWaiting: () => scope.skipWaiting(),
      fetch: (request) => scope.fetch(request),
      addEventListener(...args: ScopeListenerArgs) {
        if (args[0] === "message") {
          const listener = args[1];
          scope.addEventListener("message", (event) => {
            if (messageType(event.data) === "schmock:hello") {
              onHello(event, () => listener(event));
            } else {
              listener(event);
            }
          });
        } else if (args[0] === "fetch") {
          scope.addEventListener("fetch", args[1]);
        } else {
          scope.addEventListener(args[0], args[1]);
        }
      },
    });
  };
}

/** Start the relay with options as plain JavaScript can pass them, invalid types included. */
function startWithUntypedOptions(
  environment: RelayEnvironment,
  options: unknown,
): Promise<unknown> {
  return Promise.resolve(
    Reflect.apply(createServiceWorkerRelay, undefined, [environment, options]),
  );
}

interface InvalidOptionCase {
  readonly options: unknown;
  readonly option: string;
  readonly received: unknown;
  readonly message: string;
}

function parseInvalidOptionCases(docString: string): InvalidOptionCase[] {
  const parsed = parseJson(docString);
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON list of cases");
  return parsed.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Not a case: ${JSON.stringify(entry)}`);
    }
    const option: unknown = Reflect.get(entry, "option");
    const message: unknown = Reflect.get(entry, "message");
    if (typeof option !== "string" || typeof message !== "string") {
      throw new Error(
        `A case needs an option and a message: ${JSON.stringify(entry)}`,
      );
    }
    return {
      options: Reflect.get(entry, "options"),
      option,
      received: Reflect.get(entry, "received"),
      message,
    };
  });
}

function failingInstallWorker(scope: FakeWorkerScope): void {
  scope.addEventListener("install", (event) => {
    event.waitUntil(Promise.reject(new Error("boom")));
  });
}

/** The body as JSON, or its raw text when it is not JSON, so a wrong body fails as a mismatch. */
async function bodyOf(received: Response): Promise<unknown> {
  const text = await received.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseJson(docString: string): unknown {
  return JSON.parse(docString);
}

function parseRelayOptions(docString: string): ServiceWorkerRelayOptions {
  const parsed = parseJson(docString);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Not a relay options object: ${docString}`);
  }
  const options: ServiceWorkerRelayOptions = {};
  const url: unknown = Reflect.get(parsed, "url");
  const scope: unknown = Reflect.get(parsed, "scope");
  const timeout: unknown = Reflect.get(parsed, "timeout");
  if (typeof url === "string") options.url = url;
  if (typeof scope === "string") options.scope = scope;
  if (typeof timeout === "number") options.timeout = timeout;
  return options;
}

async function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not settle within ${SETTLE_MS} ms`)),
      SETTLE_MS,
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a rejection, but the promise resolved");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render console format args as a console shows them: `%c` takes an argument
 * and prints nothing, `%s` prints `String(arg)`, leftover arguments follow
 * after a space. Only the format string is scanned, never substituted text.
 */
function renderConsole(args: readonly unknown[]): string {
  const [format, ...rest] = args;
  if (typeof format !== "string") return args.map(String).join(" ");
  const text = format.replace(/%[cs]/g, (directive) => {
    if (rest.length === 0) return directive;
    const arg = rest.shift();
    return directive === "%c" ? "" : String(arg);
  });
  return [text, ...rest.map(String)].join(" ");
}

function spyOnConsole() {
  return {
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    groupCollapsed: vi
      .spyOn(console, "groupCollapsed")
      .mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    groupEnd: vi.spyOn(console, "groupEnd").mockImplementation(() => {}),
  };
}

type ConsoleSpies = ReturnType<typeof spyOnConsole>;

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  const originalFetch = globalThis.fetch;
  let harness: RelayHarness | undefined;
  let page: FakePage | undefined;
  let secondPage: FakePage | undefined;
  let mock: Schmock.CallableMockInstance | undefined;
  let spies: ConsoleSpies | undefined;
  let handles: Schmock.InterceptHandle[] = [];
  let relays: ServiceWorkerRelay[] = [];
  let relay: ServiceWorkerRelay | undefined;
  let secondRelay: ServiceWorkerRelay | undefined;
  let startError: unknown;
  let response: Response | undefined;
  let secondResponse: Response | undefined;
  let pendingResponse: Promise<Response> | undefined;
  let requestError: unknown;
  let unseenByBrowser: unknown[] = [];
  let lifecycle: string[] = [];
  let endStatuses: number[] = [];
  let relayReply: unknown;
  let heldUntilLoaded = false;
  let releaseRoute = () => {};
  let releaseCaches = () => {};
  let releaseHellos = () => {};
  let routeStarted: Promise<void> = Promise.resolve();

  AfterEachScenario(async () => {
    releaseRoute();
    releaseCaches();
    releaseHellos();
    for (const started of relays) {
      await started.stop().catch(() => undefined);
    }
    for (const handle of handles) {
      handle.restore();
    }
    harness?.dispose();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    performance.clearMeasures();

    harness = undefined;
    page = undefined;
    secondPage = undefined;
    mock = undefined;
    spies = undefined;
    handles = [];
    relays = [];
    relay = undefined;
    secondRelay = undefined;
    startError = undefined;
    response = undefined;
    secondResponse = undefined;
    pendingResponse = undefined;
    requestError = undefined;
    unseenByBrowser = [];
    lifecycle = [];
    endStatuses = [];
    relayReply = undefined;
    heldUntilLoaded = false;
    releaseRoute = () => {};
    releaseCaches = () => {};
    releaseHellos = () => {};
    routeStarted = Promise.resolve();
  });

  function currentHarness(): RelayHarness {
    if (harness === undefined) throw new Error("No harness yet");
    return harness;
  }

  function currentPage(): FakePage {
    if (page === undefined) throw new Error("No page yet");
    return page;
  }

  function currentSecondPage(): FakePage {
    if (secondPage === undefined) throw new Error("No second page yet");
    return secondPage;
  }

  function currentMock(): Schmock.CallableMockInstance {
    if (mock === undefined) throw new Error("No mock yet");
    return mock;
  }

  function currentSpies(): ConsoleSpies {
    if (spies === undefined) throw new Error("No console spies yet");
    return spies;
  }

  function currentRelay(): ServiceWorkerRelay {
    if (relay === undefined) throw new Error("The relay was never started");
    return relay;
  }

  /** Steps 1-2 of plan E.4: the harness serves the real worker script. */
  function createHarness(
    worker: (scope: FakeWorkerScope) => void = installRelayWorker,
    scriptURL?: string,
  ): RelayHarness {
    spies = spyOnConsole();
    harness = createRelayHarness();
    harness.installWorker(worker, scriptURL);
    return harness;
  }

  /** Steps 3-5 of plan E.4: the page's fetch is the browser's, then the mock intercepts it. */
  function openPageWithMock(
    route: (target: Schmock.CallableMockInstance) => void,
    pageOptions?: Parameters<RelayHarness["openPage"]>[0],
    interceptOptions?: Schmock.InterceptOptions,
  ): FakePage {
    page = currentHarness().openPage(pageOptions);
    globalThis.fetch = page.networkFetch;
    mock = schmock();
    route(mock);
    handles.push(mock.intercept(interceptOptions));
    return page;
  }

  async function startRelay(
    options?: ServiceWorkerRelayOptions,
  ): Promise<ServiceWorkerRelay> {
    const started = await createServiceWorkerRelay(
      currentPage().environment,
      options,
    );
    relays.push(started);
    relay = started;
    return started;
  }

  /** "A page whose mock answers … and whose relay has started" (plan E.4 steps 1-6). */
  async function givenRelayingPage(
    route: (target: Schmock.CallableMockInstance) => void,
    interceptOptions?: Schmock.InterceptOptions,
  ): Promise<void> {
    createHarness();
    openPageWithMock(route, undefined, interceptOptions);
    await startRelay();
  }

  const usersRoute = (target: Schmock.CallableMockInstance) => {
    target("GET /api/users", USERS);
  };

  function givenWaitingRoute(target: Schmock.CallableMockInstance): void {
    let announceStart = () => {};
    routeStarted = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    target("GET /api/slow", async () => {
      announceStart();
      await gate;
      return USERS;
    });
  }

  function recordLifecycle(): void {
    const target = currentMock();
    target.on("request:start", () => lifecycle.push("request:start"));
    target.on("request:match", () => lifecycle.push("request:match"));
    target.on("request:notfound", () => lifecycle.push("request:notfound"));
    target.on("request:end", () => lifecycle.push("request:end"));
  }

  async function pageFetches(url: string): Promise<void> {
    response = await withTimeout(fetch(url), `fetch("${url}")`);
  }

  async function pageXhr(url: string, init?: RequestInit): Promise<void> {
    response = await withTimeout(currentPage().xhr(url, init), `XHR ${url}`);
  }

  async function secondPageXhr(url: string): Promise<void> {
    secondResponse = await withTimeout(
      currentSecondPage().xhr(url),
      `second page XHR ${url}`,
    );
  }

  async function receivedResponse(): Promise<Response> {
    if (response !== undefined) return response;
    if (pendingResponse === undefined) throw new Error("No request was made");
    response = await withTimeout(pendingResponse, "the page's request");
    return response;
  }

  async function expectUsers(): Promise<void> {
    const received = await receivedResponse();
    expect(received.status).toBe(200);
    expect(await bodyOf(received)).toEqual(USERS);
  }

  async function expectNetworkBody(received: Response): Promise<void> {
    expect(await received.text()).toBe("real network");
    expect(received.headers.get("x-from")).toBe("network");
  }

  function networkRequests(): { method: string; url: string }[] {
    return currentHarness().network.mock.calls.map(([request]) => ({
      method: request.method,
      url: request.url,
    }));
  }

  function expectSeenByBrowser(
    target: FakePage,
    method: string,
    url: string,
    servedBy: "worker" | "network",
  ): void {
    expect(target.browserLog).toContainEqual({ method, url, servedBy });
  }

  function expectFellBack(reason: string): void {
    const started = currentRelay();
    expect(started.active).toBe(false);
    expect(started.fallbackReason).toBe(reason);
  }

  function expectWarnedWith(text: string): void {
    const warnings = currentSpies().warn.mock.calls.map((args) =>
      renderConsole(args),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(text);
  }

  /** The relay settles after a takeover on its own schedule; wait for it, but only once it exists. */
  async function expectActiveEventually(): Promise<void> {
    const started = currentRelay();
    await vi.waitFor(() => expect(started.active).toBe(true), {
      timeout: SETTLE_MS,
    });
  }

  async function expectHelloFromPage(): Promise<void> {
    const target = currentHarness();
    const pageId = currentPage().id;
    currentRelay();
    await vi.waitFor(
      () => expect(helloFrom(target.worker, pageId)).toBe(true),
      {
        timeout: SETTLE_MS,
      },
    );
  }

  function helloFrom(scope: FakeWorkerScope, pageId: string): boolean {
    return scope.received.some(
      ({ data, source }) =>
        source === pageId && messageType(data) === "schmock:hello",
    );
  }

  async function expectXhrServedByWorker(url: string): Promise<void> {
    const target = currentPage();
    const received = await withTimeout(target.xhr(url), `XHR ${url}`);
    expect(received.status).toBe(200);
    expect(target.browserLog.at(-1)).toEqual({
      method: "GET",
      url: new URL(url, "http://localhost/").href,
      servedBy: "worker",
    });
  }

  /** Act as the worker: send one schmock:request frame to the page and wait for its reply. */
  async function relayAsWorker(method: string, url: string): Promise<unknown> {
    const client = await currentHarness().worker.clients.get(currentPage().id);
    if (client === undefined) {
      throw new Error("The page is not a client of the worker");
    }
    const channel = new MessageChannel();
    try {
      const reply = new Promise<unknown>((resolve) => {
        channel.port1.onmessage = (event: MessageEvent) => {
          const data: unknown = event.data;
          resolve(data);
        };
      });
      const frame: RequestMessage = {
        type: "schmock:request",
        request: { url, method, headers: [], body: null },
      };
      client.postMessage(frame, [channel.port2]);
      return await withTimeout(reply, "the page's reply to the relayed frame");
    } finally {
      channel.port1.close();
    }
  }

  /** Resolves once the route started, or once the request settled without it. */
  async function startedOrSettled(pending: Promise<unknown>): Promise<void> {
    await withTimeout(
      Promise.race([
        routeStarted,
        pending.then(
          () => undefined,
          () => undefined,
        ),
      ]),
      "the relayed route",
    );
  }

  /** The group title as the console renders it, then a "(1.4 ms)" duration. */
  function expectGroupTitle(text: string): void {
    const { groupCollapsed } = currentSpies();
    expect(groupCollapsed).toHaveBeenCalledTimes(1);
    const args: readonly unknown[] = groupCollapsed.mock.calls[0];
    expect(typeof args[0]).toBe("string");
    expect(renderConsole(args)).toMatch(
      new RegExp(`^${escapeRegExp(text)} \\(\\d+\\.\\d ms\\)$`),
    );
  }

  Scenario(
    "A mocked fetch is answered by the service worker",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When('the page fetches "/api/users"', () => pageFetches("/api/users"));

      Then("the relay is active", () => {
        expect(currentRelay().active).toBe(true);
      });

      And("the page received status 200 with the mocked users", () =>
        expectUsers(),
      );

      And(
        'the browser saw "GET http://localhost/api/users" served by the service worker',
        () => {
          expectSeenByBrowser(currentPage(), "GET", USERS_URL, "worker");
        },
      );

      And("the network received no request", () => {
        expect(currentHarness().network).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "A mocked XHR is answered by the service worker",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When('the page sends an XHR for "/api/users"', () =>
        pageXhr("/api/users"),
      );

      Then("the page received status 200 with the mocked users", () =>
        expectUsers(),
      );

      And(
        'the browser saw "GET http://localhost/api/users" served by the service worker',
        () => {
          expectSeenByBrowser(currentPage(), "GET", USERS_URL, "worker");
        },
      );
    },
  );

  Scenario(
    "One relayed request consults the mock once",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      And("the mock records its lifecycle events", () => recordLifecycle());

      When('the page fetches "/api/users"', () => pageFetches("/api/users"));

      Then('the mock emitted "request:start,request:match,request:end"', () => {
        expect(lifecycle.join(",")).toBe(
          "request:start,request:match,request:end",
        );
      });
    },
  );

  Scenario(
    "A request no mock answers is fetched by the worker",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When('the page fetches "/api/other"', () => pageFetches("/api/other"));

      Then("the page received the network's response", async () => {
        await expectNetworkBody(await receivedResponse());
      });

      And(
        'the worker fetched "GET http://localhost/api/other" from the network',
        () => {
          expect(networkRequests()).toEqual([
            { method: "GET", url: "http://localhost/api/other" },
          ]);
          expectSeenByBrowser(
            currentPage(),
            "GET",
            "http://localhost/api/other",
            "worker",
          );
        },
      );
    },
  );

  Scenario(
    "Script and navigation requests never reach the page",
    ({ Given, When, Then, And }) => {
      const loaded: Response[] = [];

      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      And("the mock records its lifecycle events", () => recordLifecycle());

      When('the page loads a "script" from "/api/users"', async () => {
        loaded.push(
          await withTimeout(
            currentPage().load("/api/users", { destination: "script" }),
            "script load",
          ),
        );
      });

      And('the page navigates to "/api/users"', async () => {
        loaded.push(
          await withTimeout(
            currentPage().load("/api/users", { mode: "navigate" }),
            "navigation",
          ),
        );
      });

      Then("the network answered both requests directly", async () => {
        expect(loaded).toHaveLength(2);
        for (const received of loaded) await expectNetworkBody(received);
        expect(currentPage().browserLog).toEqual([
          { method: "GET", url: USERS_URL, servedBy: "network" },
          { method: "GET", url: USERS_URL, servedBy: "network" },
        ]);
        expect(currentPage().relayedFrames).toEqual([]);
      });

      And("the mock emitted no lifecycle events", () => {
        expect(lifecycle).toEqual([]);
      });
    },
  );

  Scenario(
    "A passthrough-off lease does not answer asset requests",
    ({ Given, When, Then }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users with passthrough disabled and whose relay has started',
        () => givenRelayingPage(usersRoute, { passthrough: false }),
      );

      When('the page loads a "script" from "/assets/app.js"', async () => {
        response = await withTimeout(
          currentPage().load("/assets/app.js", { destination: "script" }),
          "script load",
        );
      });

      Then("the network answered the request directly", async () => {
        await expectNetworkBody(await receivedResponse());
        expect(currentPage().browserLog).toEqual([
          {
            method: "GET",
            url: "http://localhost/assets/app.js",
            servedBy: "network",
          },
        ]);
      });
    },
  );

  Scenario(
    "A page that has not started the relay is not relayed",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      And("a second page that never started the relay", () => {
        secondPage = currentHarness().openPage();
      });

      When('the second page sends an XHR for "/api/users"', () =>
        secondPageXhr("/api/users"),
      );

      Then("the network answered the request directly", async () => {
        if (secondResponse === undefined) throw new Error("No XHR was sent");
        await expectNetworkBody(secondResponse);
        expect(currentSecondPage().browserLog).toEqual([
          { method: "GET", url: USERS_URL, servedBy: "network" },
        ]);
        expect(currentSecondPage().relayedFrames).toEqual([]);
        expect(currentMock().callCount()).toBe(0);
      });
    },
  );

  Scenario(
    "Each tab's requests go to the tab that made them",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      And(
        "a second page whose relay answers every request with:",
        async (_, docString: string) => {
          secondPage = currentHarness().openPage();
          await withTimeout(
            secondPage.respondToRelaysWith(parseJson(docString)),
            "the second page's hello",
          );
        },
      );

      When('the second page sends an XHR for "/api/users"', () =>
        secondPageXhr("/api/users"),
      );

      And('the page sends an XHR for "/api/users"', () =>
        pageXhr("/api/users"),
      );

      Then("the second page received:", async (_, docString: string) => {
        if (secondResponse === undefined) throw new Error("No XHR was sent");
        expect(await bodyOf(secondResponse)).toEqual(parseJson(docString));
      });

      And("the page received status 200 with the mocked users", () =>
        expectUsers(),
      );

      And("the mock answered 1 request", () => {
        expect(currentMock().callCount()).toBe(1);
      });
    },
  );

  Scenario(
    "Aborting a relayed XHR cancels it in the mock when the worker sees the abort",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/slow" after it is released and whose relay has started',
        () => givenRelayingPage(givenWaitingRoute),
      );

      And("the mock records its request:end statuses", () => {
        currentMock().on("request:end", (event) => {
          endStatuses.push(event.status);
        });
      });

      When(
        'the page sends an XHR for "/api/slow" and aborts it while the route runs',
        async () => {
          const controller = new AbortController();
          const pending = currentPage().xhr("/api/slow", {
            signal: controller.signal,
          });
          await startedOrSettled(pending);
          controller.abort();
          requestError = await rejectionOf(pending);
          // The route stays blocked: the abort must reach the mock through
          // the worker, not through the route finishing. Teardown releases it.
        },
      );

      Then("the mock ended the request with status 499", async () => {
        expect(requestError).toMatchObject({ name: "AbortError" });
        await vi.waitFor(() => expect(endStatuses).toEqual([499]), {
          timeout: SETTLE_MS,
        });
      });
    },
  );

  Scenario(
    "A failing hook reaches the caller as a network error",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users through a beforeResponse hook that throws "hook failed" and whose relay has started',
        () =>
          givenRelayingPage(usersRoute, {
            beforeResponse: () => {
              throw new Error("hook failed");
            },
          }),
      );

      When('the page fetches "/api/users" expecting a rejection', async () => {
        requestError = await withTimeout(
          rejectionOf(fetch("/api/users")),
          'fetch("/api/users")',
        );
      });

      Then("the fetch rejected with a TypeError", () => {
        expect(requestError).toBeInstanceOf(TypeError);
      });

      And('the page console logged the original error "hook failed"', () => {
        const logged = currentSpies().error.mock.calls.flat();
        expect(logged).toContainEqual(
          expect.objectContaining({ message: "hook failed" }),
        );
        expect(
          logged.some(
            (arg) => arg instanceof Error && arg.message === "hook failed",
          ),
        ).toBe(true);
      });
    },
  );

  Scenario(
    "Binary bodies survive the relay byte for byte",
    ({ Given, When, Then }) => {
      Given(
        'a page whose mock echoes the bytes posted to "POST /api/blob" and whose relay has started',
        () =>
          givenRelayingPage((target) => {
            target("POST /api/blob", ({ body }) => [
              200,
              body instanceof ArrayBuffer ? body : null,
              { "content-type": "application/octet-stream" },
            ]);
          }),
      );

      When(
        'the page sends an XHR posting the bytes "0,1,2,255" as "application/octet-stream" to "/api/blob"',
        () =>
          pageXhr("/api/blob", {
            method: "POST",
            body: Uint8Array.from([0, 1, 2, 255]),
            headers: { "content-type": "application/octet-stream" },
          }),
      );

      Then('the page received the bytes "0,1,2,255"', async () => {
        const received = await receivedResponse();
        expect([...new Uint8Array(await received.arrayBuffer())]).toEqual([
          0, 1, 2, 255,
        ]);
      });
    },
  );

  Scenario("Multipart form fields reach the route", ({ Given, When, Then }) => {
    Given(
      'a page whose mock answers "POST /api/form" with its form field "name" and whose relay has started',
      () =>
        givenRelayingPage((target) => {
          target("POST /api/form", ({ body }) => ({
            name: body instanceof FormData ? body.get("name") : null,
          }));
        }),
    );

    When(
      'the page sends an XHR posting a form with "name" set to "Ada" to "/api/form"',
      () => {
        const form = new FormData();
        form.set("name", "Ada");
        return pageXhr("/api/form", { method: "POST", body: form });
      },
    );

    Then("the page received:", async (_, docString: string) => {
      const received = await receivedResponse();
      expect(await bodyOf(received)).toEqual(parseJson(docString));
    });
  });

  Scenario(
    "A 204 response crosses the relay without a body",
    ({ Given, When, Then }) => {
      Given(
        'a page whose mock answers "DELETE /api/users/1" with no content and whose relay has started',
        () =>
          givenRelayingPage((target) => {
            target("DELETE /api/users/1", [204, null]);
          }),
      );

      When(
        'the page sends an XHR with method "DELETE" for "/api/users/1"',
        () => pageXhr("/api/users/1", { method: "DELETE" }),
      );

      Then("the page received status 204 and an empty body", async () => {
        const received = await receivedResponse();
        expect(received.status).toBe(204);
        expect(await received.text()).toBe("");
      });
    },
  );

  Scenario("Response headers cross the relay", ({ Given, When, Then }) => {
    Given(
      'a page whose mock answers "GET /api/users" with users and header "x-total-count" set to "42" and whose relay has started',
      () =>
        givenRelayingPage((target) => {
          target("GET /api/users", [200, USERS, { "x-total-count": "42" }]);
        }),
    );

    When('the page sends an XHR for "/api/users"', () => pageXhr("/api/users"));

    Then('the page received header "x-total-count" set to "42"', async () => {
      const received = await receivedResponse();
      expect(received.headers.get("x-total-count")).toBe("42");
    });
  });

  Scenario(
    "An origin-form baseUrl naming the page origin matches a relative request",
    ({ Given, When, Then }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users under the baseUrl "http://localhost/api" and whose relay has started',
        () =>
          givenRelayingPage(usersRoute, { baseUrl: "http://localhost/api" }),
      );

      When('the page fetches "/api/users"', () => pageFetches("/api/users"));

      Then("the page received status 200 with the mocked users", () =>
        expectUsers(),
      );
    },
  );

  Scenario(
    "The relay registers the configured script without the HTTP cache",
    ({ Given, When, Then, And }) => {
      Given(
        'an empty page at "/mocks/index.html" with the Schmock worker available at "/mocks/schmock-sw.js"',
        () => {
          page = createHarness(
            installRelayWorker,
            "/mocks/schmock-sw.js",
          ).openPage({ path: "/mocks/index.html" });
        },
      );

      When("the page starts the relay with:", async (_, docString: string) => {
        await startRelay(parseRelayOptions(docString));
      });

      Then(
        'the worker was registered from "/mocks/schmock-sw.js" with scope "/mocks/" and updateViaCache "none"',
        () => {
          expect(currentHarness().registerCalls).toEqual([
            {
              url: "/mocks/schmock-sw.js",
              options: { scope: "/mocks/", updateViaCache: "none" },
            },
          ]);
        },
      );

      And("the relay is active", () => {
        expect(currentRelay().active).toBe(true);
      });
    },
  );

  Scenario(
    "A scope wider than the script's directory falls back with the init command",
    ({ Given, When, Then, And }) => {
      Given(
        'an empty page at "/index.html" with the Schmock worker available at "/mocks/schmock-sw.js"',
        () => {
          page = createHarness(
            installRelayWorker,
            "/mocks/schmock-sw.js",
          ).openPage({ path: "/index.html" });
        },
      );

      When("the page starts the relay with:", async (_, docString: string) => {
        await startRelay(parseRelayOptions(docString));
      });

      Then('the relay fell back with reason "registration-failed"', () => {
        expectFellBack("registration-failed");
      });

      And('the page console warned with "npx schmock-devtools init"', () => {
        expectWarnedWith("npx schmock-devtools init");
      });
    },
  );

  Scenario(
    "A worker script that fails to install falls back",
    ({ Given, When, Then, And }) => {
      Given("a page whose worker script throws while installing", () => {
        page = createHarness(failingInstallWorker).openPage();
      });

      When("the page starts the relay", async () => {
        await startRelay();
      });

      Then('the relay fell back with reason "registration-failed"', () => {
        expectFellBack("registration-failed");
      });

      And('the page console warned with "the worker failed to install"', () => {
        expectWarnedWith("the worker failed to install");
      });
    },
  );

  Scenario(
    "Stopping the relay returns fetch answering to the page",
    ({ Given, When, Then, And }) => {
      let xhrResponse: Response | undefined;

      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When("the page stops the relay", async () => {
        await withTimeout(currentRelay().stop(), "stop()");
      });

      And('the page fetches "/api/users"', async () => {
        const seenBefore = currentPage().browserLog.length;
        await pageFetches("/api/users");
        unseenByBrowser = currentPage().browserLog.slice(seenBefore);
      });

      And('the page sends an XHR for "/api/users"', async () => {
        xhrResponse = await withTimeout(
          currentPage().xhr("/api/users"),
          "XHR /api/users",
        );
      });

      Then("the relay is not active", () => {
        expect(currentRelay().active).toBe(false);
      });

      And(
        "the fetch was answered in the page with status 200 without the browser seeing it",
        async () => {
          const received = await receivedResponse();
          expect(received.status).toBe(200);
          expect(await bodyOf(received)).toEqual(USERS);
          expect(unseenByBrowser).toEqual([]);
        },
      );

      And("the network answered the XHR directly", async () => {
        if (xhrResponse === undefined) throw new Error("No XHR was sent");
        await expectNetworkBody(xhrResponse);
        expect(currentPage().browserLog.at(-1)).toEqual({
          method: "GET",
          url: USERS_URL,
          servedBy: "network",
        });
      });
    },
  );

  Scenario(
    "A request the worker relays after stop is still answered by the mock",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When("the page stops the relay", async () => {
        await withTimeout(currentRelay().stop(), "stop()");
      });

      And(
        'the worker relays "GET http://localhost/api/users" to the page anyway',
        async () => {
          relayReply = await relayAsWorker("GET", USERS_URL);
        },
      );

      Then("the page answered the relayed request with status 200", () => {
        expect(relayReply).toMatchObject({
          type: "schmock:response",
          response: { status: 200 },
        });
      });
    },
  );

  Scenario(
    "The relay survives a worker restart",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When("the worker restarts with fresh memory", () => {
        currentHarness().restartWorker();
      });

      And('the page sends an XHR for "/api/users"', () =>
        pageXhr("/api/users"),
      );

      Then("the page received status 200 with the mocked users", () =>
        expectUsers(),
      );

      And(
        'the browser saw "GET http://localhost/api/users" served by the service worker',
        () => {
          expectSeenByBrowser(currentPage(), "GET", USERS_URL, "worker");
        },
      );
    },
  );

  Scenario(
    "A restarted worker holds other pages' requests until its registry loads, then sends them to the network",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      And("a second page that never started the relay", () => {
        secondPage = currentHarness().openPage();
      });

      When(
        "the worker restarts with fresh memory while its client registry is still loading",
        () => {
          releaseCaches = currentHarness().caches.hold();
          currentHarness().restartWorker();
        },
      );

      And(
        'the second page sends an XHR for "/api/users" without waiting for it',
        () => {
          pendingResponse = currentSecondPage().xhr("/api/users");
        },
      );

      And("the worker's client registry finishes loading", async () => {
        heldUntilLoaded = await stillPendingAfterAWhile(pendingResponse);
        releaseCaches();
        await currentHarness().flush();
      });

      Then(
        "the second page received the network's response through the service worker",
        async () => {
          expect(heldUntilLoaded).toBe(true);
          await expectNetworkBody(await receivedResponse());
          expectSeenByBrowser(currentSecondPage(), "GET", USERS_URL, "worker");
        },
      );
    },
  );

  Scenario(
    "A restarted worker holds the relaying page's requests until its registry loads, then relays them",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When(
        "the worker restarts with fresh memory while its client registry is still loading",
        () => {
          releaseCaches = currentHarness().caches.hold();
          currentHarness().restartWorker();
        },
      );

      And(
        'the page sends an XHR for "/api/users" without waiting for it',
        () => {
          pendingResponse = currentPage().xhr("/api/users");
        },
      );

      And("the worker's client registry finishes loading", async () => {
        heldUntilLoaded = await stillPendingAfterAWhile(pendingResponse);
        releaseCaches();
        await currentHarness().flush();
      });

      Then("the page received status 200 with the mocked users", async () => {
        expect(heldUntilLoaded).toBe(true);
        await expectUsers();
      });

      And(
        'the browser saw "GET http://localhost/api/users" served by the service worker',
        () => {
          expectSeenByBrowser(currentPage(), "GET", USERS_URL, "worker");
        },
      );
    },
  );

  Scenario(
    "A worker update re-establishes the relay",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When("a new worker version takes control of the page", async () => {
        await withTimeout(currentHarness().replaceWorker(), "replaceWorker()");
        await currentHarness().flush();
      });

      Then("the relay is active", () => expectActiveEventually());

      And("the new worker received a hello from the page", () =>
        expectHelloFromPage(),
      );

      And(
        'the page sending an XHR for "/api/users" is answered by the service worker with status 200',
        () => expectXhrServedByWorker("/api/users"),
      );
    },
  );

  Scenario(
    "A worker update during startup is followed",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose worker is replaced by a new version during the handshake',
        () => {
          // The first version answers no hello: while the page waits, a new
          // version (the real worker) takes over. Only after that does the
          // first version reply, with a protocol the page must ignore.
          const h = createHarness(
            stubWorker((hello, event, port) => {
              event.waitUntil(
                h.replaceWorker(installRelayWorker).then(() => {
                  answerReady(port, {
                    type: "schmock:ready",
                    protocol: 99,
                    version: hello.version,
                  });
                }),
              );
            }),
          );
          openPageWithMock(usersRoute);
        },
      );

      When("the page starts the relay", async () => {
        await startRelay();
      });

      Then("the relay is active", () => expectActiveEventually());

      And("the new worker received a hello from the page", () =>
        expectHelloFromPage(),
      );

      And(
        'the page sending an XHR for "/api/users" is answered by the service worker with status 200',
        () => expectXhrServedByWorker("/api/users"),
      );
    },
  );

  Scenario(
    "A page that goes into the back-forward cache keeps its relay",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When(
        "the page is hidden into the back-forward cache and shown again",
        async () => {
          currentPage().hide(true);
          currentPage().show();
          await currentHarness().flush();
        },
      );

      And('the page sends an XHR for "/api/users"', () =>
        pageXhr("/api/users"),
      );

      Then("the page received status 200 with the mocked users", () =>
        expectUsers(),
      );
    },
  );

  Scenario("A page that unloads says goodbye", ({ Given, When, Then }) => {
    Given(
      'a page whose mock answers "GET /api/users" with users and whose relay has started',
      () => givenRelayingPage(usersRoute),
    );

    When("the page unloads", async () => {
      currentPage().hide(false);
      await currentHarness().flush();
    });

    Then("the worker no longer relays requests from that page", async () => {
      const target = currentPage();
      const framesBefore = target.relayedFrames.length;
      const received = await withTimeout(
        target.xhr("/api/users"),
        "XHR /api/users",
      );
      await expectNetworkBody(received);
      expect(target.browserLog.at(-1)).toEqual({
        method: "GET",
        url: USERS_URL,
        servedBy: "network",
      });
      expect(target.relayedFrames).toHaveLength(framesBefore);
      expect(currentMock().callCount()).toBe(0);
    });
  });

  Scenario(
    "A hard-reloaded page asks the worker to take control",
    ({ Given, When, Then, And }) => {
      Given("a worker that is already active", async () => {
        await createHarness().activateWorker();
      });

      And(
        'a page whose mock answers "GET /api/users" with users and that the worker does not control',
        () => {
          openPageWithMock(usersRoute, { controlled: false });
        },
      );

      When("the page starts the relay", async () => {
        await startRelay();
      });

      Then("the worker received a claim request", () => {
        expect(currentHarness().worker.received).toContainEqual({
          data: { type: "schmock:claim" },
          source: currentPage().id,
        });
      });

      And("the relay is active", () => {
        expect(currentRelay().active).toBe(true);
      });
    },
  );

  Scenario(
    "A page the worker cannot claim falls back",
    ({ Given, When, Then, And }) => {
      Given("a worker that is already active", async () => {
        await createHarness().activateWorker();
      });

      And(
        'a page whose mock answers "GET /api/users" with users and that the worker cannot claim',
        () => {
          openPageWithMock(usersRoute, { controlled: false, claimable: false });
        },
      );

      When("the page starts the relay with a timeout of 50 ms", async () => {
        await startRelay({ timeout: 50 });
      });

      Then('the relay fell back with reason "not-controlled"', () => {
        expectFellBack("not-controlled");
      });

      And('the page console warned with "reload normally"', () => {
        expectWarnedWith("reload normally");
      });
    },
  );

  Scenario(
    "Another service worker on the scope is left alone",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose scope is controlled by another service worker "/app-sw.js"',
        () => {
          const h = createHarness();
          h.seedForeignRegistration("/app-sw.js");
          page = h.openPage();
        },
      );

      When("the page starts the relay", async () => {
        await startRelay();
      });

      Then('the relay fell back with reason "scope-taken"', () => {
        expectFellBack("scope-taken");
      });

      And("no service worker was registered", () => {
        expect(currentHarness().registerCalls).toEqual([]);
      });

      And('the page console warned with "/app-sw.js"', () => {
        expectWarnedWith("/app-sw.js");
      });
    },
  );

  Scenario(
    "A service worker on a parent scope does not block Schmock's own scope",
    ({ Given, When, Then, And }) => {
      Given(
        'a page at "/app/index.html" controlled by another service worker "/app-sw.js" registered with scope "/"',
        () => {
          createHarness().seedForeignRegistration("/app-sw.js", "/");
        },
      );

      And(`the page's mock answers "GET /app/api/users" with users`, () => {
        openPageWithMock(
          (target) => {
            target("GET /app/api/users", USERS);
          },
          { path: "/app/index.html" },
        );
      });

      When("the page starts the relay with:", async (_, docString: string) => {
        await startRelay(parseRelayOptions(docString));
      });

      Then("the relay is active", () => {
        expect(currentRelay().active).toBe(true);
      });

      And(
        'the service worker registered with scope "/" is still registered',
        () => {
          expect(currentHarness().registrations).toContainEqual({
            scope: "http://localhost/",
            scriptURL: "http://localhost/app-sw.js",
          });
        },
      );

      And(
        'the page sending an XHR for "/app/api/users" is answered by the service worker with status 200',
        () => expectXhrServedByWorker("/app/api/users"),
      );
    },
  );

  Scenario(
    "A page that another worker keeps under its narrower scope falls back and names that worker",
    ({ Given, When, Then, And }) => {
      Given(
        'a page at "/app/index.html" controlled by another service worker "/app/app-sw.js" registered with scope "/app/"',
        () => {
          createHarness().seedForeignRegistration("/app/app-sw.js", "/app/");
        },
      );

      And(`the page's mock answers "GET /app/api/users" with users`, () => {
        openPageWithMock(
          (target) => {
            target("GET /app/api/users", USERS);
          },
          { path: "/app/index.html" },
        );
      });

      When("the page starts the relay with a timeout of 50 ms", async () => {
        await startRelay({ timeout: 50 });
      });

      Then('the relay fell back with reason "not-controlled"', () => {
        expectFellBack("not-controlled");
      });

      And('the page console warned with "/app/app-sw.js"', () => {
        expectWarnedWith("/app/app-sw.js");
      });
    },
  );

  Scenario(
    "A worker script from another protocol keeps the page in fallback",
    ({ Given, When, Then, And }) => {
      Given(
        "a page whose worker answers the handshake with protocol 99",
        () => {
          createHarness(
            stubWorker((hello, _event, port) => {
              answerReady(port, {
                type: "schmock:ready",
                protocol: 99,
                version: hello.version,
              });
            }),
          );
          openPageWithMock(usersRoute);
        },
      );

      When("the page starts the relay", async () => {
        await startRelay();
      });

      Then('the relay fell back with reason "protocol-mismatch"', () => {
        expectFellBack("protocol-mismatch");
      });

      And('the page console warned with "npx schmock-devtools init"', () => {
        expectWarnedWith("npx schmock-devtools init");
      });

      And("the page's fetches are still answered in the page", async () => {
        const seenBefore = currentPage().browserLog.length;
        await pageFetches("/api/users");
        await expectUsers();
        expect(currentPage().browserLog.slice(seenBefore)).toEqual([]);
      });
    },
  );

  Scenario(
    "A worker copied from another package version only warns",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose worker answers the handshake with the current protocol and version "0.0.1"',
        () => {
          page = createHarness(
            stubWorker((hello, _event, port) => {
              answerReady(port, {
                type: "schmock:ready",
                protocol: hello.protocol,
                version: "0.0.1",
              });
            }),
          ).openPage();
        },
      );

      When("the page starts the relay", async () => {
        await startRelay();
      });

      Then("the relay is active", () => {
        expect(currentRelay().active).toBe(true);
      });

      And('the page console warned with "0.0.1"', () => {
        expectWarnedWith("0.0.1");
      });
    },
  );

  Scenario(
    "A missing worker script falls back with the init command",
    ({ Given, When, Then, And }) => {
      Given("a page whose worker script is not served", () => {
        const h = createHarness();
        h.serveScript(false);
        page = h.openPage();
      });

      When("the page starts the relay", async () => {
        await startRelay();
      });

      Then('the relay fell back with reason "registration-failed"', () => {
        expectFellBack("registration-failed");
      });

      And('the page console warned with "npx schmock-devtools init"', () => {
        expectWarnedWith("npx schmock-devtools init");
      });
    },
  );

  Scenario(
    "A worker that never answers the handshake falls back",
    ({ Given, When, Then }) => {
      Given("a page whose worker never answers the handshake", () => {
        page = createHarness(stubWorker(() => {})).openPage();
      });

      When("the page starts the relay with a timeout of 50 ms", async () => {
        await startRelay({ timeout: 50 });
      });

      Then('the relay fell back with reason "timeout"', () => {
        expectFellBack("timeout");
      });
    },
  );

  Scenario(
    "Without service worker support the relay falls back and mocking continues",
    ({ Given, When, Then, And }) => {
      Given(
        'a page without service worker support whose mock answers "GET /api/users" with users',
        () => {
          createHarness();
          openPageWithMock(usersRoute, { serviceWorkers: false });
        },
      );

      When("the page starts the relay", async () => {
        await startRelay();
      });

      And('the page fetches "/api/users"', () => pageFetches("/api/users"));

      Then('the relay fell back with reason "unsupported"', () => {
        expectFellBack("unsupported");
      });

      And("the page received status 200 with the mocked users", () =>
        expectUsers(),
      );
    },
  );

  Scenario("An insecure page falls back", ({ Given, When, Then }) => {
    Given(
      'an insecure page whose mock answers "GET /api/users" with users',
      () => {
        createHarness();
        openPageWithMock(usersRoute, { secure: false });
      },
    );

    When("the page starts the relay", async () => {
      await startRelay();
    });

    Then('the relay fell back with reason "insecure-context"', () => {
      expectFellBack("insecure-context");
    });
  });

  Scenario(
    "Starting the relay twice gives the same relay",
    ({ Given, When, Then }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When(
        "the page starts the relay again with the same options",
        async () => {
          secondRelay = await createServiceWorkerRelay(
            currentPage().environment,
          );
          relays.push(secondRelay);
        },
      );

      Then("both starts gave the same relay", () => {
        expect(secondRelay).toBe(currentRelay());
      });
    },
  );

  Scenario(
    "Starting the relay again with other options is rejected",
    ({ Given, When, Then }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      When(
        "the page starts the relay again with:",
        async (_, docString: string) => {
          startError = await rejectionOf(
            createServiceWorkerRelay(
              currentPage().environment,
              parseRelayOptions(docString),
            ).then((started) => {
              relays.push(started);
              return started;
            }),
          );
        },
      );

      Then(
        'starting rejects with a SchmockError with code "DEVTOOLS_RELAY_ALREADY_STARTED"',
        () => {
          expect(startError).toBeInstanceOf(SchmockError);
          expect(startError).toMatchObject({
            code: "DEVTOOLS_RELAY_ALREADY_STARTED",
          });
        },
      );
    },
  );

  Scenario(
    "The devtools reporter reports relayed requests",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users, piped with the devtools plugin, and whose relay has started',
        async () => {
          // The page is served from http://localhost, so the reporter labels
          // same-origin requests by path.
          vi.stubGlobal("location", new URL("http://localhost/index.html"));
          await givenRelayingPage((target) => {
            target("GET /api/users", USERS);
            target.pipe(devtoolsPlugin());
          });
        },
      );

      When('the page sends an XHR for "/api/users"', () =>
        pageXhr("/api/users"),
      );

      Then(
        "exactly 1 collapsed console group was opened and closed",
        async () => {
          currentRelay();
          const { groupCollapsed, groupEnd } = currentSpies();
          await vi.waitFor(() => expect(groupEnd).toHaveBeenCalled(), {
            timeout: SETTLE_MS,
          });
          expect(groupCollapsed).toHaveBeenCalledTimes(1);
          expect(groupEnd).toHaveBeenCalledTimes(1);
          expect(groupEnd.mock.invocationCallOrder[0]).toBeGreaterThan(
            groupCollapsed.mock.invocationCallOrder[0],
          );
        },
      );

      And(
        'the group title reads "Schmock GET /api/users → 200" followed by the duration',
        () => {
          expectGroupTitle("Schmock GET /api/users → 200");
        },
      );
    },
  );

  /**
   * True when `pending` is still unsettled after the worker had time to
   * answer it: the hold keeps the registry loading, so a correct worker
   * cannot answer before it is released.
   */
  async function stillPendingAfterAWhile(
    pending: Promise<unknown> | undefined,
  ): Promise<boolean> {
    if (pending === undefined) throw new Error("No request was made");
    const state = { settled: false };
    pending.then(
      () => {
        state.settled = true;
      },
      () => {
        state.settled = true;
      },
    );
    await delay(20);
    return !state.settled;
  }
  Scenario(
    "A failing mock's error log keeps the request URL literal",
    ({ Given, When, Then }) => {
      Given(
        'a page whose mock answers "GET /discount/:code" through a beforeResponse hook that throws "hook failed" and whose relay has started',
        () =>
          givenRelayingPage(
            (target) => {
              target("GET /discount/:code", { ok: true });
            },
            {
              beforeResponse: () => {
                throw new Error("hook failed");
              },
            },
          ),
      );

      When(
        'the page fetches "/discount/20%cut" expecting a rejection',
        async () => {
          requestError = await withTimeout(
            rejectionOf(fetch("/discount/20%cut")),
            'fetch("/discount/20%cut")',
          );
        },
      );

      Then(
        'the page console logged "GET http://localhost/discount/20%cut failed in the mock" with the original error "hook failed"',
        () => {
          const calls = currentSpies().error.mock.calls;
          expect(calls).toHaveLength(1);
          const rendered = renderConsole(calls[0]);
          expect(rendered).toContain(
            "GET http://localhost/discount/20%cut failed in the mock",
          );
          expect(rendered).toContain("hook failed");
        },
      );
    },
  );

  Scenario(
    "A page outside the worker's scope falls back without waiting",
    ({ Given, When, Then, And }) => {
      Given(
        'an empty page at "/index.html" with the Schmock worker available at "/mocks/schmock-sw.js"',
        () => {
          page = createHarness(
            installRelayWorker,
            "/mocks/schmock-sw.js",
          ).openPage({ path: "/index.html" });
        },
      );

      When("the page starts the relay with:", async (_, docString: string) => {
        await startRelay(parseRelayOptions(docString));
      });

      Then('the relay fell back with reason "not-controlled"', () => {
        expectFellBack("not-controlled");
      });

      And("no service worker was registered", () => {
        expect(currentHarness().registerCalls).toEqual([]);
      });

      And(
        'the page console warned with "can only control pages under http://localhost/mocks/"',
        () => {
          expectWarnedWith(
            "can only control pages under http://localhost/mocks/",
          );
        },
      );
    },
  );

  Scenario(
    "A sandboxed page that cannot read navigator.serviceWorker falls back as unsupported",
    ({ Given, When, Then, And }) => {
      Given(
        "a sandboxed page where reading navigator.serviceWorker throws a SecurityError",
        () => {
          spies = spyOnConsole();
          vi.stubGlobal("navigator", {
            get serviceWorker(): never {
              throw new DOMException(
                "Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.",
                "SecurityError",
              );
            },
          });
        },
      );

      When(
        "the page starts the relay through startServiceWorkerRelay",
        async () => {
          const started = await startServiceWorkerRelay();
          relays.push(started);
          relay = started;
        },
      );

      Then('the relay fell back with reason "unsupported"', () => {
        expectFellBack("unsupported");
      });

      And(
        'the page console warned with "service workers are unavailable here"',
        () => {
          expectWarnedWith("service workers are unavailable here");
        },
      );
    },
  );

  Scenario(
    "Invalid relay options are rejected before support is checked, naming only the first invalid option",
    ({ Given, When, Then, And }) => {
      let outcomes: { expected: InvalidOptionCase; error: unknown }[] = [];

      Given("a page without service worker support", () => {
        page = createHarness().openPage({ serviceWorkers: false });
      });

      When(
        "the page starts the relay with each of these options:",
        async (_, docString: string) => {
          const environment = currentPage().environment;
          outcomes = [];
          for (const expected of parseInvalidOptionCases(docString)) {
            const error = await rejectionOf(
              startWithUntypedOptions(environment, expected.options),
            );
            outcomes.push({ expected, error });
          }
        },
      );

      Then(
        'each start rejected with a SchmockError with code "DEVTOOLS_CONFIG_INVALID", the listed option, received value and message',
        () => {
          expect(outcomes).toHaveLength(9);
          for (const { expected, error } of outcomes) {
            expect(error).toBeInstanceOf(SchmockError);
            expect(error).toMatchObject({
              code: "DEVTOOLS_CONFIG_INVALID",
              message: expected.message,
              context: { option: expected.option },
            });
            expect(Reflect.get(Object(error), "context")).toEqual({
              option: expected.option,
              received: expected.received,
            });
          }
        },
      );

      And("the page console warned nothing", () => {
        expect(currentSpies().warn).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Stopping the relay leaves the worker registered for other tabs",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => givenRelayingPage(usersRoute),
      );

      And(
        "a second page whose relay answers every request with:",
        async (_, docString: string) => {
          secondPage = currentHarness().openPage();
          await withTimeout(
            secondPage.respondToRelaysWith(parseJson(docString)),
            "the second page's hello",
          );
        },
      );

      When("the page stops the relay", async () => {
        await withTimeout(currentRelay().stop(), "stop()");
      });

      And('the second page sends an XHR for "/api/users"', () =>
        secondPageXhr("/api/users"),
      );

      Then(
        "the Schmock worker is still registered and still controls the page",
        () => {
          expect(currentRelay().active).toBe(false);
          expect(currentHarness().registrations).toEqual([
            {
              scope: "http://localhost/",
              scriptURL: "http://localhost/schmock-sw.js",
            },
          ]);
          expect(
            currentPage().environment.container?.controller?.scriptURL,
          ).toBe("http://localhost/schmock-sw.js");
        },
      );

      And(
        "the second page received through the service worker:",
        async (_, docString: string) => {
          if (secondResponse === undefined) throw new Error("No XHR was sent");
          expect(await bodyOf(secondResponse)).toEqual(parseJson(docString));
          expectSeenByBrowser(currentSecondPage(), "GET", USERS_URL, "worker");
          expect(currentMock().callCount()).toBe(0);
        },
      );
    },
  );

  Scenario(
    "A lease taken after the relay started is answered by the service worker",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users but takes no lease, and whose relay has started',
        async () => {
          page = createHarness().openPage();
          globalThis.fetch = page.networkFetch;
          mock = schmock();
          usersRoute(mock);
          await startRelay();
          expect(currentRelay().active).toBe(true);
        },
      );

      When("the mock takes its lease", () => {
        handles.push(currentMock().intercept());
      });

      And('the page fetches "/api/users"', () => pageFetches("/api/users"));

      Then("the page received status 200 with the mocked users", () =>
        expectUsers(),
      );

      And(
        'the browser saw "GET http://localhost/api/users" served by the service worker',
        () => {
          expectSeenByBrowser(currentPage(), "GET", USERS_URL, "worker");
        },
      );

      And("the network received no request", () => {
        expect(currentHarness().network).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    "Documented hazard - a request no lease answers during a worker update is routed twice",
    ({ Given, When, Then, And }) => {
      Given(
        'a page whose mock answers "GET /api/users" with users and whose relay has started',
        () => {
          // The in-page passthrough resolves a relative URL against location,
          // which Node lacks; in the browser it is the page's URL.
          vi.stubGlobal("location", new URL("http://localhost/index.html"));
          return givenRelayingPage(usersRoute);
        },
      );

      And("the mock records its lifecycle events", () => recordLifecycle());

      When(
        "a new worker version that holds the page's hello takes control of the page",
        async () => {
          const gate = new Promise<void>((resolve) => {
            releaseHellos = resolve;
          });
          // The new version answers no hello until the gate opens, which keeps
          // the relay reconnecting. No flush() here: it would wait on the held hello.
          await withTimeout(
            currentHarness().replaceWorker(
              relayWorkerFilteringHellos((event, deliver) => {
                event.waitUntil(gate.then(deliver));
              }),
            ),
            "replaceWorker()",
          );
          const pageId = currentPage().id;
          await vi.waitFor(
            () => {
              expect(helloFrom(currentHarness().worker, pageId)).toBe(true);
              expect(currentRelay().active).toBe(false);
            },
            { timeout: SETTLE_MS },
          );
        },
      );

      And('the page fetches "/api/other" while the relay reconnects', () =>
        pageFetches("/api/other"),
      );

      Then("the page received the network's response", async () => {
        await expectNetworkBody(await receivedResponse());
      });

      And(
        'the worker fetched "GET http://localhost/api/other" from the network once, for a request it served',
        () => {
          expect(networkRequests()).toEqual([
            { method: "GET", url: "http://localhost/api/other" },
          ]);
          expect(currentPage().browserLog).toEqual([
            {
              method: "GET",
              url: "http://localhost/api/other",
              servedBy: "worker",
            },
          ]);
        },
      );

      And(
        'the mock emitted "request:start", "request:notfound" and "request:end" twice each, and no match',
        () => {
          const count = (name: string) =>
            lifecycle.filter((event) => event === name).length;
          expect(count("request:start")).toBe(2);
          expect(count("request:notfound")).toBe(2);
          expect(count("request:end")).toBe(2);
          expect(count("request:match")).toBe(0);
        },
      );

      And(
        "the relay is active again once the new worker answers the hello",
        async () => {
          releaseHellos();
          await expectActiveEventually();
        },
      );
    },
  );

  Scenario(
    "startServiceWorkerRelay returns the running relay for the same options and rejects other options",
    ({ Given, When, Then, And }) => {
      let firstStart: Promise<ServiceWorkerRelay> | undefined;
      let secondStart: Promise<ServiceWorkerRelay> | undefined;

      Given(
        'a page whose mock answers "GET /api/users" with users and whose navigator exposes its service worker container',
        () => {
          createHarness();
          const target = openPageWithMock(usersRoute);
          vi.stubGlobal("navigator", {
            serviceWorker: target.environment.container,
          });
          vi.stubGlobal("isSecureContext", true);
          vi.stubGlobal("location", new URL(target.environment.baseUrl));
        },
      );

      When(
        "the page starts the relay through startServiceWorkerRelay with no options",
        async () => {
          firstStart = startServiceWorkerRelay();
          const started = await withTimeout(firstStart, "the first start");
          relays.push(started);
          relay = started;
        },
      );

      And(
        "the page starts it again through startServiceWorkerRelay with the default spelled out:",
        async (_, docString: string) => {
          secondStart = startServiceWorkerRelay(parseRelayOptions(docString));
          secondRelay = await withTimeout(secondStart, "the second start");
        },
      );

      And(
        "the page starts it once more through startServiceWorkerRelay with:",
        async (_, docString: string) => {
          startError = await withTimeout(
            rejectionOf(startServiceWorkerRelay(parseRelayOptions(docString))),
            "the third start",
          );
        },
      );

      Then(
        "the second start returned the same promise and the same active relay",
        () => {
          expect(secondStart).toBe(firstStart);
          expect(secondRelay).toBe(currentRelay());
          expect(currentRelay().active).toBe(true);
        },
      );

      And(
        'the third start rejected with a SchmockError with code "DEVTOOLS_RELAY_ALREADY_STARTED" whose context is:',
        (_, docString: string) => {
          expect(startError).toBeInstanceOf(SchmockError);
          expect(startError).toMatchObject({
            code: "DEVTOOLS_RELAY_ALREADY_STARTED",
          });
          // JSON has no undefined: the running relay's omitted scope stays
          // undefined, which toEqual treats as absent.
          expect(Reflect.get(Object(startError), "context")).toEqual(
            parseJson(docString),
          );
        },
      );

      And("the running relay is still active", () => {
        expect(currentRelay().active).toBe(true);
      });
    },
  );

  Scenario(
    "After a fallback an XHR reaches the network unmocked while fetch is answered in the page",
    ({ Given, When, Then, And }) => {
      let xhrResponse: Response | undefined;

      Given(
        'a page the Schmock worker already controls, whose mock answers "GET /api/users" with users and whose worker never answers the handshake',
        async () => {
          // Hellos are dropped, not held: a hello released after the page's
          // timeout goodbye would re-register the page. The worker is active
          // and controls the page before the start, so the deadline can only
          // expire in the handshake.
          await createHarness(
            relayWorkerFilteringHellos(() => {}),
          ).activateWorker();
          openPageWithMock(usersRoute);
        },
      );

      When("the page starts the relay with a timeout of 100 ms", async () => {
        await startRelay({ timeout: 100 });
      });

      And('the page fetches "/api/users"', async () => {
        const seenBefore = currentPage().browserLog.length;
        await pageFetches("/api/users");
        unseenByBrowser = currentPage().browserLog.slice(seenBefore);
      });

      And('the page sends an XHR for "/api/users"', async () => {
        xhrResponse = await withTimeout(
          currentPage().xhr("/api/users"),
          "XHR /api/users",
        );
      });

      Then('the relay fell back with reason "timeout"', () => {
        expectFellBack("timeout");
      });

      And(
        "the fetch was answered in the page with status 200 without the browser seeing it",
        async () => {
          const received = await receivedResponse();
          expect(received.status).toBe(200);
          expect(await bodyOf(received)).toEqual(USERS);
          expect(unseenByBrowser).toEqual([]);
        },
      );

      And(
        "the XHR was answered by the network although the Schmock worker controls the page",
        async () => {
          if (xhrResponse === undefined) throw new Error("No XHR was sent");
          await expectNetworkBody(xhrResponse);
          expect(
            currentPage().environment.container?.controller?.scriptURL,
          ).toBe("http://localhost/schmock-sw.js");
          expect(currentPage().relayedFrames).toEqual([]);
          expect(currentPage().browserLog).toEqual([
            { method: "GET", url: USERS_URL, servedBy: "network" },
          ]);
        },
      );

      And("the mock answered 1 request", () => {
        expect(currentMock().callCount()).toBe(1);
      });
    },
  );
});
