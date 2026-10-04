import { type Mock, vi } from "vitest";
import type {
  CacheLike,
  CacheStorageLike,
  ClientLike,
  ExtendableEventLike,
  ExtendableMessageEventLike,
  FetchEventLike,
  HelloMessage,
  RelayContainer,
  RelayEnvironment,
  RelayMessageEvent,
  RelayRegistration,
  RelayReply,
  RelayWorker,
  RelayWorkerScope,
} from "../relay/types.js";

/*
 * In-process browser fakes for the service-worker relay (plan E.6).
 *
 * Only the service-worker objects are faked. MessageChannel, Request,
 * Response and AbortController are Node's real implementations. The fakes
 * follow the Service Worker spec (registration lifecycle, longest-prefix
 * matching, claim eligibility, activation handing over controlled pages, the
 * client message queue), so code that is green against them is not green by
 * accident. relay-harness.test.ts pins every one of these behaviours.
 *
 * A listener that throws is reported as an uncaught error, so the test fails;
 * a browser would log it and go on.
 */

export interface FakeWorkerScope extends RelayWorkerScope {
  /** Every message this scope received, in order, with the sending client's id. Reset by restartWorker()/replaceWorker(). */
  readonly received: readonly {
    readonly data: unknown;
    readonly source: string;
  }[];
}

interface FakeCacheStorage extends CacheStorageLike {
  /** Pause every open(), and every match()/put() on an opened cache, until the returned release function is called; survives restartWorker(). */
  hold(): () => void;
}

export interface RelayHarness {
  readonly origin: string;
  /** Scope of the newest Schmock worker instance (installWorker/activateWorker/restartWorker/replaceWorker); caches === harness.caches. */
  readonly worker: FakeWorkerScope;
  /** The real network as both page and worker see it: vi.fn resolving 200 "real network" with header x-from: network. */
  readonly network: Mock<(request: Request) => Promise<Response>>;
  /** Survives restartWorker(). */
  readonly caches: FakeCacheStorage;
  /** Every container.register() call, in order, with its arguments as passed. */
  readonly registerCalls: readonly {
    readonly url: string;
    readonly options: unknown;
  }[];
  /** The registrations that exist now, seeded ones included. */
  readonly registrations: readonly {
    readonly scope: string;
    readonly scriptURL: string;
  }[];
  /**
   * Serve a worker script at scriptURL (default origin + "/schmock-sw.js"); register() of that URL runs setup against a fresh scope. Registers nothing by itself.
   * Serving again at the same URL serves new bytes: the next register() installs a new version; re-registering unchanged bytes reinstalls nothing.
   * A setup that throws makes register() reject with a TypeError ("ServiceWorker script evaluation failed", the error as its cause).
   */
  installWorker(
    setup: (scope: FakeWorkerScope) => void,
    scriptURL?: string,
  ): void;
  /** As if an earlier visit registered the most recently served script: create its registration (scope default: the script's directory), run setup, install and activate. Not recorded in registerCalls. Rejects with what setup throws. */
  activateWorker(scope?: string): Promise<void>;
  /** The browser stopped and restarted the worker: fresh scope memory, same registration and caches, setup re-run, NO install/activate events. Rethrows what setup throws. */
  restartWorker(): void;
  /**
   * A new version at the same registration (same script URL unless given; setup
   * defaults to the script served there): fresh scope, setup run, install, then
   * activate whether or not it calls skipWaiting. As the spec's Activate step
   * does, activation hands every page already using the registration to the
   * new version with one controllerchange, whether or not the new version
   * claims; its claim reaches only pages it did not control yet. Resolves once
   * the new version is "activated"; rejects with what setup throws.
   */
  replaceWorker(
    setup?: (scope: FakeWorkerScope) => void,
    scriptURL?: string,
  ): Promise<void>;
  /**
   * path default "/index.html"; secure and serviceWorkers default true; claimable default true.
   * A page starts controlled by the active worker of its longest-prefix registration when one exists,
   * unless controlled is false (a hard reload). claimable false makes every claim skip it.
   */
  openPage(options?: {
    path?: string;
    controlled?: boolean;
    secure?: boolean;
    serviceWorkers?: boolean;
    claimable?: boolean;
  }): FakePage;
  /** The app's own registration (scope default origin + "/") with an active worker that has no listeners. */
  seedForeignRegistration(scriptURL: string, scope?: string): void;
  /** false: register() rejects as a 404 script would: TypeError("Failed to register a ServiceWorker: A bad HTTP response code (404) was received"). register() of a URL nothing was served at rejects the same way. */
  serveScript(available: boolean): void;
  /**
   * Resolves once every message posted so far is delivered and every waitUntil promise has settled,
   * as have lifecycle steps, startMessages()/show() deliveries and fetch-event dispatch; then three
   * more quiet macrotasks let messages on the relay's own ports land.
   * It does NOT wait for respondWith promises, so it returns while a relayed request is still pending.
   * It stays pending while a waitUntil waits on an unreleased caches.hold().
   */
  flush(): Promise<void>;
  /** Close every MessagePort the harness and its pages opened; restores no globals. */
  dispose(): void;
}

