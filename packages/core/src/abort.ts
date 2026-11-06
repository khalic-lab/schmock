/**
 * The reason an aborted signal carries, or a generic `AbortError` for a
 * runtime whose signals predate `reason`.
 */
export function abortReason(signal: AbortSignal): unknown {
  if ("reason" in signal && signal.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Settle with `value`, or reject with the signal's abort reason as soon as the
 * signal aborts, whichever comes first. Without a signal it only awaits the
 * value. An already-aborted signal rejects instead of throwing, so a caller
 * that does not `await` the result still sees the abort as a rejection. The
 * value is observed either way: a promise the abort abandons may still reject,
 * and that must never surface as an unhandled rejection.
 */
export function awaitWithAbort<T>(
  value: T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  return awaitHookWithAbort(value, signal);
}

/**
 * Told about a hook's promise that an abort abandoned while it still runs, so
 * the caller can keep what the hook depends on alive until it settles.
 */
export type AbandonedHookTracker = (pending: PromiseLike<unknown>) => void;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/**
 * {@link awaitWithAbort} for a plugin hook: when the abort wins while `value`
 * is a promise that has not settled, `onAbandoned` receives it.
 */
export function awaitHookWithAbort<T>(
  value: T | PromiseLike<T>,
  signal?: AbortSignal,
  onAbandoned?: AbandonedHookTracker,
): Promise<T> {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) {
    const pending = Promise.resolve(value);
    pending.catch(() => {});
    if (isThenable(value)) onAbandoned?.(pending);
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const pending = Promise.resolve(value);
    const abort = () =>
      finish(() => {
        if (isThenable(value)) onAbandoned?.(pending);
        reject(abortReason(signal));
      });
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}
