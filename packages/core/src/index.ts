import { CallableMockInstance } from "./builder";

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
    },
  );

  return callableInstance;
}

// Re-export constants and utilities
export {
  HTTP_METHODS,
  isHttpMethod,
  ROUTE_NOT_FOUND_CODE,
  toHttpMethod,
} from "./constants";
// Re-export errors
export {
  PluginError,
  ResourceLimitError,
  ResponseGenerationError,
  RouteDefinitionError,
  RouteNotFoundError,
  RouteParseError,
  SchemaGenerationError,
  SchemaValidationError,
  SchmockError,
} from "./errors";
// Re-export types
export type {
  CallableMockInstance,
  Generator,
  GeneratorFunction,
  GlobalConfig,
  HttpMethod,
  Plugin,
  PluginContext,
  PluginResult,
  RequestContext,
  RequestOptions,
  RequestRecord,
  Response,
  ResponseBody,
  ResponseResult,
  RouteConfig,
  RouteKey,
  StaticData,
} from "./types";