export interface FakePage {
  readonly id: string;
  /** Pass to createServiceWorkerRelay; container undefined when serviceWorkers is false; baseUrl is origin + path. */
  readonly environment: RelayEnvironment;
  /** fetch() as the browser runs it (destination ""): install as globalThis.fetch BEFORE mock.intercept(). */
  readonly networkFetch: typeof fetch;
  /** An XHR: destination "", never goes through globalThis.fetch. */
  xhr(url: string, init?: RequestInit): Promise<Response>;
  /**
   * A non-fetch request: e.g. { destination: "script" } or { mode: "navigate" }.
   * A navigation goes to the active worker of the registration matching its target URL, with clientId "";
   * every other request goes to the page's controller, with the page's id.
   */
  load(
    url: string,
    kind: { destination?: string; mode?: RequestMode },
  ): Promise<Response>;
  /** Every browser-level request that got a response, and who served it. A network error or an abort is not logged. */
  readonly browserLog: ReadonlyArray<{
    method: string;
    url: string;
    servedBy: "worker" | "network";
  }>;
  /** schmock:request frames this page's container received. */
  readonly relayedFrames: readonly unknown[];
  /**
   * Fire pagehide listeners; persisted true puts the page in the bfcache (matchAll omits it, claim skips it) until show().
   * While in the bfcache, its events (statechange, controllerchange, container messages) wait until show().
   * Chrome's eviction of bfcached pages is not modelled. hide(false) does not close the page: call close() for that.
   */
  hide(persisted: boolean): void;
  /** Restore from the bfcache, then deliver the events it held. */
  show(): void;
  /** The client disappears: clients.get(id) → undefined, matchAll omits it. */
  close(): void;
  /**
   * Make this page a stub tab: say hello, then answer every schmock:request with this JSON (200).
   * The hello offers protocol 1 (plan A.2's RELAY_PROTOCOL_VERSION), then the protocol the worker's
   * ready names if that differs. Rejects when the page is uncontrolled or the worker never answers.
   */
  respondToRelaysWith(body: unknown): Promise<void>;
}

// ── internals ────────────────────────────────────────────────────────

const DEFAULT_ORIGIN = "http://localhost";
const DEFAULT_SCRIPT_PATH = "/schmock-sw.js";
const DEFAULT_PAGE_PATH = "/index.html";
const SCRIPT_NOT_FOUND =
  "Failed to register a ServiceWorker: A bad HTTP response code (404) was received";
/**
 * The protocol a stub tab offers first: RELAY_PROTOCOL_VERSION in plan A.2.
 * The harness imports no runtime relay code, so when the worker's `ready`
 * names another protocol the stub tab says hello again with that one.
 */
const STUB_TAB_FIRST_PROTOCOL = 1;

type WorkerState =
  | "installing"
  | "installed"
  | "activating"
  | "activated"
  | "redundant";

type Setup = (scope: FakeWorkerScope) => void;

type ScopeListenerArgs =
  | ["install" | "activate", (event: ExtendableEventLike) => void]
  | ["message", (event: ExtendableMessageEventLike) => void]
  | ["fetch", (event: FetchEventLike) => void];

type ContainerListenerArgs =
  | ["message", (event: RelayMessageEvent) => void]
  | ["controllerchange", () => void];

interface ServedScript {
  readonly url: string;
  readonly setup: Setup;
  /** Bumped whenever another script is served at the same URL ("new bytes"). */
  readonly revision: number;
}

interface ScopeRecord {
  readonly api: FakeWorkerScope;
  readonly received: { data: unknown; source: string }[];
  readonly install: ((event: ExtendableEventLike) => void)[];
  readonly activate: ((event: ExtendableEventLike) => void)[];
  readonly message: ((event: ExtendableMessageEventLike) => void)[];
  readonly fetch: ((event: FetchEventLike) => void)[];
}

/** A worker version as the spec's "service worker": one script run at one registration. */
interface VersionCore {
  readonly scriptURL: string;
  /** -1 for a seeded foreign worker. */
  readonly revision: number;
  /** undefined for a seeded foreign worker, which has no listeners. */
  readonly setup: Setup | undefined;
  readonly registration: RegistrationRecord;
  state: WorkerState;
  skipWaiting: boolean;
}

interface WorkerVersion extends VersionCore {
  /** The running instance; restartWorker() swaps in a fresh one. */
  scope: ScopeRecord;
}

interface RegistrationRecord {
  readonly scope: string;
  installing: WorkerVersion | null;
  waiting: WorkerVersion | null;
  active: WorkerVersion | null;
  /** The registration's job queue: updates run one after another. */
  jobs: Promise<void>;
}

interface WorkerHandle {
  readonly api: RelayWorker;
  readonly listeners: (() => void)[];
}

interface LogEntry {
  method: string;
  url: string;
  servedBy: "worker" | "network";
}

interface PageRecord {
  readonly id: string;
  readonly url: string;
  readonly secure: boolean;
  readonly serviceWorkers: boolean;
  readonly claimable: boolean;
  open: boolean;
  /** In the back/forward cache: events for it wait until show(). */
  frozen: boolean;
  controller: WorkerVersion | null;
  messagesStarted: boolean;
  readonly messageQueue: RelayMessageEvent[];
  readonly deferred: (() => void)[];
  readonly messageListeners: ((event: RelayMessageEvent) => void)[];
  readonly controllerChangeListeners: (() => void)[];
  readonly pageHideListeners: ((persisted: boolean) => void)[];
  readonly workerHandles: Map<WorkerVersion, WorkerHandle>;
  readonly registrationHandles: Map<RegistrationRecord, RelayRegistration>;
  readonly browserLog: LogEntry[];
  readonly relayedFrames: unknown[];
  readonly client: ClientLike;
  readonly container: RelayContainer | undefined;
}

type Delivery = (data: unknown, ports: readonly MessagePort[]) => void;

function messageType(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const type: unknown = Reflect.get(data, "type");
  return typeof type === "string" ? type : undefined;
}

