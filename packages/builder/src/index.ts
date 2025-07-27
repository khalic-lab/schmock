import { SchmockBuilder } from "./builder";
import type { Builder } from "./types";

/**
 * Create a new Schmock mock builder.
 *
 * @example
 * ```typescript
 * const mock = schmock()
 *   .routes({
 *     'GET /users': {
 *       response: () => [{ id: 1, name: 'John' }]
 *     }
 *   })
 *   .build()
 *
 * const response = await mock.handle('GET', '/users')
 * ```
 *
 * @returns A new builder instance
 */
export function schmock(): Builder {
  return new SchmockBuilder();
}

// Re-export types
export type {
  Builder,
  BuilderConfig,
  HttpMethod,
  MockInstance,
  ResponseContext,
  ResponseFunction,
  ResponseResult,
  RouteDefinition,
  RouteKey,
  Routes,
} from "./types";
