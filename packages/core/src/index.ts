import { REQUEST_ADMISSION_KEY } from "./admission.js";
import { CallableMockInstance } from "./builder.js";
import { createFetchInterceptor as createAdapterFetchInterceptor } from "./interceptor.js";

/**
 * Create a new Schmock mock instance with callable API.
 *
 * @example
 * ```typescript
 * // New callable API (default)
 * const mock = schmock({ debug: true })
 * mock('GET /users', () => [{ id: 1, name: 'John' }])
 *   .pipe(authPlugin())
 *
 * const response = await mock.handle('GET', '/users')
 * ```
 *
 * @example
 * ```typescript
 * // Simple usage with defaults
 * const mock = schmock()
 * mock('GET /users', [{ id: 1, name: 'John' }])
 * ```
 *
 * @param config Optional global configuration
 * @returns A callable mock instance
 */
export function schmock(
  config?: Schmock.GlobalConfig,
): Schmock.CallableMockInstance {
  // Always use new callable API
  const instance = new CallableMockInstance(config || {});

  // Callable proxy: a function with attached methods
  const callableInstance: Schmock.CallableMockInstance = Object.assign(
    (
      route: Schmock.RouteKey,
      generator: Schmock.Generator,
      routeConfig: Schmock.RouteConfig = {},
    ) => {
      instance.defineRoute(route, generator, routeConfig);
      return callableInstance;
    },
    {
      pipe: (plugin: Schmock.Plugin) => {
        instance.pipe(plugin);
        return callableInstance;
      },
      handle: instance.handle.bind(instance),
      history: instance.history.bind(instance),
      called: instance.called.bind(instance),
      callCount: instance.callCount.bind(instance),
      lastRequest: instance.lastRequest.bind(instance),
      reset: instance.reset.bind(instance),
      resetHistory: instance.resetHistory.bind(instance),
      resetState: instance.resetState.bind(instance),
      on<E extends Schmock.SchmockEvent>(
        event: E,
        listener: (data: Schmock.SchmockEventMap[E]) => void,
      ) {
        instance.on(event, listener);
        return callableInstance;
      },
      off<E extends Schmock.SchmockEvent>(
        event: E,
        listener: (data: Schmock.SchmockEventMap[E]) => void,
      ) {
        instance.off(event, listener);
        return callableInstance;
      },
      getRoutes: instance.getRoutes.bind(instance),
      getState: instance.getState.bind(instance),
      listen: instance.listen.bind(instance),
      close: instance.close.bind(instance),
      intercept: (options?: Schmock.InterceptOptions) =>
        instance.intercept(options),
    },
  );

  Object.defineProperty(callableInstance, REQUEST_ADMISSION_KEY, {
    value: () => instance.createRequestAdmission(),
  });

  instance.setCallableRef(callableInstance);

  return callableInstance;
}

/**
 * @deprecated Use `mock.intercept()`, which also tracks the lease and admits
 * each request against the mock's routes. Adapter authors who need the raw
 * interceptor import `createFetchInterceptor` from `@schmock/core/adapter`.
 * This root export will be removed in the next major version.
 */
export const createFetchInterceptor: typeof createAdapterFetchInterceptor =
  createAdapterFetchInterceptor;

export { isBinaryBody } from "./binary.js";
// Re-export constants and utilities
export {
  getResponseException,
  HTTP_METHODS,
  isHttpMethod,
  isRouteNotFound,
  isStatusTuple,
  matchPathPrefix,
  parsePathPrefix,
  ROUTE_NOT_FOUND_CODE,
  toHttpMethod,
  toRouteKey,
} from "./constants.js";
// Re-export errors
export {
  InvalidHttpMethodError,
  InvalidResponseError,
  PluginError,
  ResourceLimitError,
  RouteDefinitionError,
  RouteNotFoundError,
  RouteParseError,
  SchemaGenerationError,
  SchemaValidationError,
  SchmockError,
} from "./errors.js";
// Re-export header helpers
export {
  getHeader,
  redactHeaders,
  SENSITIVE_HEADER_NAMES,
} from "./headers.js";
// Re-export response helpers
export {
  badRequest,
  created,
  forbidden,
  noContent,
  notFound,
  paginate,
  serverError,
  unauthorized,
} from "./helpers.js";
export type {
  HttpErrorReply,
  HttpIngressErrorCode,
  NodeRequestLike,
  NodeResponseLike,
  ServeNodeRequestOptions,
  ServeNodeResponseContext,
} from "./http-helpers.js";
// Re-export HTTP server helpers
export {
  collectBody,
  HttpIngressError,
  parseNodeHeaders,
  parseNodeQuery,
  serveNodeRequest,
  writeRejectedSchmockResponse,
  writeSchmockResponse,
} from "./http-helpers.js";
export {
  buildFormattedErrorResponse,
  normalizeResponse,
  serializeResponseBody,
  withDefaultContentType,
} from "./response-normalizer.js";
export {
  getResponseParts,
  replaceResponseBody,
} from "./response-parser.js";
// Re-export types
export type {
  AdapterRequest,
  AdapterRequestOverride,
  AdapterResponse,
  /**
   * @deprecated Import `AngularAdapterOptions` from `@schmock/angular`; this
   * copy will be removed in the next major version.
   */
  AngularAdapterOptions,
  CallableMockInstance,
  CrudOperationMeta,
  /**
   * @deprecated Import `ExpressAdapterOptions` from `@schmock/express`; this
   * copy will be removed in the next major version.
   */
  ExpressAdapterOptions,
  FakerPluginOptions,
  FormattedErrorOptions,
  Generator,
  GeneratorFunction,
  GlobalConfig,
  HttpMethod,
  InterceptHandle,
  InterceptOptions,
  OnSchemaCallback,
  OnSchemaContext,
  OpenApiCallbackOptions,
  OpenApiCallbackRequest,
  OpenApiOptions,
  OpenApiRefPolicy,
  PaginatedResponse,
  PaginateOptions,
  PathPrefix,
  Plugin,
  PluginContext,
  PluginHookResult,
  PluginResult,
  RequestContext,
  RequestEndEvent,
  RequestMatchEvent,
  RequestNotFoundEvent,
  RequestOptions,
  RequestRecord,
  RequestStartEvent,
  ResourceOverride,
  Response,
  ResponseBody,
  ResponseHeaderDef,
  ResponseParts,
  ResponseResult,
  RouteConfig,
  RouteInfo,
  RouteKey,
  Schema,
  SchemaDefinition,
  SchemaGenerationContext,
  SchmockEvent,
  SchmockEventMap,
  SeedConfig,
  SeedSource,
  ServerInfo,
  StaticData,
} from "./types.js";
