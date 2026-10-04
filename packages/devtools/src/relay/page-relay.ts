import { SchmockError } from "@schmock/core";
import {
  acquireFetchRelay,
  type FetchRelay,
  routeRelayedRequest,
} from "@schmock/core/adapter";
import { invalidOption } from "../invalid-option.js";
import type {
  RelayFallbackReason,
  ServiceWorkerRelay,
  ServiceWorkerRelayOptions,
} from "../types.js";
import {
  ask,
  DEFAULT_WORKER_URL,
  deserializeRequest,
  isAbortRequestMessage,
  isReadyMessage,
  isRequestMessage,
  RELAY_PROTOCOL_VERSION,
  RELAY_VERSION,
  serializeResponse,
  transferablesOf,
} from "./protocol.js";
import type {
  RelayContainer,
  RelayEnvironment,
  RelayMessageEvent,
  RelayRegistration,
  RelayReply,
  RelayWorker,
} from "./types.js";

const DEFAULT_TIMEOUT = 5000;
const INIT_HINT = 'Run "npx schmock-devtools init <publicDir>"';

interface ResolvedOptions {
  url: string;
  scope: string | undefined;
  timeout: number;
}

type RelayState =
  | "starting"
  | "live"
  | "rehandshaking"
  | "fallen-back"
  | "stopped";

type Stage = "setup" | "controlling" | "handshaking";

const relaySlots = new WeakMap<
  RelayContainer,
  { key: ResolvedOptions; promise: Promise<ServiceWorkerRelay>; relay: object }
>();
const listeningContainers = new WeakSet<RelayContainer>();

