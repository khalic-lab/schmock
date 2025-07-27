/// <reference path="../../../types/schmock.d.ts" />

// Re-export fluent API types for internal use
export type HttpMethod = Schmock.HttpMethod;
export type RouteKey = Schmock.RouteKey;
export type BuilderConfig = Schmock.BuilderConfig;
export type ResponseContext<T = any> = Schmock.ResponseContext<T>;
export type ResponseResult = Schmock.ResponseResult;
export type ResponseFunction<T = any> = Schmock.ResponseFunction<T>;
export type RouteDefinition<T = any> = Schmock.RouteDefinition<T>;
export type Routes<T = any> = Schmock.Routes<T>;
export type Builder<T = any> = Schmock.Builder<T>;
export type MockInstance<T = any> = Schmock.MockInstance<T>;