import type { DebugLogger } from "./debug-logger.js";
import { SchmockError } from "./errors.js";

/** The server behind `mock.listen()` / `mock.close()`. */
export interface ServerController {
  listen(port: number, hostname: string): Promise<Schmock.ServerInfo>;
  close(): void;
}

export interface ServerControllerOptions {
  /**
   * Admit one request against the mock. Called on arrival, before the request
   * is parsed, and released once it is answered.
   */
  readonly admitRequest: () => Schmock.RequestAdmission;
  readonly logger: DebugLogger;
}

/**
 * Builds the server a mock listens with. The package entry chooses it, so the
 * builder never imports the Node server itself: `index.ts` passes
 * `createNodeServer`, and `index.browser.ts` passes {@link noServer}, which
 * keeps `node:http` and every polyfill a browser bundler would inline for it
 * out of a browser build.
 */
export type ServerControllerFactory = (
  options: ServerControllerOptions,
) => ServerController;

/** Code of the rejection `listen()` gives in the browser build. */
const SERVER_UNAVAILABLE_CODE = "SERVER_UNAVAILABLE";

/**
 * The server of the browser build, which has none: a browser cannot accept
 * connections. `listen()` keeps its promise shape and rejects; `close()` has
 * nothing to stop.
 */
export const noServer: ServerControllerFactory = () => ({
  listen: () =>
    Promise.reject(
      new SchmockError(
        "mock.listen() needs the Node.js or Bun build of @schmock/core: this " +
          "is its browser build, which has no HTTP server. A bundler or a " +
          "test environment that applies the `browser` export condition " +
          "(Jest's jsdom environment does, through customExportConditions) " +
          "resolves this build, even when running on Node.js. Use " +
          "mock.intercept() to answer fetch requests in a browser.",
        SERVER_UNAVAILABLE_CODE,
      ),
    ),
  close: () => {},
});
