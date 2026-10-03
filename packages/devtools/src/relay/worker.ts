import { ClientRegistry } from "./client-registry.js";
import {
  ask,
  deserializeResponse,
  isPageToWorkerMessage,
  isRelayReply,
  REGISTRY_KEY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_REGISTRY_CACHE,
  RELAY_VERSION,
  serializeRequest,
  transferablesOf,
} from "./protocol.js";
import type {
  ExtendableMessageEventLike,
  FetchEventLike,
  RelayWorkerScope,
} from "./types.js";

/**
 * Whether a request may be relayed to its page: sub-resource fetches the page
 * itself made (fetch/XHR), never navigations, loads with a destination, or
 * cross-mode only-if-cached requests.
 */
export function isRelayCandidate(request: Request, clientId: string): boolean {
  return (
    clientId !== "" &&
    request.mode !== "navigate" &&
    request.destination === "" &&
    !(request.cache === "only-if-cached" && request.mode !== "same-origin")
  );
}

/** Installs the relay listeners on a worker scope. Called once per worker start. */
export function installRelayWorker(scope: RelayWorkerScope): void {
  const registry = new ClientRegistry(
    scope.caches,
    RELAY_REGISTRY_CACHE,
    new URL(REGISTRY_KEY_PATH, scope.registration.scope).href,
  );

  async function relay(event: FetchEventLike): Promise<Response> {
    try {
      const client = await scope.clients.get(event.clientId);
      // A client the Clients API cannot find may be in the back/forward
      // cache and still relaying, so it is not forgotten here; activate
      // prunes the registry.
      if (client === undefined) return await scope.fetch(event.request);
      const serialized = await serializeRequest(event.request.clone());
      const reply = await ask(
        client,
        { type: "schmock:request" as const, request: serialized },
        {
          transfer: transferablesOf(serialized),
          abortSignal: event.request.signal,
        },
      );
      if (isRelayReply(reply)) {
        if (reply.type === "schmock:response") {
          return deserializeResponse(reply.response);
        }
        if (reply.type === "schmock:passthrough") {
          return await scope.fetch(event.request);
        }
      }
      return Response.error();
    } catch {
      return Response.error();
    }
  }

  async function handle(event: ExtendableMessageEventLike): Promise<void> {
    const source = event.source;
    if (
      source === null ||
      typeof source !== "object" ||
      typeof Reflect.get(source, "id") !== "string"
    ) {
      return;
    }
    const data = event.data;
    if (!isPageToWorkerMessage(data)) return;
    const port = event.ports[0];
    if (data.type === "schmock:hello") {
      if (data.protocol === RELAY_PROTOCOL_VERSION) {
        await registry.add(source.id);
      }
      if (port !== undefined) {
        port.postMessage({
          type: "schmock:ready",
          protocol: RELAY_PROTOCOL_VERSION,
          version: RELAY_VERSION,
        });
        port.close();
      }
    } else if (data.type === "schmock:goodbye") {
      await registry.delete(source.id);
      if (port !== undefined) {
        port.postMessage({ type: "schmock:released" });
        port.close();
      }
    } else {
      await scope.clients.claim();
    }
  }

  scope.addEventListener("install", (event) => {
    event.waitUntil(scope.skipWaiting());
  });

  // Never prune on worker start: clients.matchAll() omits back/forward-cached
  // pages, so a startup prune after an idle restart would forget a relaying
  // page in the bfcache. Activation is safe because Chrome evicts bfcached
  // pages when a version activates.
  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        await scope.clients.claim();
        const live = await scope.clients.matchAll({
          includeUncontrolled: true,
          type: "all",
        });
        await registry.retain(live.map((client) => client.id));
      })(),
    );
  });

  scope.addEventListener("message", (event) => {
    event.waitUntil(handle(event));
  });

  scope.addEventListener("fetch", (event) => {
    if (!isRelayCandidate(event.request, event.clientId)) return;
    if (registry.loaded) {
      if (!registry.has(event.clientId)) return;
      event.respondWith(relay(event));
      return;
    }
    event.respondWith(
      registry.ready.then(() =>
        registry.has(event.clientId)
          ? relay(event)
          : scope.fetch(event.request),
      ),
    );
  });
}
