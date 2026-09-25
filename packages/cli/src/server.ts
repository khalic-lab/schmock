import type { Server } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type * as Schmock from "@schmock/core";
import { SchmockError, schmock } from "@schmock/core";
import { openapi } from "@schmock/openapi";
import { DEFAULT_ADMIN_HISTORY_LIMIT, resolveAdminToken } from "./admin.js";
import { handleCliRequest } from "./request.js";
import { loadSeedFile } from "./seed-manifest.js";
import type { CliOptions, CliServer } from "./types.js";
import type { MockHolder, WatchHandle } from "./watch.js";
import { startWatch } from "./watch.js";

/** Default ceiling on how long a graceful close waits for in-flight requests. */
export const SHUTDOWN_GRACE_MS = 5_000;

async function createCliMock(
  options: CliOptions,
): Promise<Schmock.CallableMockInstance> {
  // History exists solely to feed `GET /schmock-admin/history`, so it is off
  // entirely when admin is off — otherwise the CLI accumulates every request
  // and response body for the life of the process with no way to read them.
  // `adminHistoryLimit` is core's `maxHistorySize` under the admin API's name:
  // it applies only while admin is on, and it defaults to
  // DEFAULT_ADMIN_HISTORY_LIMIT where core defaults to unbounded.
  const mock = schmock({
    debug: options.debug,
    state: {},
    maxHistorySize: options.admin
      ? (options.adminHistoryLimit ?? DEFAULT_ADMIN_HISTORY_LIMIT)
      : 0,
  });

  const openapiOptions: Parameters<typeof openapi>[0] = {
    spec: options.spec,
    fakerSeed: options.fakerSeed,
    validateRequests: options.errors,
    strict: options.strict,
    refs: {
      external: options.refsExternal ?? false,
      allowHttp: options.refsAllowHttp !== undefined,
      allowedHosts: options.refsAllowHttp,
    },
  };

  if (options.seed) {
    openapiOptions.seed = loadSeedFile(options.seed);
  }

  const plugin = await openapi(openapiOptions);
  mock.pipe(plugin);

  return mock;
}

interface OwnedCliServer extends CliServer {
  /** Work that must finish before the socket is released (the spec watcher). */
  onClose(cleanup: () => Promise<void> | void): void;
}

/** Resolve after `ms` without holding the event loop open. */
function boundedDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Stop accepting and settle once the socket is released, bounded by `graceMs`.
 *
 * Node ≥ 19 already drops *idle* keep-alive connections on `close()`, but a
 * request whose body was only half sent never completes on its own: without
 * the grace timer the close callback would never fire and the process could
 * not exit.
 *
 * At the deadline every tracked socket is also destroyed directly. Node's
 * `closeAllConnections()` alone suffices there, but Bun's `node:http` returns
 * from it without releasing a connection whose request body is incomplete, so
 * the close callback never fired and shutdown hung until SIGKILL.
 */
function closeHttpServer({
  httpServer,
  graceMs,
  sockets,
}: {
  httpServer: Server;
  graceMs: number;
  sockets: ReadonlySet<Socket>;
}): Promise<void> {
  return new Promise<void>((resolve) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      resolve();
    };

    // The callback receives ERR_SERVER_NOT_RUNNING when the socket is already
    // down; closing an already-closed server is a success here, not a failure.
    httpServer.close(() => settle());
    try {
      httpServer.closeIdleConnections();
    } catch {
      // Nothing bound means nothing idle.
    }

    graceTimer = setTimeout(() => {
      try {
        httpServer.closeAllConnections();
      } catch {
        // Already torn down by the close above.
      }
      for (const socket of sockets) socket.destroy();
    }, graceMs);
    // The grace timer must never be the thing holding the event loop open.
    graceTimer.unref();
  });
}

/**
 * Bind one HTTP server for the whole life of the process. Reloads swap
 * {@link MockHolder.mock} behind it rather than rebinding, so the listening
 * socket is never released while the server is meant to be up.
 */
