import type { Server } from "node:http";
import type { DebugLogger } from "./debug-logger.js";
import { errorMessage, SchmockError } from "./errors.js";
import { DEFAULT_MAX_BODY_SIZE, serveNodeRequest } from "./http-helpers.js";

interface PendingServerStart {
  readonly token: symbol;
  readonly port: number;
  readonly hostname: string;
  readonly resolve: (info: Schmock.ServerInfo) => void;
  readonly reject: (error: unknown) => void;
  server?: Server;
  settled: boolean;
}

interface NodeServerControllerOptions {
  /**
   * Admit one request against the mock. Called on arrival, before the request
   * is parsed, and released once it is answered.
   */
  readonly admitRequest: () => Schmock.RequestAdmission;
  readonly logger: DebugLogger;
}

/**
 * The standalone HTTP server behind `mock.listen()` / `mock.close()`.
 *
 * Owns the start and close state machines: at most one server is running or
 * starting, a `close()` during start-up cancels the start, and a new start
 * waits for every earlier server to finish closing (the close barrier) so a
 * restart on the same port never races the old socket.
 *
 * `node:http` is imported lazily, on the first `listen()`, so a browser bundle
 * that never listens never pulls it in (issue #395).
 */
export class NodeServerController {
  #server: Server | undefined;
  #pendingStart: PendingServerStart | undefined;
  #closeBarrier: Promise<void> | undefined;
  readonly #admitRequest: () => Schmock.RequestAdmission;
  readonly #logger: DebugLogger;

  constructor(options: NodeServerControllerOptions) {
    this.#admitRequest = options.admitRequest;
    this.#logger = options.logger;
  }

  listen(port: number, hostname: string): Promise<Schmock.ServerInfo> {
    if (this.#server || this.#pendingStart) {
      throw new SchmockError(
        "Server is already running",
        "SERVER_ALREADY_RUNNING",
      );
    }

    let resolveStart = (_info: Schmock.ServerInfo) => {};
    let rejectStart = (_error: unknown) => {};
    const startPromise = new Promise<Schmock.ServerInfo>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const operation: PendingServerStart = {
      token: Symbol("schmock.server.start"),
      port,
      hostname,
      resolve: resolveStart,
      reject: rejectStart,
      settled: false,
    };
    this.#pendingStart = operation;

    const closeBarrier = this.#closeBarrier ?? Promise.resolve();
    void closeBarrier
      // Lazy-load node:http so browser bundles never pull it in (issue #395).
      // The rejection handler must sit on the import() expression itself:
      // esbuild (and so the Angular application builder) leaves a dynamic
      // import unresolved only when that expression handles its own failure,
      // and the outer .catch() below does not count. Without it a
      // `platform: "browser"` build fails with `Could not resolve "node:http"`.
      .then(() =>
        import("node:http").catch((error: unknown) => {
          throw error;
        }),
      )
      .then(({ createServer }) => {
        if (!this.#ownsServerStart(operation)) return;
        this.#startHttpServer(operation, createServer);
      })
      .catch((error) => {
        this.#rejectServerStart(operation, error);
      });

    return startPromise;
  }

  close(): void {
    this.#cancelServerStart();
    const server = this.#server;
    if (!server) return;

    this.#server = undefined;
    this.#beginServerClose(server);
    this.#logger.log("server", "Server stopped");
  }

  #ownsServerStart(operation: PendingServerStart): boolean {
    return this.#pendingStart === operation && !operation.settled;
  }

  #startHttpServer(
    operation: PendingServerStart,
    createServer: typeof import("node:http").createServer,
  ): void {
    const httpServer = createServer((req, res) => {
      // Admitted on arrival, before the request is parsed, so a reset() while
      // its body uploads neither changes its routes nor uninstalls its plugins.
      const admittedRequest = this.#admitRequest();
      void serveNodeRequest(req, res, {
        handle: admittedRequest.handle,
        maxBodySize: DEFAULT_MAX_BODY_SIZE,
      }).finally(() => admittedRequest.release());
    });

    operation.server = httpServer;

    const handleStartupError = (error: Error) => {
      this.#rejectServerStart(operation, error);
    };
    httpServer.once("error", handleStartupError);

    // Once listening, a server-level 'error' (an accept failure such as
    // EMFILE) must still have a listener: with none, Node rethrows it as an
    // uncaught exception and takes the whole test runner down.
    const reportServerError = (error: Error) => {
      this.#logger.log("server", `Server error: ${errorMessage(error)}`);
    };

    try {
      httpServer.listen(operation.port, operation.hostname, () => {
        // Attach the permanent reporter BEFORE dropping the startup handler:
        // the other order leaves a window with no 'error' listener at all.
        httpServer.on("error", reportServerError);
        httpServer.off("error", handleStartupError);
        if (!this.#ownsServerStart(operation)) {
          this.#beginServerClose(httpServer);
          return;
        }

        const addr = httpServer.address();
        const actualPort =
          addr !== null && typeof addr === "object"
            ? addr.port
            : operation.port;
        const info = { port: actualPort, hostname: operation.hostname };
        operation.settled = true;
        this.#pendingStart = undefined;
        this.#server = httpServer;
        this.#logger.log(
          "server",
          `Listening on ${operation.hostname}:${actualPort}`,
        );
        operation.resolve(info);
      });
    } catch (error) {
      httpServer.off("error", handleStartupError);
      this.#rejectServerStart(operation, error);
    }
  }

  #rejectServerStart(operation: PendingServerStart, error: unknown): void {
    if (operation.settled) return;

    operation.settled = true;
    if (this.#pendingStart === operation) {
      this.#pendingStart = undefined;
    }
    if (operation.server) {
      this.#beginServerClose(operation.server);
    }
    operation.reject(error);
  }

  #cancelServerStart(): void {
    const operation = this.#pendingStart;
    if (!operation) return;

    this.#rejectServerStart(
      operation,
      new SchmockError("Server start was cancelled", "SERVER_START_CANCELLED"),
    );
  }

  #beginServerClose(server: Server): void {
    const closePromise = new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    try {
      server.closeAllConnections();
    } catch {
      // A not-yet-listening server has no connections to close.
    }
    const previousBarrier = this.#closeBarrier ?? Promise.resolve();
    const combinedBarrier = Promise.all([previousBarrier, closePromise]).then(
      () => undefined,
    );
    this.#closeBarrier = combinedBarrier;
    void combinedBarrier.finally(() => {
      if (this.#closeBarrier === combinedBarrier) {
        this.#closeBarrier = undefined;
      }
    });
  }
}
