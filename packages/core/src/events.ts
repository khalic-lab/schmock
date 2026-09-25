import type { DebugLogger } from "./debug-logger.js";
import { errorMessage } from "./errors.js";
import { isThenable } from "./plugin-hooks.js";

/**
 * The mock's lifecycle event listeners.
 *
 * Every listener receives one frozen snapshot of the event, so a listener
 * cannot edit what the next one (or the request) sees. A listener that throws
 * or rejects is logged and never reaches the request.
 */
export class MockEvents {
  // biome-ignore lint/complexity/noBannedTypes: internal storage for event listeners with varying signatures
  #listeners = new Map<string, Set<Function>>();
  readonly #logger: DebugLogger;

  constructor(logger: DebugLogger) {
    this.#logger = logger;
  }

  on<E extends Schmock.SchmockEvent>(
    event: E,
    listener: (data: Schmock.SchmockEventMap[E]) => void,
  ): void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
  }

  off<E extends Schmock.SchmockEvent>(
    event: E,
    listener: (data: Schmock.SchmockEventMap[E]) => void,
  ): void {
    this.#listeners.get(event)?.delete(listener);
  }

  emit<E extends Schmock.SchmockEvent>(
    event: E,
    data: Schmock.SchmockEventMap[E],
  ): void {
    const set = this.#listeners.get(event);
    if (!set) return;

    const snapshot: Record<string, unknown> = { ...data };
    if ("headers" in data) {
      snapshot.headers = Object.freeze({ ...data.headers });
    }
    if ("params" in data) {
      snapshot.params = Object.freeze({ ...data.params });
    }
    const eventData = Object.freeze(snapshot);

    for (const listener of [...set]) {
      try {
        const listenerResult: unknown = listener(eventData);
        if (isThenable(listenerResult)) {
          void Promise.resolve(listenerResult).catch((error) => {
            this.#logger.log(
              "event",
              `${event} listener rejected: ${errorMessage(error)}`,
            );
          });
        }
      } catch (error) {
        this.#logger.log(
          "event",
          `${event} listener failed: ${errorMessage(error)}`,
        );
      }
    }
  }

  /** Remove every listener. */
  clear(): void {
    this.#listeners.clear();
  }
}
