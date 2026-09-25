import { throwIfAborted } from "./abort.js";

type ResponseDelay = number | [number, number];

/**
 * Apply configured response delay: the route's own when set, the mock's
 * otherwise. Supports both fixed delays and random delays within a range. An
 * abort ends the wait with the signal's reason.
 */
export async function applyResponseDelay(input: {
  routeDelay?: ResponseDelay;
  globalDelay?: ResponseDelay;
  signal?: AbortSignal;
}): Promise<void> {
  const { signal } = input;
  const effectiveDelay = input.routeDelay ?? input.globalDelay;
  if (!effectiveDelay) {
    throwIfAborted(signal);
    return;
  }

  const configuredMs = Array.isArray(effectiveDelay)
    ? Math.random() * (effectiveDelay[1] - effectiveDelay[0]) +
      effectiveDelay[0]
    : effectiveDelay;
  const ms = Math.max(0, configuredMs);

  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