function startCliServer(
  options: CliOptions,
  holder: MockHolder,
): Promise<OwnedCliServer> {
  // `??` only covers null/undefined, so a blank hostname would survive to
  // `listen()` and bind every interface instead of the documented loopback
  // default. `createCliServer` is public, so the guard belongs here too and
  // not only in the flag parser.
  if (options.hostname !== undefined && options.hostname.trim() === "") {
    throw new SchmockError(
      "Invalid hostname. The hostname must be a non-empty host, address or interface.",
      "INVALID_CONFIG",
      { option: "hostname", value: options.hostname },
    );
  }
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const cors = options.cors ?? false;
  const graceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;

  const admin = options.admin ?? false;
  // Read once, here: a reload swaps only the mock, so the credential a live
  // admin client is holding can never rotate under it.
  const adminToken = admin ? options.adminToken : undefined;

  const httpServer = createServer((req, res) => {
    // Resolved per request: a request already under way keeps the mock it was
    // admitted against, while later requests see the reloaded one.
    void handleCliRequest(req, res, {
      mock: holder.mock,
      admin,
      cors,
      adminToken,
    });
  });

  // Tracked so the shutdown deadline can release every connection itself
  // rather than trusting the runtime's closeAllConnections (see closeHttpServer).
  const sockets = new Set<Socket>();
  httpServer.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const cleanups: Array<() => Promise<void> | void> = [];
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    // Memoized: a second Ctrl-C, or a teardown that follows an explicit close,
    // observes the same shutdown instead of starting another one.
    closing ??= (async () => {
      // Stop accepting before anything else: the settle starts now, so the
      // socket is released within `graceMs` even while a cleanup (a watcher
      // mid-reload) is still draining.
      const settled = closeHttpServer({ httpServer, graceMs, sockets });
      const drain = (async () => {
        for (const cleanup of cleanups.splice(0)) await cleanup();
      })();
      // A drain that outlives the bound is abandoned rather than reported —
      // there is no caller left to reach — and its observable effects are
      // already suppressed by the watcher's own `closed` flag.
      drain.catch(() => {});
      try {
        // The drain is raced against the same bound the socket close honors,
        // so `close()` settles within `graceMs` as documented instead of
        // blocking on an in-flight spec reload of unbounded duration.
        await Promise.race([drain, boundedDelay(graceMs)]);
      } finally {
        // A cleanup that throws must not strand a bound socket: the close runs
        // either way and the failure still reaches the caller.
        await settled;
      }
    })();
    return closing;
  };

  return new Promise((resolve, reject) => {
    const onListenError = (error: unknown): void => reject(error);
    // A socket-level failure once the server is up (a stray accept error)
    // reached an already-settled `reject` and vanished. Report it and keep
    // serving: a development mock server surviving a stray error is worth more
    // than exiting, and every other CLI diagnostic goes to stderr too.
    const reportServerError = (error: unknown): void => {
      process.stderr.write(
        `Server error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    };

    httpServer.once("error", onListenError);
    httpServer.listen(port, hostname, () => {
      // Attach the permanent reporter BEFORE dropping the startup handler:
      // the other order leaves a window with zero 'error' listeners, in which
      // Node rethrows the event and kills the process.
      httpServer.on("error", reportServerError);
      httpServer.off("error", onListenError);

      const addr = httpServer.address();
      const actualPort =
        addr !== null && typeof addr === "object" ? addr.port : port;

      resolve({
        server: httpServer,
        port: actualPort,
        hostname,
        adminToken,
        close,
        onClose(cleanup) {
          cleanups.push(cleanup);
        },
      });
    });
  });
}

/** Bracket an IPv6 literal so `http://${host}:${port}` is a parseable URL. */
function formatUrlHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
}

export function serverUrl(address: { hostname: string; port: number }): string {
  return `http://${formatUrlHost(address.hostname)}:${address.port}`;
}

/**
 * Start a mock server for an OpenAPI spec, as the `schmock` command does.
 *
 * @throws SchmockError `INVALID_CONFIG` for a blank hostname or an unusable
 *   admin token, before anything is bound
 */
export async function createCliServer(options: CliOptions): Promise<CliServer> {
  const resolved: CliOptions = {
    ...options,
    adminToken: resolveAdminToken(options),
  };
  const holder: MockHolder = { mock: await createCliMock(resolved) };
  const server = await startCliServer(resolved, holder);

  if (resolved.watch) {
    let watcher: WatchHandle;
    try {
      watcher = startWatch({
        options: resolved,
        holder,
        rebuild: () => createCliMock(resolved),
        url: serverUrl(server),
      });
    } catch (error) {
      // A watcher that cannot be created must not leave a bound socket behind:
      // the caller gets the failure and the process can still exit.
      await server.close();
      throw error;
    }
    server.onClose(() => watcher.close());
  }

  return server;
}