function readyProtocol(data: unknown): number | undefined {
  if (messageType(data) !== "schmock:ready") return undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const protocol: unknown = Reflect.get(data, "protocol");
  return typeof protocol === "number" ? protocol : undefined;
}

/**
 * A browser reports an exception thrown by an event listener and goes on with
 * the next listener. Here it surfaces as an uncaught error, so the test fails.
 */
function reportListenerError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function invoke<E>(listener: (event: E) => void, event: E): void {
  try {
    listener(event);
  } catch (error) {
    reportListenerError(error);
  }
}

function invokeEach(listeners: readonly (() => void)[]): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      reportListenerError(error);
    }
  }
}

function invalidState(message: string): DOMException {
  return new DOMException(message, "InvalidStateError");
}

function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return (
    reason ?? new DOMException("The user aborted a request.", "AbortError")
  );
}

/** Settles with `promise`, or rejects with the abort reason the moment `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function encodeJson(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function directoryOf(url: string): string {
  return new URL("./", url).href;
}

/** An ExtendableEvent's extend-lifetime promises (waitUntil, and respondWith for a FetchEvent). */
class Lifetime {
  dispatching = true;
  private outstanding = 0;
  private readonly outcomes: Promise<boolean>[] = [];
  private readonly track: (settled: Promise<unknown>) => void;

  constructor(track: (settled: Promise<unknown>) => void) {
    this.track = track;
  }

  /** `tracked` promises are ones flush() waits for. */
  extend(promise: Promise<unknown>, method: string, tracked: boolean): void {
    if (!this.dispatching && this.outstanding === 0) {
      throw invalidState(
        `Failed to execute '${method}': The event handler is already finished and no extend lifetime promises are outstanding.`,
      );
    }
    this.outstanding += 1;
    const outcome = Promise.resolve(promise).then(
      () => true,
      () => false,
    );
    const settled = outcome.then((fulfilled) => {
      this.outstanding -= 1;
      return fulfilled;
    });
    this.outcomes.push(settled);
    if (tracked) this.track(settled);
  }

  /** True when every lifetime promise, including ones added while waiting, fulfilled. */
  async settled(): Promise<boolean> {
    let fulfilled = true;
    let seen = 0;
    while (seen < this.outcomes.length) {
      const batch = this.outcomes.slice(seen);
      seen = this.outcomes.length;
      const results = await Promise.all(batch);
      if (results.includes(false)) fulfilled = false;
    }
    return fulfilled;
  }
}

