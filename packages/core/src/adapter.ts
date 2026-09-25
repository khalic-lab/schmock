/**
 * `@schmock/core/adapter`: the low-level protocol transport adapters are built
 * on. Application code uses `mock.handle()`, `mock.listen()` and
 * `mock.intercept()` from `@schmock/core` instead.
 *
 * - `acquireRequestAdmission` pins a request to the mock's routes and plugins
 *   at arrival, so a concurrent `reset()` cannot change them mid-request.
 * - `awaitWithAbort` / `abortReason` race a hook or handler against the
 *   request's abort signal.
 * - `createFetchInterceptor` is the fetch interception `mock.intercept()` is
 *   built on.
 *
 * @packageDocumentation
 */

export { abortReason, awaitWithAbort } from "./abort.js";
export { acquireRequestAdmission } from "./admission.js";
// Taken from the root entry on purpose: only `dist/index.d.ts` declares the
// ambient `Schmock` namespace, so this import is what makes the adapter
// declarations resolve when a consumer imports this entry alone.
export type {
  CallableMockInstance,
  InterceptHandle,
  InterceptOptions,
} from "./index.js";
export { createFetchInterceptor } from "./interceptor.js";
export type { MockRequestHandler, RequestAdmission } from "./types.js";
