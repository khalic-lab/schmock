import type { FSWatcher } from "node:fs";
import { realpathSync, watch } from "node:fs";
import { basename, dirname, relative, resolve as resolvePath } from "node:path";
import type * as Schmock from "@schmock/core";
import { loadSeedFile } from "./seed-manifest.js";
import type { CliOptions } from "./types.js";

const WATCH_DEBOUNCE_MS = 500;

/**
 * The one mutable cell a reload writes to. The socket, the admin token and the
 * request handler all outlive it, so swapping the mock is the entire reload.
 */
export interface MockHolder {
  mock: Schmock.CallableMockInstance;
}

export interface WatchHandle {
  /** Resolves once the watcher is shut and any in-flight reload has settled. */
  close(): Promise<void>;
}

interface ReloadInput {
  readonly holder: MockHolder;
  /** Build a replacement mock from the files as they are now. */
  readonly rebuild: () => Promise<Schmock.CallableMockInstance>;
}

export interface WatchInput extends ReloadInput {
  /** The spec, `--seed` and `--refs-external` decide what is watched. */
  readonly options: CliOptions;
  /** Where the server listens, for the reload banner. */
  readonly url: string;
}

/**
 * Build the replacement mock first and only then publish it. A spec that no
 * longer parses therefore leaves the running mock untouched, and because the
 * socket is never involved there is no window in which the port is unbound.
 */
async function reloadMock({ holder, rebuild }: ReloadInput): Promise<void> {
  const previous = holder.mock;
  holder.mock = await rebuild();
  // Retire the instance nothing will use again, so its plugins' `uninstall`
  // hooks actually run — a reload used to drop it on the floor. Order matters
  // twice: resetting BEFORE the swap would blank the live mock, and a
  // `rebuild` that threw must leave the old mock serving (the "invalid spec
  // changes keep the current server online" contract), which the `await`
  // above guarantees by never reaching this line.
  //
  // In-flight requests are safe: every request path acquires a core admission
  // first, and an admission snapshots routes, plugins, state and the history
  // generation, so it keeps serving from its snapshot while core defers the
  // uninstall until the last admission releases.
  try {
    previous.reset();
  } catch {
    // Core already logs a per-plugin uninstall failure. A discarded instance
    // failing to tidy up must not fail the reload that already succeeded.
  }
}

/**
 * What one directory watch reacts to: the named entries in it and, for the
 * spec's directory when `$ref`s may point at sibling files, any schema-like
 * sibling ({@link isSchemaSibling}).
 */
interface WatchMatcher {
  readonly names: ReadonlySet<string>;
  readonly schemaSiblings: boolean;
}

/** The extensions a `$ref`'d sibling schema file can have. */
const SCHEMA_EXTENSION = /\.(?:json|ya?ml)$/i;

/**
 * Whether a sibling of the spec may be a `$ref`'d schema file: a `.json`,
 * `.yaml` or `.yml` file that is not hidden. Editor swap and backup files
 * (`schemas.json.swp`, `schemas.json~`) fail the extension test, and a hidden
 * one (`.schemas.json.swp`, emacs' `.#schemas.json`) the leading dot. Every
 * other write in the spec's directory is ignored even under
 * `--refs-external`, so a log file the CLI's own output is redirected to
 * cannot feed back into an endless reload loop, and `.DS_Store` or a swap
 * file does not throw away CRUD state.
 */
function isSchemaSibling(name: string): boolean {
  return SCHEMA_EXTENSION.test(name) && !name.startsWith(".");
}

/**
 * The file entries a `--seed` manifest names, as `loadSeedFile` resolves them.
 * A manifest that does not load yields none: the reload reports its own error,
 * and the manifest itself stays watched so fixing it triggers the next reload.
 */
function seedEntryFiles(seedPath: string): string[] {
  try {
    return Object.values(loadSeedFile(seedPath)).filter(
      (source): source is string => typeof source === "string",
    );
  } catch {
    return [];
  }
}

function realDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

/**
 * Every file a reload reads, grouped by the directory to watch it through:
 * the spec, the `--seed` manifest and each file entry it names. With
 * `--refs-external` every schema-like sibling of the spec counts too, because
 * a `$ref`'d sibling schema file is part of the contract. A `$ref` target in
 * another directory is still not watched: the openapi plugin does not report
 * which files it resolved.
 */
function collectWatchTargets(options: CliOptions): Map<string, WatchMatcher> {
  const targets = new Map<
    string,
    { names: Set<string>; schemaSiblings: boolean }
  >();
  const matcherFor = (directory: string) => {
    let matcher = targets.get(directory);
    if (!matcher) {
      matcher = { names: new Set(), schemaSiblings: false };
      targets.set(directory, matcher);
    }
    return matcher;
  };
  const addFile = (path: string): void => {
    matcherFor(dirname(path)).names.add(basename(path));
  };

  const resolvedSpec = resolvePath(options.spec);
  addFile(resolvedSpec);
  if (options.refsExternal) {
    matcherFor(dirname(resolvedSpec)).schemaSiblings = true;
  }

  if (options.seed !== undefined) {
    const manifest = resolvePath(options.seed);
    const manifestDirectory = dirname(manifest);
    addFile(manifest);
    const realManifestDirectory = realDirectory(manifestDirectory);
    for (const entry of seedEntryFiles(options.seed)) {
      // Entries come back realpath'd. Re-anchoring them on the manifest
      // directory as the user named it keeps one directory from being watched
      // twice under two spellings (macOS `/var` vs `/private/var`).
      addFile(
        resolvePath(manifestDirectory, relative(realManifestDirectory, entry)),
      );
    }
  }
  return targets;
}

