import { throwIfAborted } from "./abort.js";
import { SchmockError } from "./errors.js";

type ResponseDelay = number | [number, number];

/** The longest delay `setTimeout` honours (2^31 - 1 ms, about 24.8 days). */
const MAX_DELAY_MS = 2_147_483_647;

function isValidDelayMs(value: unknown): boolean {
  return (
    typeof value === "number" && Number.isFinite(value) && value <= MAX_DELAY_MS
  );
}

/**
 * Reject a response delay no timer can honour. `setTimeout` turns Infinity or
 * anything past 2^31 - 1 ms into a 1 ms wait and NaN into none, so a test meant
 * to make a client time out got an immediate answer instead. A negative value
 * still clamps to zero and a reversed range still draws between its bounds.
 *
 * @param option What the error names: `delay`, or the route's own delay.
 * @throws SchmockError `INVALID_CONFIG`
 */
export function assertValidDelay(delay: unknown, option = "delay"): void {
  if (delay === undefined) return;
  const valid = Array.isArray(delay)
    ? delay.length === 2 && delay.every(isValidDelayMs)
    : isValidDelayMs(delay);
  if (valid) return;
  const shown = Array.isArray(delay)
    ? `[${delay.map(String).join(", ")}]`
    : String(delay);
  throw new SchmockError(
    `Invalid ${option}: ${shown}. Expected a finite number of milliseconds no greater than ${MAX_DELAY_MS}, or a [min, max] pair of them.`,
    "INVALID_CONFIG",
    { delay },
  );
}

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
