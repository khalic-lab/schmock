/// <reference path="../../../types/schmock.d.ts" />

// Re-export fluent API types for internal use
export type HttpMethod = Schmock.HttpMethod;
export type RouteKey = Schmock.RouteKey;
export type BuilderConfig = Schmock.BuilderConfig;
export type ResponseContext<T = unknown> = Schmock.ResponseContext<T>;
export type ResponseResult = Schmock.ResponseResult;
export type ResponseFunction<T = unknown> = Schmock.ResponseFunction<T>;
export type RouteDefinition<T = unknown> = Schmock.RouteDefinition<T>;
export type Routes<T = unknown> = Schmock.Routes<T>;
export type Builder<T = unknown> = Schmock.Builder<T>;
export type MockInstance<T = unknown> = Schmock.MockInstance<T>;
