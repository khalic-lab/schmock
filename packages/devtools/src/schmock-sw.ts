import type { RelayWorkerScope } from "./relay/types.js";
import { installRelayWorker } from "./relay/worker.js";

// lib.dom types the global `self` as a Window. In a service worker it is the
// ServiceWorkerGlobalScope, which satisfies RelayWorkerScope structurally; this
// module-scoped declaration says so without a type assertion.
declare const self: RelayWorkerScope;
installRelayWorker(self);
