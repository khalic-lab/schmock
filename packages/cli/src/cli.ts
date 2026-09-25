/**
 * The `schmock` command: {@link run}, plus the public surface re-exported from
 * the modules that implement it, so `index.ts`, `bin.ts` and existing imports
 * of this file keep working.
 */
import { resolveAdminToken } from "./admin.js";
import { isLoopbackHost, parseCliArgs, USAGE } from "./args.js";
import { createCliServer, SHUTDOWN_GRACE_MS, serverUrl } from "./server.js";

export { isLoopbackHost, parseCliArgs } from "./args.js";
export { loadSeedFile } from "./seed-manifest.js";
export { createCliServer } from "./server.js";
export type { CliOptions, CliServer } from "./types.js";

export async function run(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  // Settle the admin token before anything else reads the options object: the
  // banner below prints it and `createCliServer` binds it to the socket, so
  // minting it any later would print one token and enforce another.
  const options = { ...parsed, adminToken: resolveAdminToken(parsed) };

  if (options.help) {
    process.stderr.write(USAGE);
    return;
  }

  if (!options.spec) {
    process.stderr.write("Error: --spec is required\n\n");
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  const cliServer = await createCliServer(options);

  process.stderr.write(`Schmock server running on ${serverUrl(cliServer)}\n`);
  process.stderr.write(`Spec: ${options.spec}\n`);
  if (options.cors) {
    process.stderr.write("CORS: enabled\n");
  }
  if (options.admin) {
    process.stderr.write("Admin: enabled (/schmock-admin/*)\n");
    process.stderr.write(`Admin token: ${options.adminToken}\n`);
    if (!isLoopbackHost(cliServer.hostname)) {
      process.stderr.write(
        `WARNING: the admin API is enabled and bound to ${cliServer.hostname}, which is reachable from other hosts.\n` +
          "WARNING: anyone who can reach this port and the admin token can read recorded requests and reset the mock.\n",
      );
    }
  } else if (options.adminHistoryLimit !== undefined) {
    process.stderr.write(
      "WARNING: --admin-history-limit has no effect without --admin; no history is retained.\n",
    );
  }

  if (options.watch) {
    // The watcher belongs to the server now; `run` only reports it.
    process.stderr.write("Watch: enabled\n");
  }

  // `run` owns the handlers it registers. They stay attached until the close
  // settles — dropping the last listener any earlier would restore the
  // signal's default disposition and let a second Ctrl-C hard-kill the
  // process mid-drain; the `shuttingDown` guard absorbs it instead. The
  // returned promise settles when shutdown finishes, which is what lets
  // `bin.ts`'s `.catch` cover a failing close.
  const graceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  return new Promise<void>((resolveRun, rejectRun) => {
    let shuttingDown = false;
    let repeatReported = false;
    let forceExitAfter = Number.POSITIVE_INFINITY;

    const shutdown = (): void => {
      if (shuttingDown) {
        // `close()` is bounded by the grace window, so one still running past
        // it is wedged (a runtime that cannot drop a stalled connection). A
        // signal then is the user's only way out short of SIGKILL.
        if (Date.now() >= forceExitAfter) {
          process.stderr.write(
            "Shutdown did not finish within the grace window; forcing exit.\n",
          );
          process.exit(1);
          return;
        }
        // The handlers stay attached on purpose (see above), so a repeat
        // Ctrl-C during the grace window used to vanish with no output at all
        // and no way to tell whether it had been received. Reported once, so
        // holding the key down does not bury the shutdown log.
        if (!repeatReported) {
          repeatReported = true;
          process.stderr.write(
            `Shutdown already in progress; waiting for in-flight requests (signal again after ${graceMs} ms to force an exit)...\n`,
          );
        }
        return;
      }
      shuttingDown = true;
      forceExitAfter = Date.now() + graceMs;
      process.stderr.write("\nShutting down...\n");
      const release = (): void => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
      };
      void cliServer.close().then(
        (value) => {
          release();
          resolveRun(value);
        },
        (error: unknown) => {
          release();
          rejectRun(error);
        },
      );
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