function invalidRelayOption(
  option: string,
  requirement: string,
  value: unknown,
): SchmockError {
  return invalidOption("startServiceWorkerRelay", option, requirement, value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function resolveOptions(
  options: unknown,
  baseUrl: string,
): { options: ServiceWorkerRelayOptions; resolved: ResolvedOptions } {
  if (
    options !== undefined &&
    (typeof options !== "object" || options === null || Array.isArray(options))
  ) {
    throw invalidRelayOption("options", "an object", options);
  }
  const url: unknown =
    options === undefined ? undefined : Reflect.get(options, "url");
  const scope: unknown =
    options === undefined ? undefined : Reflect.get(options, "scope");
  const timeout: unknown =
    options === undefined ? undefined : Reflect.get(options, "timeout");
  if (url !== undefined && !isNonEmptyString(url)) {
    throw invalidRelayOption("url", "a non-empty string", url);
  }
  if (scope !== undefined && !isNonEmptyString(scope)) {
    throw invalidRelayOption("scope", "a non-empty string", scope);
  }
  if (
    timeout !== undefined &&
    !(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)
  ) {
    throw invalidRelayOption("timeout", "a positive finite number", timeout);
  }
  let resolvedUrl: string;
  try {
    resolvedUrl = new URL(url ?? DEFAULT_WORKER_URL, baseUrl).href;
  } catch {
    throw invalidRelayOption(
      "url",
      "a URL that resolves against the page URL",
      url ?? DEFAULT_WORKER_URL,
    );
  }
  let resolvedScope: string | undefined;
  if (scope !== undefined) {
    try {
      resolvedScope = new URL(scope, baseUrl).href;
    } catch {
      throw invalidRelayOption(
        "scope",
        "a URL that resolves against the page URL",
        scope,
      );
    }
  }
  const clean: ServiceWorkerRelayOptions = {};
  if (url !== undefined) clean.url = url;
  if (scope !== undefined) clean.scope = scope;
  return {
    options: clean,
    resolved: {
      url: resolvedUrl,
      scope: resolvedScope,
      timeout: timeout ?? DEFAULT_TIMEOUT,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameHttpOrigin(pageUrl: string, scope: string): boolean {
  try {
    const page = new URL(pageUrl);
    return (
      (page.protocol === "http:" || page.protocol === "https:") &&
      page.origin === new URL(scope).origin
    );
  } catch {
    return false;
  }
}

function sameKey(a: ResolvedOptions, b: ResolvedOptions): boolean {
  return a.url === b.url && a.scope === b.scope && a.timeout === b.timeout;
}

function fallbackRelay(reason: RelayFallbackReason): ServiceWorkerRelay {
  let fallbackReason: RelayFallbackReason | undefined = reason;
  return {
    active: false,
    get fallbackReason() {
      return fallbackReason;
    },
    stop: () => {
      fallbackReason = undefined;
      return Promise.resolve();
    },
  };
}

/** One per container; routes every worker frame through core, whatever the relay state. */
function handleFrame(event: RelayMessageEvent): void {
  const frame = event.data;
  const port = event.ports[0];
  if (!isRequestMessage(frame) || port === undefined) return;
  const controller = new AbortController();
  port.onmessage = (message) => {
    if (isAbortRequestMessage(message.data)) controller.abort();
  };
  void (async () => {
    let reply: RelayReply;
    let transfer: Transferable[] = [];
    try {
      const answer = await routeRelayedRequest(
        deserializeRequest(frame.request, controller.signal),
      );
      if (answer === undefined) {
        reply = { type: "schmock:passthrough" };
      } else {
        const response = await serializeResponse(answer);
        reply = { type: "schmock:response", response };
        transfer = transferablesOf(response);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        reply = { type: "schmock:aborted" };
      } else {
        // The URL is an argument, never part of the format string: a "%c"
        // in it would swallow the error.
        console.error(
          "Schmock relay: %s %s failed in the mock, so the page receives a network error.",
          frame.request.method,
          frame.request.url,
          error,
        );
        reply = {
          type: "schmock:error",
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: errorMessage(error),
          },
        };
      }
    }
    try {
      port.postMessage(reply, transfer);
    } finally {
      port.close();
    }
  })().catch(() => {});
}

type Waited<T> = { done: true; value: T } | { done: false };

export function createServiceWorkerRelay(
  environment: RelayEnvironment,
  options?: ServiceWorkerRelayOptions,
): Promise<ServiceWorkerRelay> {
  let key: ResolvedOptions;
  let rawOptions: ServiceWorkerRelayOptions;
  try {
    const result = resolveOptions(options, environment.baseUrl);
    key = result.resolved;
    rawOptions = result.options;
  } catch (error) {
    return Promise.reject(error);
  }
  const container = environment.container;
  if (container === undefined) {
    console.warn(
      "Schmock relay: service workers are unavailable here, so mocked requests stay in the page and do not appear in the Network panel.",
    );
    return Promise.resolve(fallbackRelay("unsupported"));
  }
  if (!environment.secureContext) {
    console.warn(
      "Schmock relay: service workers need a secure context (https or localhost), so mocked requests stay in the page.",
    );
    return Promise.resolve(fallbackRelay("insecure-context"));
  }
  const existing = relaySlots.get(container);
  if (existing !== undefined) {
    if (sameKey(existing.key, key)) return existing.promise;
    return Promise.reject(
      new SchmockError(
        `startServiceWorkerRelay: a relay is already running on this page with ${JSON.stringify(existing.key)}; stop() it before starting one with ${JSON.stringify(key)}.`,
        "DEVTOOLS_RELAY_ALREADY_STARTED",
        { running: existing.key, requested: key },
      ),
    );
  }

  const resolvedUrl = key.url;
  const timeout = key.timeout;
  let state: RelayState = "starting";
  let reason: RelayFallbackReason | undefined;
  let stage: Stage = "setup";
  let hold: FetchRelay | undefined;
  let unsubscribePageHide: (() => void) | undefined;
  let helloCancel: AbortController | undefined;
  let tornDown = false;
  let deadlineAt = performance.now() + timeout;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let stateCleanup: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  const changeWaiters = new Set<() => void>();
  let resolveStart: (relay: ServiceWorkerRelay) => void = () => {};
  let resolveTerminated: () => void = () => {};
  let resolveDeadline: () => void = () => {};
  const terminated = new Promise<void>((resolve) => {
    resolveTerminated = resolve;
  });
  const deadline = new Promise<void>((resolve) => {
    resolveDeadline = resolve;
  });
  deadlineTimer = setTimeout(() => resolveDeadline(), timeout);

  const relay: ServiceWorkerRelay = {
    get active() {
      return state === "live";
    },
    get fallbackReason() {
      return state === "fallen-back" ? reason : undefined;
    },
    stop: () => {
      stopPromise ??= stop();
      return stopPromise;
    },
  };
  const promise = new Promise<ServiceWorkerRelay>((resolve) => {
    resolveStart = resolve;
  });
  relaySlots.set(container, { key, promise, relay });

  const releaseHold = () => {
    hold?.release();
    hold = undefined;
  };

  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    container.removeEventListener("controllerchange", onControllerChange);
    stateCleanup?.();
    unsubscribePageHide?.();
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    helloCancel?.abort();
    releaseHold();
    if (relaySlots.get(container)?.relay === relay) {
      relaySlots.delete(container);
    }
    resolveTerminated();
  };

  const fallback = (why: RelayFallbackReason, text: string) => {
    if (state === "fallen-back" || state === "stopped") return;
    console.warn(text);
    state = "fallen-back";
    reason = why;
    teardown();
    resolveStart(relay);
  };

  const registrationFailed = (message: string) => {
    fallback(
      "registration-failed",
      `Schmock relay: could not register ${resolvedUrl} (${message}). ${INIT_HINT} and serve the file at ${resolvedUrl}.`,
    );
  };

  const notControlled = () => {
    const controller = container.controller;
    fallback(
      "not-controlled",
      controller === null
        ? "Schmock relay: this page is not controlled by the Schmock service worker (a hard reload bypasses service workers); reload normally."
        : `Schmock relay: this page is controlled by ${controller.scriptURL}, which Schmock will not replace. Unregister it while developing, or give Schmock a scope that covers this page.`,
    );
  };

  const timedOut = () => {
    fallback(
      "timeout",
      `Schmock relay: the service worker did not get ready within ${timeout} ms, so mocked requests stay in the page.`,
    );
  };

  const alive = () => state === "starting" || state === "rehandshaking";

  /** Races a wait against the start deadline and teardown. */
  const waitFor = async <T>(value: Promise<T>): Promise<Waited<T>> => {
    const outcome = await Promise.race([
      value.then((v): Waited<T> => ({ done: true, value: v })),
      deadline.then((): Waited<T> => ({ done: false })),
      terminated.then((): Waited<T> => ({ done: false })),
    ]);
    return outcome;
  };

  const onDeadline = () => {
    if (!alive()) return;
    if (stage === "controlling") notControlled();
    else timedOut();
  };

  const onControllerChange = () => {
    if (state === "live") {
      releaseHold();
      state = "rehandshaking";
      deadlineAt = performance.now() + timeout;
      void rehandshake();
      return;
    }
    if (state === "starting" || state === "rehandshaking") {
      helloCancel?.abort();
      for (const wake of [...changeWaiters]) wake();
    }
  };

  const onPageHide = (persisted: boolean) => {
    if (persisted) return;
    if (state !== "live" && state !== "rehandshaking") return;
    state = "stopped";
    releaseHold();
    helloCancel?.abort();
    if (container.controller?.scriptURL === resolvedUrl) {
      container.controller.postMessage({ type: "schmock:goodbye" }, []);
    }
    teardown();
  };

  /** "ok" once the controller said ready; "changed" when the controller moved; "gone" when torn down; else it already fell back. */
  const handshake = async (): Promise<"ok" | "changed" | "gone" | "failed"> => {
    const target = container.controller;
    if (target === null) {
      notControlled();
      return "failed";
    }
    const cancel = new AbortController();
    helloCancel = cancel;
    let reply: unknown;
    try {
      reply = await ask(
        target,
        {
          type: "schmock:hello",
          protocol: RELAY_PROTOCOL_VERSION,
          version: RELAY_VERSION,
        },
        {
          timeoutMs: Math.max(0, deadlineAt - performance.now()),
          cancelSignal: cancel.signal,
        },
      );
    } catch {
      reply = undefined;
    }
    if (helloCancel === cancel) helloCancel = undefined;
    if (!alive()) return "gone";
    if (cancel.signal.aborted) return "changed";
    if (!isReadyMessage(reply)) {
      // The hello may still land after the deadline, so take it back: the
      // worker must not relay a page whose relay reports itself inactive.
      target.postMessage({ type: "schmock:goodbye" }, []);
      timedOut();
      return "failed";
    }
    if (reply.protocol !== RELAY_PROTOCOL_VERSION) {
      target.postMessage({ type: "schmock:goodbye" }, []);
      fallback(
        "protocol-mismatch",
        `Schmock relay: ${resolvedUrl} speaks relay protocol ${reply.protocol}, this page expects ${RELAY_PROTOCOL_VERSION}. ${INIT_HINT} again.`,
      );
      return "failed";
    }
    if (reply.version !== RELAY_VERSION) {
      console.warn(
        `Schmock relay: ${resolvedUrl} comes from @schmock/devtools ${reply.version}, this page uses ${RELAY_VERSION}. ${INIT_HINT} to update it.`,
      );
    }
    return "ok";
  };

  const rehandshake = async () => {
    try {
      for (;;) {
        const controller = container.controller;
        if (controller === null || controller.scriptURL !== resolvedUrl) {
          notControlled();
          return;
        }
        const result = await handshake();
        if (result === "changed") continue;
        if (result === "ok" && state === "rehandshaking") {
          hold = acquireFetchRelay();
          state = "live";
        }
        return;
      }
    } catch (error) {
      registrationFailed(errorMessage(error));
    }
  };

  const goLive = () => {
    if (state !== "starting") return;
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    hold = acquireFetchRelay();
    unsubscribePageHide = environment.onPageHide(onPageHide);
    state = "live";
    resolveStart(relay);
  };

  const stop = async (): Promise<void> => {
    if (state === "starting") await promise;
    if (state !== "live" && state !== "rehandshaking") {
      if (state === "fallen-back") state = "stopped";
      return;
    }
    state = "stopped";
    releaseHold();
    if (relaySlots.get(container)?.relay === relay) {
      relaySlots.delete(container);
    }
    helloCancel?.abort();
    const controller = container.controller;
    if (controller?.scriptURL === resolvedUrl) {
      try {
        await ask(
          controller,
          { type: "schmock:goodbye" },
          { timeoutMs: timeout },
        );
      } catch {
        // the worker is gone; nothing to acknowledge
      }
    }
    teardown();
  };

  const start = async (): Promise<void> => {
    if (!listeningContainers.has(container)) {
      container.addEventListener("message", handleFrame);
      listeningContainers.add(container);
      container.startMessages();
    }
    container.addEventListener("controllerchange", onControllerChange);

    // Scope check.
    const intendedScope = key.scope ?? new URL("./", resolvedUrl).href;
    let found: RelayRegistration | undefined;
    try {
      const looked = await waitFor(container.getRegistration(intendedScope));
      if (!looked.done) return onDeadline();
      found = looked.value;
    } catch (error) {
      return registrationFailed(errorMessage(error));
    }
    if (found !== undefined && found.scope === intendedScope) {
      const worker = found.active ?? found.waiting ?? found.installing;
      if (worker !== null && worker.scriptURL !== resolvedUrl) {
        return fallback(
          "scope-taken",
          `Schmock relay: ${worker.scriptURL} already controls this scope; Schmock will not replace it. Unregister it while developing, or give Schmock its own scope.`,
        );
      }
    }

    // A worker controls only the pages under its scope: no point registering.
    // Only an http(s) page on the scope's origin is checked; a srcdoc, blob or
    // about:blank document can still inherit control from its parent.
    const pageUrl = environment.pageUrl ?? environment.baseUrl;
    const ours = container.controller?.scriptURL === resolvedUrl;
    if (
      !ours &&
      sameHttpOrigin(pageUrl, intendedScope) &&
      !pageUrl.startsWith(intendedScope)
    ) {
      return fallback(
        "not-controlled",
        `Schmock relay: ${resolvedUrl} can only control pages under ${intendedScope}, and this page is ${pageUrl}. Serve the script at or above this page, or pass a scope that covers it.`,
      );
    }

    // Register.
    let registration: RelayRegistration;
    try {
      const registered = await waitFor(
        container.register(
          rawOptions.url ?? DEFAULT_WORKER_URL,
          rawOptions.scope !== undefined
            ? { scope: rawOptions.scope, updateViaCache: "none" }
            : { updateViaCache: "none" },
        ),
      );
      if (!registered.done) return onDeadline();
      registration = registered.value;
    } catch (error) {
      return registrationFailed(errorMessage(error));
    }

    // Activation.
    for (;;) {
      if (registration.active?.state === "activated") break;
      const workers: RelayWorker[] = [];
      for (const w of [
        registration.installing,
        registration.waiting,
        registration.active,
      ]) {
        if (w !== null) workers.push(w);
      }
      if (workers.every((w) => w.state === "redundant")) {
        return registrationFailed("the worker failed to install");
      }
      let wake: () => void = () => {};
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      for (const w of workers) w.addEventListener("statechange", wake);
      const cleanup = () => {
        for (const w of workers) w.removeEventListener("statechange", wake);
        if (stateCleanup === cleanup) stateCleanup = undefined;
      };
      stateCleanup = cleanup;
      const result = await waitFor(changed);
      cleanup();
      if (!result.done) return onDeadline();
    }

    // Control, then handshake.
    for (;;) {
      stage = "controlling";
      if (container.controller?.scriptURL !== resolvedUrl) {
        registration.active?.postMessage({ type: "schmock:claim" }, []);
        while (container.controller?.scriptURL !== resolvedUrl) {
          let wake: () => void = () => {};
          const changed = new Promise<void>((resolve) => {
            wake = resolve;
          });
          changeWaiters.add(wake);
          const result = await waitFor(changed);
          changeWaiters.delete(wake);
          if (!result.done) return onDeadline();
        }
      }
      stage = "handshaking";
      const result = await handshake();
      if (result === "changed") continue;
      if (result === "ok") goLive();
      return;
    }
  };

  start().catch((error) => registrationFailed(errorMessage(error)));
  return promise;
}

export function startServiceWorkerRelay(
  options?: ServiceWorkerRelayOptions,
): Promise<ServiceWorkerRelay> {
  let serviceWorker: RelayContainer | undefined;
  try {
    serviceWorker = globalThis.navigator?.serviceWorker ?? undefined;
  } catch {
    // A sandboxed document without allow-same-origin throws a SecurityError.
    serviceWorker = undefined;
  }
  const environment: RelayEnvironment = {
    container: serviceWorker,
    secureContext: globalThis.isSecureContext === true,
    baseUrl: pageBaseUrl(),
    pageUrl: documentCreationUrl(),
    onPageHide(listener) {
      if (typeof globalThis.addEventListener !== "function") return () => {};
      const handler = (event: Event) =>
        listener(Reflect.get(event, "persisted") === true);
      globalThis.addEventListener("pagehide", handler);
      return () => globalThis.removeEventListener("pagehide", handler);
    },
  };
  return createServiceWorkerRelay(environment, options);
}

/**
 * The URL the document was created at, which is what a worker's scope must
 * cover: the navigation entry keeps it after history.pushState() moves
 * location.href.
 */
function documentCreationUrl(): string | undefined {
  try {
    const [navigation] =
      globalThis.performance?.getEntriesByType?.("navigation") ?? [];
    if (navigation !== undefined && isNonEmptyString(navigation.name)) {
      return navigation.name;
    }
  } catch {
    // no navigation timing here
  }
  if (typeof location !== "undefined" && typeof location.href === "string") {
    return location.href;
  }
  return undefined;
}

function pageBaseUrl(): string {
  if (typeof document !== "undefined" && isNonEmptyString(document.baseURI)) {
    return document.baseURI;
  }
  if (typeof location !== "undefined" && typeof location.href === "string") {
    return location.href;
  }
  return "http://localhost/";
}
