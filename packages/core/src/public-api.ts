/**
 * Everything `@schmock/core` exports besides `schmock()` itself. The Node
 * entry (`index.ts`) and the browser entry (`index.browser.ts`) both re-export
 * this module whole, so the two builds expose the same names and one
 * declaration file (`dist/index.d.ts`) describes both.
 */
import { createFetchInterceptor as createAdapterFetchInterceptor } from "./interceptor.js";

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
  AbortedExchange,
  AdapterRequest,
  AdapterRequestOverride,
  AdapterResponse,
  /**
   * @deprecated Import `AngularAdapterOptions` from `@schmock/angular`; this
   * copy will be removed in the next major version.
   */
  AngularAdapterOptions,
  AnsweredExchange,
  CallableMockInstance,
  CrudOperationMeta,
  Exchange,
  ExchangeRequest,
  ExchangeResponse,
  /**
   * @deprecated Import `ExpressAdapterOptions` from `@schmock/express`; this
   * copy will be removed in the next major version.
   */
  ExpressAdapterOptions,
  FailedExchange,
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
  ReadonlyURLSearchParams,
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