export function createRelayHarness(settings?: {
  origin?: string;
}): RelayHarness {
  const origin = new URL(settings?.origin ?? DEFAULT_ORIGIN).origin;
  const network = vi.fn(
    async (_request: Request) =>
      new Response("real network", {
        status: 200,
        headers: { "x-from": "network" },
      }),
  );

  const served = new Map<string, ServedScript>();
  let lastServed: ServedScript | undefined;
  let scriptsAvailable = true;
  const registrations = new Map<string, RegistrationRecord>();
  const registerCalls: { url: string; options: unknown }[] = [];
  const pages: PageRecord[] = [];
  let pageCount = 0;
  let latest: WorkerVersion | undefined;
  let disposed = false;

  // ── macrotasks and message delivery ──
  // Everything the fakes deliver crosses a real MessagePort, so it arrives on
  // a later macrotask that vitest fake timers do not touch.

  const tickChannels = new Set<MessageChannel>();
  const deliveredPorts = new Set<MessagePort>();
  const ownedPorts = new Set<MessagePort>();
  const pending = new Set<Promise<unknown>>();
  const deliveries = new Map<number, Delivery>();
  let nextDelivery = 0;

  function track(promise: Promise<unknown>): void {
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
  }

  function tick(): Promise<void> {
    if (disposed) return new Promise<void>(() => {});
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      tickChannels.add(channel);
      channel.port2.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        tickChannels.delete(channel);
        resolve();
      };
      channel.port1.postMessage(null);
    });
  }

  const bus = new MessageChannel();
  bus.port2.onmessage = (event: MessageEvent) => {
    const envelope: unknown = event.data;
    if (typeof envelope !== "object" || envelope === null) return;
    const id: unknown = Reflect.get(envelope, "id");
    const data: unknown = Reflect.get(envelope, "data");
    const ports = [...event.ports];
    for (const port of ports) deliveredPorts.add(port);
    if (typeof id !== "number") return;
    const deliver = deliveries.get(id);
    deliveries.delete(id);
    deliver?.(data, ports);
  };

  /** postMessage semantics: structured clone, transfer (detaching on the sender), delivery on a later macrotask. */
  function post(
    data: unknown,
    transfer: Transferable[],
    deliver: Delivery,
  ): void {
    if (disposed) return;
    const id = nextDelivery;
    nextDelivery += 1;
    bus.port1.postMessage({ id, data }, transfer);
    deliveries.set(id, deliver);
  }

  // ── cache storage ──

  let holds = 0;
  let unheldWaiters: (() => void)[] = [];

  function whenUnheld(): Promise<void> {
    if (holds === 0) return Promise.resolve();
    return new Promise<void>((resolve) => unheldWaiters.push(resolve));
  }

  const cacheStore = new Map<string, CacheLike>();

  function createCache(): CacheLike {
    const entries = new Map<
      string,
      {
        body: ArrayBuffer;
        status: number;
        statusText: string;
        headers: [string, string][];
      }
    >();
    return {
      async match(key) {
        await whenUnheld();
        const entry = entries.get(key);
        if (entry === undefined) return undefined;
        return new Response(entry.body.slice(0), {
          status: entry.status,
          statusText: entry.statusText,
          headers: entry.headers,
        });
      },
      async put(key, response) {
        await whenUnheld();
        const body = await response.arrayBuffer();
        entries.set(key, {
          body,
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
        });
      },
    };
  }

  const caches: FakeCacheStorage = {
    async open(name) {
      await whenUnheld();
      let cache = cacheStore.get(name);
      if (cache === undefined) {
        cache = createCache();
        cacheStore.set(name, cache);
      }
      return cache;
    },
    hold() {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds > 0) return;
        const waiters = unheldWaiters;
        unheldWaiters = [];
        for (const resume of waiters) resume();
      };
    },
  };

  // ── registrations and workers ──

  function matchRegistration(url: string): RegistrationRecord | undefined {
    let best: RegistrationRecord | undefined;
    for (const registration of registrations.values()) {
      if (!url.startsWith(registration.scope)) continue;
      if (best === undefined || registration.scope.length > best.scope.length) {
        best = registration;
      }
    }
    return best;
  }

  function createRegistration(scope: string): RegistrationRecord {
    const registration: RegistrationRecord = {
      scope,
      installing: null,
      waiting: null,
      active: null,
      jobs: Promise.resolve(),
    };
    registrations.set(scope, registration);
    return registration;
  }

  function dropIfEmpty(registration: RegistrationRecord): void {
    if (
      registration.installing === null &&
      registration.waiting === null &&
      registration.active === null &&
      registrations.get(registration.scope) === registration
    ) {
      registrations.delete(registration.scope);
    }
  }

  function liveClients(): ClientLike[] {
    return pages
      .filter((page) => page.open && !page.frozen && page.secure)
      .map((page) => page.client);
  }

  function clientOf(id: string): ClientLike | undefined {
    return pages.find((page) => page.open && page.id === id)?.client;
  }

  function createScope(version: VersionCore): ScopeRecord {
    const installListeners: ((event: ExtendableEventLike) => void)[] = [];
    const activateListeners: ((event: ExtendableEventLike) => void)[] = [];
    const messageListeners: ((event: ExtendableMessageEventLike) => void)[] =
      [];
    const fetchListeners: ((event: FetchEventLike) => void)[] = [];
    const received: { data: unknown; source: string }[] = [];
    const api: FakeWorkerScope = {
      received,
      addEventListener(...args: ScopeListenerArgs) {
        if (args[0] === "message") {
          if (!messageListeners.includes(args[1])) {
            messageListeners.push(args[1]);
          }
        } else if (args[0] === "fetch") {
          if (!fetchListeners.includes(args[1])) fetchListeners.push(args[1]);
        } else {
          const list =
            args[0] === "install" ? installListeners : activateListeners;
          if (!list.includes(args[1])) list.push(args[1]);
        }
      },
      skipWaiting() {
        version.skipWaiting = true;
        const { registration } = version;
        if (registration.waiting === version) {
          track(tryActivate(registration));
        }
        return Promise.resolve();
      },
      clients: {
        claim: () => claim(version),
        get: (id) => Promise.resolve(clientOf(id)),
        matchAll: (_options) => Promise.resolve(liveClients()),
      },
      caches,
      registration: { scope: version.registration.scope },
      fetch: (request) => network(request),
    };
    return {
      api,
      received,
      install: installListeners,
      activate: activateListeners,
      message: messageListeners,
      fetch: fetchListeners,
    };
  }

  function newVersion(
    registration: RegistrationRecord,
    script: { url: string; revision: number; setup: Setup | undefined },
    state: WorkerState,
  ): WorkerVersion {
    const core: VersionCore = {
      scriptURL: script.url,
      revision: script.revision,
      setup: script.setup,
      registration,
      state,
      skipWaiting: false,
    };
    return Object.assign(core, { scope: createScope(core) });
  }

  /** Run the script in a fresh worker version; throws what the script throws. */
  function evaluate(
    registration: RegistrationRecord,
    script: ServedScript,
  ): WorkerVersion {
    const version = newVersion(registration, script, "installing");
    script.setup(version.scope.api);
    latest = version;
    return version;
  }

  function setState(version: WorkerVersion, state: WorkerState): void {
    version.state = state;
    for (const page of pages) {
      const handle = page.workerHandles.get(version);
      if (handle === undefined || !page.open) continue;
      dispatchOrDefer(page, () => invokeEach(handle.listeners));
    }
  }

  /** Spec "Notify Controller Change": the new controller and its event arrive together, on a later task. */
  function changeController(
    page: PageRecord,
    version: WorkerVersion,
  ): Promise<void> {
    return tick().then(() => {
      if (!page.open || page.controller === version) return;
      page.controller = version;
      dispatchOrDefer(page, () => invokeEach(page.controllerChangeListeners));
    });
  }

  async function claim(claimer: VersionCore): Promise<void> {
    const { registration } = claimer;
    const version = registration.active;
    if (
      version === null ||
      version !== claimer ||
      (version.state !== "activating" && version.state !== "activated")
    ) {
      throw invalidState(
        "Failed to execute 'claim' on 'Clients': Only the active worker can claim clients.",
      );
    }
    const claimed = pages.filter(
      (page) =>
        page.open &&
        !page.frozen &&
        page.claimable &&
        page.secure &&
        page.serviceWorkers &&
        page.controller !== version &&
        matchRegistration(page.url) === registration,
    );
    await Promise.all(claimed.map((page) => changeController(page, version)));
  }

  async function dispatchLifecycleEvent(
    version: WorkerVersion,
    type: "install" | "activate",
  ): Promise<boolean> {
    const lifetime = new Lifetime(track);
    const event: ExtendableEventLike = {
      waitUntil: (promise) => lifetime.extend(promise, "waitUntil", true),
    };
    for (const listener of [...version.scope[type]]) invoke(listener, event);
    lifetime.dispatching = false;
    return lifetime.settled();
  }

  async function tryActivate(registration: RegistrationRecord): Promise<void> {
    const waiting = registration.waiting;
    if (waiting === null) return;
    const inUse = pages.some(
      (page) => page.open && page.controller?.registration === registration,
    );
    if (registration.active !== null && inUse && !waiting.skipWaiting) return;
    await activate(registration, waiting);
  }

  async function activate(
    registration: RegistrationRecord,
    version: WorkerVersion,
  ): Promise<void> {
    await tick();
    if (registration.waiting !== version) return;
    const previous = registration.active;
    if (previous !== null) setState(previous, "redundant");
    registration.active = version;
    registration.waiting = null;
    setState(version, "activating");
    // Spec "Activate": every client already using the registration gets the
    // new worker as its controller, before the activate event, claim or not.
    for (const page of pages) {
      if (
        page.open &&
        page.controller !== null &&
        page.controller !== version &&
        page.controller.registration === registration
      ) {
        track(changeController(page, version));
      }
    }
    await tick();
    await dispatchLifecycleEvent(version, "activate");
    await tick();
    if (version.state === "activating") setState(version, "activated");
  }

  /** Install `version`, then activate it when nothing holds it waiting. True when it installed. */
  async function runLifecycle(
    registration: RegistrationRecord,
    version: WorkerVersion,
    forceActivate: boolean,
  ): Promise<boolean> {
    await tick();
    const installed = await dispatchLifecycleEvent(version, "install");
    await tick();
    if (!installed) {
      if (registration.installing === version) registration.installing = null;
      setState(version, "redundant");
      dropIfEmpty(registration);
      return false;
    }
    if (registration.waiting !== null) {
      setState(registration.waiting, "redundant");
    }
    registration.waiting = version;
    registration.installing = null;
    setState(version, "installed");
    if (forceActivate) version.skipWaiting = true;
    await tryActivate(registration);
    return true;
  }

  /**
   * Queue an update of `registration` to `script`. Resolves once the
   * registration has its new installing worker, or at once (no version) for
   * a byte-identical script; `done` settles when the lifecycle ends. Rejects
   * with the script's own error when evaluating it throws.
   */
  function update(
    registration: RegistrationRecord,
    script: ServedScript,
    forceActivate: boolean,
  ): Promise<{ version: WorkerVersion | undefined; done: Promise<boolean> }> {
    return new Promise((resolve, reject) => {
      const job = registration.jobs.then(async () => {
        const newest =
          registration.installing ??
          registration.waiting ??
          registration.active;
        if (
          newest !== null &&
          newest.scriptURL === script.url &&
          newest.revision === script.revision
        ) {
          resolve({ version: undefined, done: Promise.resolve(true) });
          return;
        }
        let version: WorkerVersion;
        try {
          version = evaluate(registration, script);
        } catch (error) {
          dropIfEmpty(registration);
          reject(error);
          return;
        }
        if (registration.installing !== null) {
          setState(registration.installing, "redundant");
        }
        registration.installing = version;
        const done = runLifecycle(registration, version, forceActivate);
        resolve({ version, done });
        await done;
      });
      registration.jobs = job.catch(() => undefined);
      track(job);
    });
  }

  function serve(url: string, setup: Setup): ServedScript {
    const script: ServedScript = {
      url,
      setup,
      revision: (served.get(url)?.revision ?? 0) + 1,
    };
    served.set(url, script);
    lastServed = script;
    return script;
  }

  // ── pages ──

  function dispatchOrDefer(page: PageRecord, run: () => void): void {
    if (page.frozen) page.deferred.push(run);
    else run();
  }

  function pumpMessages(page: PageRecord): void {
    if (!page.open || page.frozen || !page.messagesStarted) return;
    let event = page.messageQueue.shift();
    while (event !== undefined) {
      for (const listener of [...page.messageListeners])
        invoke(listener, event);
      event = page.messageQueue.shift();
    }
  }

  function handleFor(page: PageRecord, version: WorkerVersion): WorkerHandle {
    const existing = page.workerHandles.get(version);
    if (existing !== undefined) return existing;
    const listeners: (() => void)[] = [];
    const api: RelayWorker = {
      scriptURL: version.scriptURL,
      get state() {
        return version.state;
      },
      postMessage(message, transfer) {
        post(message, transfer, (data, ports) => {
          if (version.state === "redundant") return;
          const scope = version.scope;
          scope.received.push({ data, source: page.id });
          const lifetime = new Lifetime(track);
          const event: ExtendableMessageEventLike = {
            data,
            source: page.client,
            ports,
            waitUntil: (promise) => lifetime.extend(promise, "waitUntil", true),
          };
          for (const listener of [...scope.message]) invoke(listener, event);
          lifetime.dispatching = false;
        });
      },
      addEventListener(_type, listener) {
        if (!listeners.includes(listener)) listeners.push(listener);
      },
      removeEventListener(_type, listener) {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
    const handle = { api, listeners };
    page.workerHandles.set(version, handle);
    return handle;
  }

  function registrationHandle(
    page: PageRecord,
    registration: RegistrationRecord,
  ): RelayRegistration {
    const existing = page.registrationHandles.get(registration);
    if (existing !== undefined) return existing;
    const view = (version: WorkerVersion | null) =>
      version === null ? null : handleFor(page, version).api;
    const api: RelayRegistration = {
      scope: registration.scope,
      get installing() {
        return view(registration.installing);
      },
      get waiting() {
        return view(registration.waiting);
      },
      get active() {
        return view(registration.active);
      },
    };
    page.registrationHandles.set(registration, api);
    return api;
  }

  async function register(
    page: PageRecord,
    scriptUrl: string,
    options:
      | { scope?: string; updateViaCache?: "imports" | "all" | "none" }
      | undefined,
  ): Promise<RelayRegistration> {
    registerCalls.push({ url: scriptUrl, options });
    await tick();
    if (!page.secure) {
      throw new DOMException(
        "Failed to register a ServiceWorker: Only secure origins are allowed.",
        "SecurityError",
      );
    }
    const scriptURL = new URL(scriptUrl, page.url).href;
    const scope =
      options?.scope !== undefined
        ? new URL(options.scope, page.url).href
        : directoryOf(scriptURL);
    const prefix = `Failed to register a ServiceWorker for scope ('${scope}') with script ('${scriptURL}'):`;
    if (
      new URL(scriptURL).origin !== origin ||
      new URL(scope).origin !== origin
    ) {
      throw new DOMException(
        `${prefix} The origin of the provided scriptURL or scope does not match the current origin ('${origin}').`,
        "SecurityError",
      );
    }
    const script = served.get(scriptURL);
    if (!scriptsAvailable || script === undefined) {
      throw new TypeError(SCRIPT_NOT_FOUND);
    }
    const maxScope = directoryOf(scriptURL);
    if (!scope.startsWith(maxScope)) {
      throw new DOMException(
        `${prefix} The path of the provided scope ('${new URL(scope).pathname}') is not under the max scope allowed ('${new URL(maxScope).pathname}'). Adjust the scope, move the Service Worker script, or use the Service-Worker-Allowed HTTP header to allow the scope.`,
        "SecurityError",
      );
    }
    const registration = registrations.get(scope) ?? createRegistration(scope);
    try {
      await update(registration, script, false);
    } catch (error) {
      throw new TypeError(`${prefix} ServiceWorker script evaluation failed`, {
        cause: error,
      });
    }
    return registrationHandle(page, registration);
  }

  async function getRegistration(
    page: PageRecord,
    clientUrl: string | undefined,
  ): Promise<RelayRegistration | undefined> {
    await tick();
    const url = new URL(clientUrl ?? page.url, page.url).href;
    if (new URL(url).origin !== origin) {
      throw new DOMException(
        "Failed to execute 'getRegistration' on 'ServiceWorkerContainer': The origin of the provided documentURL does not match the current origin.",
        "SecurityError",
      );
    }
    const registration = matchRegistration(url);
    return registration === undefined
      ? undefined
      : registrationHandle(page, registration);
  }

  function buildRequest(
    page: PageRecord,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    kind: { destination?: string; mode?: RequestMode },
  ): Request {
    const target =
      input instanceof Request
        ? input
        : new URL(input instanceof URL ? input.href : input, page.url).href;
    const options: RequestInit = init ?? {};
    const { mode: requestedMode, ...rest } = options;
    const mode: RequestMode =
      kind.mode ??
      requestedMode ??
      (input instanceof Request ? input.mode : "cors");
    // Node's Request refuses mode "navigate" and has no destination: both
    // become own properties, which is what the worker reads.
    const request = new Request(
      target,
      mode === "navigate" ? rest : { ...rest, mode },
    );
    Object.defineProperty(request, "mode", { value: mode, enumerable: true });
    Object.defineProperty(request, "destination", {
      value: kind.destination ?? "",
      enumerable: true,
    });
    return request;
  }

  function dispatchFetch(
    scope: ScopeRecord,
    request: Request,
    clientId: string,
  ): Promise<Response> | undefined {
    const lifetime = new Lifetime(track);
    const state: { responded: Promise<Response> | undefined } = {
      responded: undefined,
    };
    const event: FetchEventLike = {
      request,
      clientId,
      respondWith(response) {
        if (!lifetime.dispatching) {
          throw invalidState(
            "Failed to execute 'respondWith' on 'FetchEvent': The event handler is already finished.",
          );
        }
        if (state.responded !== undefined) {
          throw invalidState(
            "Failed to execute 'respondWith' on 'FetchEvent': The event has already been responded to.",
          );
        }
        const responded = Promise.resolve(response);
        state.responded = responded;
        lifetime.extend(responded, "respondWith", false);
      },
      waitUntil: (promise) => lifetime.extend(promise, "waitUntil", true),
    };
    for (const listener of [...scope.fetch]) {
      // respondWith stops propagation to the remaining listeners.
      if (state.responded !== undefined) break;
      invoke(listener, event);
    }
    lifetime.dispatching = false;
    return state.responded;
  }

  async function serveFromWorker(
    responded: Promise<Response>,
  ): Promise<Response> {
    let response: unknown;
    try {
      response = await responded;
    } catch {
      throw new TypeError("Failed to fetch");
    }
    if (!(response instanceof Response) || response.type === "error") {
      throw new TypeError("Failed to fetch");
    }
    return response;
  }

  async function routeBrowserRequest(
    page: PageRecord,
    request: Request,
    dispatched: () => void,
  ): Promise<Response> {
    await tick();
    const navigation = request.mode === "navigate";
    let version: WorkerVersion | null = null;
    if (page.serviceWorkers && page.secure) {
      // A navigation goes to the registration of its target URL; a
      // subresource request goes to the page's controller.
      version = navigation
        ? (matchRegistration(request.url)?.active ?? null)
        : page.controller;
    }
    const responded =
      version !== null && version.scope.fetch.length > 0
        ? dispatchFetch(version.scope, request, navigation ? "" : page.id)
        : undefined;
    dispatched();
    if (responded !== undefined) {
      const response = await serveFromWorker(responded);
      page.browserLog.push({
        method: request.method,
        url: request.url,
        servedBy: "worker",
      });
      return response;
    }
    const response = await network(request);
    page.browserLog.push({
      method: request.method,
      url: request.url,
      servedBy: "network",
    });
    return response;
  }

  function browserRequest(
    page: PageRecord,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    kind: { destination?: string; mode?: RequestMode },
  ): Promise<Response> {
    let request: Request;
    try {
      request = buildRequest(page, input, init, kind);
    } catch (error) {
      return Promise.reject(error);
    }
    const { signal } = request;
    if (signal.aborted) return Promise.reject(abortReason(signal));
    let markDispatched = () => {};
    track(
      new Promise<void>((resolve) => {
        markDispatched = resolve;
      }),
    );
    return raceAbort(
      routeBrowserRequest(page, request, markDispatched),
      signal,
    );
  }

  async function helloFromStubTab(
    page: PageRecord,
    version: WorkerVersion,
    protocol: number,
  ): Promise<number | undefined> {
    const channel = new MessageChannel();
    ownedPorts.add(channel.port1);
    const reply = new Promise<unknown>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent) => {
        const data: unknown = event.data;
        resolve(data);
      };
    });
    const hello: HelloMessage = {
      type: "schmock:hello",
      protocol,
      version: "relay-harness",
    };
    handleFor(page, version).api.postMessage(hello, [channel.port2]);
    const noReply = flush()
      .then(() => tick())
      .then(() => undefined);
    const data = await Promise.race([reply, noReply]);
    channel.port1.close();
    ownedPorts.delete(channel.port1);
    return readyProtocol(data);
  }

  async function respondToRelaysWith(
    page: PageRecord,
    body: unknown,
  ): Promise<void> {
    const { container } = page;
    const controller = page.controller;
    if (container === undefined || controller === null) {
      throw new Error(
        `respondToRelaysWith needs a page a service worker controls; ${page.url} is not controlled`,
      );
    }
    const encoded = encodeJson(body);
    container.addEventListener("message", (event) => {
      if (messageType(event.data) !== "schmock:request") return;
      const [port] = event.ports;
      if (port === undefined) return;
      const bytes = encoded.slice(0);
      const reply: RelayReply = {
        type: "schmock:response",
        response: {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/json"]],
          body: bytes,
        },
      };
      port.postMessage(reply, [bytes]);
      port.close();
    });
    container.startMessages();
    let protocol = STUB_TAB_FIRST_PROTOCOL;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const offered = await helloFromStubTab(page, controller, protocol);
      if (offered === protocol) return;
      if (offered === undefined) {
        throw new Error(
          `the service worker ${controller.scriptURL} did not answer the stub tab's hello`,
        );
      }
      protocol = offered;
    }
    throw new Error(
      `the service worker ${controller.scriptURL} would not register the stub tab`,
    );
  }

  function createPage(options: {
    path?: string;
    controlled?: boolean;
    secure?: boolean;
    serviceWorkers?: boolean;
    claimable?: boolean;
  }): FakePage {
    pageCount += 1;
    const id = `client-${pageCount}`;
    const url = new URL(options.path ?? DEFAULT_PAGE_PATH, origin).href;
    const secure = options.secure ?? true;
    const serviceWorkers = options.serviceWorkers ?? true;
    const messageListeners: ((event: RelayMessageEvent) => void)[] = [];
    const controllerChangeListeners: (() => void)[] = [];

    const record: PageRecord = {
      id,
      url,
      secure,
      serviceWorkers,
      claimable: options.claimable ?? true,
      open: true,
      frozen: false,
      controller: null,
      messagesStarted: false,
      messageQueue: [],
      deferred: [],
      messageListeners,
      controllerChangeListeners,
      pageHideListeners: [],
      workerHandles: new Map(),
      registrationHandles: new Map(),
      browserLog: [],
      relayedFrames: [],
      client: {
        id,
        postMessage(message, transfer) {
          post(message, transfer, (data, ports) => {
            if (!record.open) return;
            if (messageType(data) === "schmock:request") {
              record.relayedFrames.push(data);
            }
            record.messageQueue.push({ data, ports });
            pumpMessages(record);
          });
        },
      },
      container: serviceWorkers
        ? {
            get controller() {
              return record.controller === null
                ? null
                : handleFor(record, record.controller).api;
            },
            register: (scriptUrl, registerOptions) =>
              register(record, scriptUrl, registerOptions),
            getRegistration: (clientUrl) => getRegistration(record, clientUrl),
            startMessages() {
              if (record.messagesStarted) return;
              record.messagesStarted = true;
              track(tick().then(() => pumpMessages(record)));
            },
            addEventListener(...args: ContainerListenerArgs) {
              if (args[0] === "message") {
                if (!messageListeners.includes(args[1])) {
                  messageListeners.push(args[1]);
                }
              } else if (!controllerChangeListeners.includes(args[1])) {
                controllerChangeListeners.push(args[1]);
              }
            },
            removeEventListener(...args: ContainerListenerArgs) {
              const list: unknown[] =
                args[0] === "message"
                  ? messageListeners
                  : controllerChangeListeners;
              const index = list.indexOf(args[1]);
              if (index >= 0) list.splice(index, 1);
            },
          }
        : undefined,
    };
    pages.push(record);

    if (serviceWorkers && secure && options.controlled !== false) {
      record.controller = matchRegistration(url)?.active ?? null;
    }

    const environment: RelayEnvironment = {
      container: record.container,
      secureContext: secure,
      baseUrl: url,
      pageUrl: url,
      onPageHide(listener) {
        record.pageHideListeners.push(listener);
        return () => {
          const index = record.pageHideListeners.indexOf(listener);
          if (index >= 0) record.pageHideListeners.splice(index, 1);
        };
      },
    };

    return {
      id,
      environment,
      networkFetch: (input, requestInit) =>
        browserRequest(record, input, requestInit, { destination: "" }),
      xhr: (target, requestInit) =>
        browserRequest(record, target, requestInit, { destination: "" }),
      load: (target, kind) => browserRequest(record, target, undefined, kind),
      browserLog: record.browserLog,
      relayedFrames: record.relayedFrames,
      hide(persisted) {
        for (const listener of [...record.pageHideListeners]) {
          invoke(listener, persisted);
        }
        if (persisted) record.frozen = true;
      },
      show() {
        if (!record.frozen) return;
        record.frozen = false;
        track(
          tick().then(() => {
            for (const run of record.deferred.splice(0)) run();
            pumpMessages(record);
          }),
        );
      },
      close() {
        record.open = false;
        record.frozen = false;
        record.messageQueue.length = 0;
        record.deferred.length = 0;
      },
      respondToRelaysWith: (body) => respondToRelaysWith(record, body),
    };
  }

  /**
   * Quiet means: no harness delivery in flight and no waitUntil, lifecycle
   * step or fetch dispatch pending, for three macrotasks in a row. The extra
   * rounds let messages on the relay's own ports land too.
   */
  async function flush(): Promise<void> {
    let quietRounds = 0;
    while (!disposed && quietRounds < 3) {
      await tick();
      if (deliveries.size > 0 || pending.size > 0) {
        quietRounds = 0;
        await Promise.all([...pending]);
      } else {
        quietRounds += 1;
      }
    }
  }

  // ── the harness ──

  const harness: RelayHarness = {
    origin,
    get worker() {
      if (latest === undefined) {
        throw new Error(
          "No Schmock worker has started yet: register, activateWorker() or replaceWorker() one first",
        );
      }
      return latest.scope.api;
    },
    network,
    caches,
    registerCalls,
    get registrations() {
      return [...registrations.values()].flatMap((registration) => {
        const newest =
          registration.installing ??
          registration.waiting ??
          registration.active;
        return newest === null
          ? []
          : [{ scope: registration.scope, scriptURL: newest.scriptURL }];
      });
    },
    installWorker(setup, scriptURL) {
      serve(new URL(scriptURL ?? DEFAULT_SCRIPT_PATH, origin).href, setup);
    },
    async activateWorker(scope) {
      const script = lastServed;
      if (script === undefined) {
        throw new Error("activateWorker() needs installWorker() first");
      }
      const scopeURL =
        scope !== undefined
          ? new URL(scope, origin).href
          : directoryOf(script.url);
      const registration =
        registrations.get(scopeURL) ?? createRegistration(scopeURL);
      const { done } = await update(registration, script, true);
      if (!(await done)) {
        throw new Error(`The worker at ${script.url} failed to install`);
      }
    },
    restartWorker() {
      const version = latest;
      if (version === undefined || version.setup === undefined) {
        throw new Error("restartWorker() needs a running Schmock worker");
      }
      if (version.state === "redundant") {
        throw new Error("restartWorker(): the newest worker is redundant");
      }
      version.scope = createScope(version);
      version.setup(version.scope.api);
    },
    async replaceWorker(setup, scriptURL) {
      const current = latest;
      if (current === undefined) {
        throw new Error("replaceWorker() needs a registered Schmock worker");
      }
      const url =
        scriptURL !== undefined
          ? new URL(scriptURL, origin).href
          : current.scriptURL;
      const nextSetup = setup ?? served.get(url)?.setup ?? current.setup;
      if (nextSetup === undefined) {
        throw new Error(`replaceWorker(): nothing is served at ${url}`);
      }
      const script = serve(url, nextSetup);
      const { done } = await update(current.registration, script, true);
      if (!(await done)) {
        throw new Error(`The new worker version at ${url} failed to install`);
      }
    },
    openPage: (options) => createPage(options ?? {}),
    seedForeignRegistration(scriptURL, scope) {
      const scopeURL = new URL(scope ?? "/", origin).href;
      if (registrations.has(scopeURL)) {
        throw new Error(`A registration already exists at ${scopeURL}`);
      }
      const registration = createRegistration(scopeURL);
      registration.active = newVersion(
        registration,
        {
          url: new URL(scriptURL, origin).href,
          revision: -1,
          setup: undefined,
        },
        "activated",
      );
    },
    serveScript(available) {
      scriptsAvailable = available;
    },
    flush,
    dispose() {
      disposed = true;
      bus.port1.close();
      bus.port2.close();
      for (const channel of tickChannels) {
        channel.port1.close();
        channel.port2.close();
      }
      tickChannels.clear();
      for (const port of [...deliveredPorts, ...ownedPorts]) port.close();
      deliveredPorts.clear();
      ownedPorts.clear();
      deliveries.clear();
      pending.clear();
    },
  };

  return harness;
}
