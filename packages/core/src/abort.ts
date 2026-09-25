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
 * that does not `await` the result still sees the abort as a rejection.
 */
export function awaitWithAbort<T>(
  value: T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}
