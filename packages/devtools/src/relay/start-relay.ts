import type {
  ServiceWorkerRelay,
  ServiceWorkerRelayOptions,
} from "../types.js";
import { createServiceWorkerRelay, isNonEmptyString } from "./page-relay.js";
import type { RelayContainer, RelayEnvironment } from "./types.js";

// The package entry re-exports this module, so its declarations are public:
// it exports nothing typed with relay/types.ts, whose transfer lists name the
// DOM lib's Transferable and would not compile for a consumer without it.

/**
 * Start relaying this page's mocked requests through the Schmock service
 * worker, so they appear as native rows in the Network panel. Reads the
 * page's globals when called, never at import.
 */
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
