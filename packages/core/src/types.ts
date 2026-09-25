/// <reference path="../schmock.d.ts" />

// Re-export ambient types for consumers
export type Schema = Schmock.Schema;
export type SchemaDefinition = Schmock.SchemaDefinition;
export type HttpMethod = Schmock.HttpMethod;
export type RouteKey = Schmock.RouteKey;
export type ResponseBody = Schmock.ResponseBody;
export type ResponseResult = Schmock.ResponseResult;
export type RequestContext = Schmock.RequestContext;
export type Response = Schmock.Response;
export type RequestOptions = Schmock.RequestOptions;
export type GlobalConfig = Schmock.GlobalConfig;
export type RouteConfig = Schmock.RouteConfig;
export type Generator = Schmock.Generator;
export type GeneratorFunction = Schmock.GeneratorFunction;
export type CallableMockInstance = Schmock.CallableMockInstance;
export type Plugin = Schmock.Plugin;
export type PluginContext = Schmock.PluginContext;
export type PluginResult = Schmock.PluginResult;
export type StaticData = Schmock.StaticData;
export type RequestRecord = Schmock.RequestRecord;
export type ServerInfo = Schmock.ServerInfo;
export type RouteInfo = Schmock.RouteInfo;
export type ResourceOverride = Schmock.ResourceOverride;
export type ResponseHeaderDef = Schmock.ResponseHeaderDef;
export type CrudOperationMeta = Schmock.CrudOperationMeta;
export type SchemaGenerationContext = Schmock.SchemaGenerationContext;
export type FakerPluginOptions = Schmock.FakerPluginOptions;
/**
 * @deprecated Import `ExpressAdapterOptions` from `@schmock/express`, which
 * types `req`/`res` as Express's `Request`/`Response`. This copy types them
 * `unknown` and will be removed in the next major version.
 */
export type ExpressAdapterOptions = Schmock.ExpressAdapterOptions;
/**
 * @deprecated Import `AngularAdapterOptions` from `@schmock/angular`, which
 * types `request` as Angular's `HttpRequest`. This copy types it `unknown` and
 * will be removed in the next major version.
 */
export type AngularAdapterOptions = Schmock.AngularAdapterOptions;
export type OpenApiOptions = Schmock.OpenApiOptions;
export type OpenApiRefPolicy = Schmock.OpenApiRefPolicy;
export type OnSchemaContext = Schmock.OnSchemaContext;
export type OnSchemaCallback = Schmock.OnSchemaCallback;
export type OpenApiCallbackRequest = Schmock.OpenApiCallbackRequest;
export type OpenApiCallbackOptions = Schmock.OpenApiCallbackOptions;
export type SeedSource = Schmock.SeedSource;
export type SeedConfig = Schmock.SeedConfig;
export type AdapterRequest = Schmock.AdapterRequest;
export type AdapterResponse = Schmock.AdapterResponse;
export type InterceptOptions = Schmock.InterceptOptions;
export type InterceptHandle = Schmock.InterceptHandle;
export type AdapterRequestOverride = Schmock.AdapterRequestOverride;
export type PaginateOptions = Schmock.PaginateOptions;
export type PaginatedResponse<T> = Schmock.PaginatedResponse<T>;
export type RequestStartEvent = Schmock.RequestStartEvent;
export type RequestMatchEvent = Schmock.RequestMatchEvent;
export type RequestNotFoundEvent = Schmock.RequestNotFoundEvent;
export type RequestEndEvent = Schmock.RequestEndEvent;
export type SchmockEventMap = Schmock.SchmockEventMap;
export type SchmockEvent = Schmock.SchmockEvent;
export type ResponseParts = Schmock.ResponseParts;
export type PathPrefix = Schmock.PathPrefix;
export type FormattedErrorOptions = Schmock.FormattedErrorOptions;
export type MockRequestHandler = Schmock.MockRequestHandler;
export type RequestAdmission = Schmock.RequestAdmission;