/**
 * Some platforms report an in-place write under the watched DIRECTORY's own
 * name rather than the file's, so that spelling counts as ours too. A null
 * filename is likewise treated as possibly-ours — the debounce absorbs the
 * duplicate — while a named unrelated sibling is skipped so an unrelated write
 * in a watched directory does not rebuild the mock.
 */
function matchesWatchTarget(
  matcher: WatchMatcher,
  directory: string,
  filename: string | Buffer | null,
): boolean {
  if (filename == null) return true;
  const name = basename(filename.toString());
  return (
    matcher.names.has(name) ||
    name === basename(directory) ||
    (matcher.schemaSiblings && isSchemaSibling(name))
  );
}

/**
 * Watch the spec (and everything else a reload reads) and hot-swap the mock
 * behind the live server on changes.
 *
 * The watch is on each file's DIRECTORY, not the file itself. `fs.watch` on a
 * file follows its inode, so the first atomic editor save — write a sibling
 * temp file, rename it over the target, which is what vim, JetBrains and VS
 * Code all do — leaves the watcher bound to the replaced inode and silently
 * deaf to every later edit. A directory watch sees the rename, keeps seeing
 * later in-place writes, and re-arms for free when a file is deleted and
 * recreated. It is non-recursive, so a large tree under a watched directory
 * costs nothing. One watcher serves each directory, and the set is re-derived
 * after every reload so a seed manifest that names new files is followed.
 *
 * Paths are resolved with `resolve`, deliberately NOT `realpathSync`: a
 * symlinked spec must keep watching the directory the user actually named.
 * (Consequence: an editor saving the symlink's TARGET, in another directory,
 * fires no event. Watching the target instead would break the far commoner
 * case of a linked spec edited in place.)
 */
export function startWatch(input: WatchInput): WatchHandle {
  const { options, url } = input;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let reloadQueue = Promise.resolve();
  let targets = collectWatchTargets(options);
  const watchers = new Map<string, FSWatcher>();

  const reportWatchError = (error: unknown): void => {
    process.stderr.write(
      `Spec watch error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  };

  const closeWatchers = (): void => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };

  // Follow a changed file set: drop directories no longer needed and watch
  // new ones. A directory that cannot be watched is reported, not fatal — the
  // server keeps serving and the other watches keep working.
  const rearm = (): void => {
    if (closed) return;
    targets = collectWatchTargets(options);
    for (const [directory, watcher] of watchers) {
      if (targets.has(directory)) continue;
      watcher.close();
      watchers.delete(directory);
    }
    for (const directory of targets.keys()) {
      if (watchers.has(directory)) continue;
      try {
        watchers.set(directory, watchDirectory(directory));
      } catch (error) {
        reportWatchError(error);
      }
    }
  };

  const scheduleReload = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      reloadQueue = reloadQueue.then(async () => {
        if (closed) return;
        process.stderr.write("\nSpec changed, reloading...\n");
        try {
          await reloadMock(input);
          if (closed) return;
          // A reload builds a fresh mock, so CRUD rows created since startup
          // and the admin history are gone; `--seed` data is re-applied.
          process.stderr.write(
            `Schmock server reloaded on ${url} (state and request history reset)\n`,
          );
        } catch (err) {
          if (closed) return;
          process.stderr.write(
            `Reload failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        rearm();
      });
    }, WATCH_DEBOUNCE_MS);
  };

  function watchDirectory(directory: string): FSWatcher {
    const watcher = watch(directory, (_event, filename) => {
      if (closed) return;
      const matcher = targets.get(directory);
      if (matcher === undefined) return;
      if (!matchesWatchTarget(matcher, directory, filename)) return;
      scheduleReload();
    });
    // An unhandled 'error' event (the directory unmounted, an unlink race)
    // would take the whole process down; watching is a convenience, so it is
    // reported and the server keeps serving the mock it already has.
    watcher.on("error", reportWatchError);
    return watcher;
  }

  try {
    for (const directory of targets.keys()) {
      watchers.set(directory, watchDirectory(directory));
    }
  } catch (error) {
    // The caller releases the socket; the watches already made go too.
    closeWatchers();
    throw error;
  }

  return {
    async close() {
      closed = true;
      closeWatchers();
      if (debounceTimer) clearTimeout(debounceTimer);
      // A reload already parsing must be awaited: otherwise it would swap the
      // mock, or write to stderr, after shutdown has reported itself complete.
      await reloadQueue;
    },
  };
}
