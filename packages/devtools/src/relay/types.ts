// ── wire ─────────────────────────────────────────────────────────────
export interface SerializedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: [string, string][];
  readonly body: ArrayBuffer | null;
}
export interface SerializedResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: [string, string][];
  readonly body: ArrayBuffer | null;
}
/** page → worker via RelayWorker.postMessage. hello carries [port] (ReadyMessage replied on it); goodbye carries an optional [port] (ReleasedMessage); claim carries none. */
export type HelloMessage = {
  readonly type: "schmock:hello";
  readonly protocol: number;
  readonly version: string;
};
type GoodbyeMessage = { readonly type: "schmock:goodbye" };
type ClaimMessage = { readonly type: "schmock:claim" };
export type PageToWorkerMessage = HelloMessage | GoodbyeMessage | ClaimMessage;
export type ReadyMessage = {
  readonly type: "schmock:ready";
  readonly protocol: number;
  readonly version: string;
};
export type ReleasedMessage = { readonly type: "schmock:released" };
/** worker → page via ClientLike.postMessage(message, [port2, ...(body ? [body] : [])]). */
export type RequestMessage = {
  readonly type: "schmock:request";
  readonly request: SerializedRequest;
};
/** page → worker on the request's port: exactly one, then the page closes its port. */
export type RelayReply =
  | { readonly type: "schmock:response"; readonly response: SerializedResponse }
  | { readonly type: "schmock:passthrough" }
  | {
      readonly type: "schmock:error";
      readonly error: { readonly name: string; readonly message: string };
    }
  | { readonly type: "schmock:aborted" };
/** worker → page on the request's port: at most one, before the reply. */
export type AbortRequestMessage = { readonly type: "schmock:abort" };

// ── worker side (real ServiceWorkerGlobalScope objects satisfy these structurally) ──
export interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}
export interface ClientLike {
  readonly id: string;
  postMessage(message: RequestMessage, transfer: Transferable[]): void;
}
export interface ExtendableMessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
  readonly source: { readonly id: string } | null;
  readonly ports: readonly MessagePort[];
}
export interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  readonly clientId: string;
  respondWith(response: Promise<Response>): void; // must be called synchronously during dispatch
}
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}
export interface RelayWorkerScope {
  addEventListener(
    type: "install" | "activate",
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: ExtendableMessageEventLike) => void,
  ): void;
  addEventListener(
    type: "fetch",
    listener: (event: FetchEventLike) => void,
  ): void;
  skipWaiting(): Promise<void>;
  readonly clients: {
    claim(): Promise<void>;
    get(id: string): Promise<ClientLike | undefined>;
    matchAll(options: {
      includeUncontrolled: true;
      type: "all";
    }): Promise<readonly { readonly id: string }[]>;
  };
  /** Registry storage; undefined → memory-only registry. */
  readonly caches: CacheStorageLike | undefined;
  readonly registration: { readonly scope: string };
  /** The network. Passthrough uses the worker's own fetch, which never re-enters its fetch handler; sending it back through the page would. */
  fetch(request: Request): Promise<Response>;
}

// ── page side (navigator.serviceWorker is assignable without a cast) ──
export interface RelayWorker {
  readonly scriptURL: string;
  readonly state: string;
  postMessage(message: PageToWorkerMessage, transfer: Transferable[]): void;
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
}
export interface RelayRegistration {
  readonly scope: string;
  readonly active: RelayWorker | null;
  readonly waiting: RelayWorker | null;
  readonly installing: RelayWorker | null;
}
export interface RelayMessageEvent {
  readonly data: unknown;
  readonly ports: readonly MessagePort[];
}
export interface RelayContainer {
  readonly controller: RelayWorker | null;
  register(
    scriptUrl: string,
    options?: { scope?: string; updateViaCache?: "imports" | "all" | "none" },
  ): Promise<RelayRegistration>;
  getRegistration(clientUrl?: string): Promise<RelayRegistration | undefined>;
  startMessages(): void;
  addEventListener(
    type: "message",
    listener: (event: RelayMessageEvent) => void,
  ): void;
  addEventListener(type: "controllerchange", listener: () => void): void;
  removeEventListener(
    type: "message",
    listener: (event: RelayMessageEvent) => void,
  ): void;
  removeEventListener(type: "controllerchange", listener: () => void): void;
}
export interface RelayEnvironment {
  /** undefined → "unsupported" (checked before secureContext). */
  readonly container: RelayContainer | undefined;
  readonly secureContext: boolean;
  /** Resolves options.url (document.baseURI, else location.href). */
  readonly baseUrl: string;
  /** The page's own URL, which a worker's scope must cover; baseUrl when absent. */
  readonly pageUrl?: string;
  /** Subscribe to pagehide; returns the unsubscribe function. */
  onPageHide(listener: (persisted: boolean) => void): () => void;
}
