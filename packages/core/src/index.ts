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

  // Create a callable function that wraps the instance
  const callableInstance = ((
    route: Schmock.RouteKey,
    generator: Schmock.Generator,
    config: Schmock.RouteConfig = {},
  ) => {
    instance.defineRoute(route, generator, config);
    return callableInstance; // Return the callable function for chaining
  }) as any;

  // Manually bind all instance methods to the callable function with proper return values
  callableInstance.pipe = (plugin: Schmock.Plugin) => {
    instance.pipe(plugin);
    return callableInstance; // Return callable function for chaining
  };
  callableInstance.handle = instance.handle.bind(instance);

  return callableInstance as Schmock.CallableMockInstance;
}

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
  Response,
  ResponseResult,
  RouteConfig,
  RouteKey,
} from "./types";
