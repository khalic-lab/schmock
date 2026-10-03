export interface DevtoolsPluginOptions {
  /** Log one collapsed console group per exchange. Default true. */
  console?: boolean;
  /** Add one entry per exchange to a Performance-panel custom track. Default true. */
  performance?: boolean;
  /** Track name, also the console badge. Default "Schmock". Non-empty. */
  track?: string;
  /** Group the track under this name in the Performance panel. Non-empty when set. */
  trackGroup?: string;
}
/** Colors the Performance-panel extensibility API accepts. */
export type DevToolsColor =
  | "primary"
  | "primary-light"
  | "primary-dark"
  | "secondary"
  | "secondary-light"
  | "secondary-dark"
  | "tertiary"
  | "tertiary-light"
  | "tertiary-dark"
  | "error";
export type ExchangeTone =
  | "success"
  | "client-error"
  | "server-error"
  | "failed"
  | "aborted";
/** @internal What both reporters print for one exchange. */
export interface ExchangeSummary {
  /** `${method} ${displayUrl}`: the measure name and the console title body. */
  readonly name: string;
  /** "200" | "failed: <message>" | "aborted" */
  readonly outcome: string;
  /** "3.2 ms": one decimal place, never negative. */
  readonly duration: string;
  readonly tone: ExchangeTone;
}
export interface ServiceWorkerRelayOptions {
  /** URL the app serves schmock-sw.js at. Default "/schmock-sw.js". Non-empty. */
  url?: string;
  /** Registration scope. Default: the browser's (the script's directory). Non-empty when set. */
  scope?: string;
  /** Milliseconds for the whole start (registration, activation, control and the handshake), and for stop()'s acknowledgement. Default 5000. Positive and finite. */
  timeout?: number;
}
export type RelayFallbackReason =
  | "unsupported"
  | "insecure-context"
  | "scope-taken"
  | "registration-failed"
  | "not-controlled"
  | "protocol-mismatch"
  | "timeout";
export interface ServiceWorkerRelay {
  /** True while the worker relays this page's requests (read live). */
  readonly active: boolean;
  /** Why the relay is not active, once it fell back; undefined while starting, active, or after stop(). */
  readonly fallbackReason: RelayFallbackReason | undefined;
  /** Stop relaying for this page: in-page interception answers fetch again. The worker stays registered (inert for this page). Idempotent. */
  stop(): Promise<void>;
}
