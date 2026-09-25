import { SchmockError } from "./errors.js";

/**
 * The key a callable mock carries its request-admission factory under.
 *
 * Registered with `Symbol.for` so that a second copy of `@schmock/core` in the
 * same process (an adapter resolving its own dependency) still finds it.
 */
export const REQUEST_ADMISSION_KEY = Symbol.for(
  "@schmock/core.request-admission",
);

function isRequestAdmission(value: unknown): value is Schmock.RequestAdmission {
  return (
    typeof value === "object" &&
    value !== null &&
    "handle" in value &&
    typeof value.handle === "function" &&
    "release" in value &&
    typeof value.release === "function"
  );
}

/**
 * Admit one request against the mock's current routes and plugins.
 *
 * A transport acquires the admission when the request arrives, routes it with
 * `admission.handle`, and calls `admission.release()` once it settles, so a
 * `mock.reset()` issued meanwhile neither changes the routes the request sees
 * nor uninstalls its plugins underneath it.
 *
 * @returns `undefined` for a value that is not a `schmock()` instance (a
 *   hand-written stub), which the caller then routes through `mock.handle`.
 * @throws SchmockError `INVALID_REQUEST_ADMISSION` when the mock's factory
 *   returns something that is not an admission.
 */
export function acquireRequestAdmission(
  mock: Schmock.CallableMockInstance,
): Schmock.RequestAdmission | undefined {
  const admit: unknown = Reflect.get(mock, REQUEST_ADMISSION_KEY);
  if (typeof admit !== "function") return undefined;

  const admission: unknown = Reflect.apply(admit, mock, []);
  if (!isRequestAdmission(admission)) {
    throw new SchmockError(
      "Schmock returned an invalid request admission",
      "INVALID_REQUEST_ADMISSION",
    );
  }
  return admission;
}
