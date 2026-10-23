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
 *   built on, without its exchange observation: `onExchange` is never called
 *   for a transport built on it.
 * - `acquireFetchRelay` / `routeRelayedRequest` let a relay transport (a
 *   service worker) deliver intercepted requests itself.
 * - `toError` turns any thrown value into an `Error` the way core does, and
 *   `buildJsonErrorResponse` builds the `{ error, code }` envelope core
 *   answers a failure with.
 * - `isCredentialName` is the rule core's debug log masks query parameters by.
 * - `requestBodyKindOf`, `parseJsonBody` and `parseFormBody` decode a request
 *   body the way `mock.listen()` and the fetch interceptor do, and
 *   `parseJsonBody` throws `HttpIngressError` (400) for a JSON body that does
 *   not parse or nests too deep.
 *
 * @packageDocumentation
 */

export { abortReason, awaitWithAbort } from "./abort.js";
export { acquireRequestAdmission } from "./admission.js";
export { toError } from "./errors.js";
export { isCredentialName } from "./headers.js";
// Taken from the root entry on purpose: only `dist/index.d.ts` declares the
// ambient `Schmock` namespace, so this import is what makes the adapter
// declarations resolve when a consumer imports this entry alone.
export type {
  CallableMockInstance,
  InterceptHandle,
  InterceptOptions,
} from "./index.js";
export {
  acquireFetchRelay,
  createFetchInterceptor,
  routeRelayedRequest,
} from "./interceptor.js";
export {
  HttpIngressError,
  type HttpIngressErrorCode,
  parseFormBody,
  parseJsonBody,
  type RequestBodyKind,
  requestBodyKindOf,
} from "./request-body.js";
export { buildJsonErrorResponse } from "./response-normalizer.js";
export type {
  FetchRelay,
  JsonErrorResponseOptions,
  MockRequestHandler,
  RequestAdmission,
} from "./types.js";
