import { createCallableMock } from "./callable-mock.js";
import { createNodeServer } from "./node-server.js";

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
  return createCallableMock(config, createNodeServer);
}

// The browser entry (index.browser.ts) re-exports the same module, so the two
// builds differ only in the server `listen()` starts.
export * from "./public-api.js";
