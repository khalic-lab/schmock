/**
 * The `browser` export condition's entry: `@schmock/core` as a browser
 * bundler resolves it. It exports exactly what `index.ts` does, but its mocks
 * have no HTTP server, so nothing here reaches `node-server.ts` and its
 * `node:http` import, for which Bun's browser target would otherwise inline
 * about 200 KB of Node polyfills. `mock.listen()` rejects with
 * `SERVER_UNAVAILABLE`; everything else, `mock.intercept()` included, is the
 * same code.
 */
import { createCallableMock } from "./callable-mock.js";
import { noServer } from "./server-controller.js";

/**
 * Create a new Schmock mock instance with callable API.
 *
 * In the browser build `listen()` rejects with `SERVER_UNAVAILABLE`: use
 * `mock.intercept()` to answer fetch requests.
 *
 * @example
 * ```typescript
 * const mock = schmock()
 * mock('GET /users', [{ id: 1, name: 'John' }])
 * mock.intercept({ baseUrl: '/api' })
 * ```
 *
 * @param config Optional global configuration
 * @returns A callable mock instance
 */
export function schmock(
  config?: Schmock.GlobalConfig,
): Schmock.CallableMockInstance {
  return createCallableMock(config, noServer);
}

export * from "./public-api.js";
