import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const USAGE = "Usage: schmock-devtools init <publicDir>\n";

/**
 * Copy the packaged service worker into a project's public directory.
 * Pure of process globals: every path and output sink comes through `io`.
 * Returns the exit code and never throws.
 */
export function runInit(
  argv: readonly string[],
  io: {
    cwd: string;
    source: string;
    stdout(text: string): void;
    stderr(text: string): void;
  },
): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(USAGE);
    return 0;
  }
  const dir = argv[1];
  if (
    !(
      argv.length === 2 &&
      argv[0] === "init" &&
      dir !== undefined &&
      dir !== ""
    )
  ) {
    io.stderr(USAGE);
    return 1;
  }

  const targetDir = resolve(io.cwd, dir);
  const targetFile = join(targetDir, "schmock-sw.js");
  const rel = relative(io.cwd, targetFile);

  if (!existsSync(io.source)) {
    io.stderr(
      `Cannot find the packaged worker at ${io.source}. Reinstall @schmock/devtools.\n`,
    );
    return 1;
  }

  try {
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(io.source, targetFile);
  } catch (error) {
    io.stderr(
      `Could not copy schmock-sw.js to ${rel}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  io.stdout(`Copied schmock-sw.js to ${rel}\n`);
  io.stdout(
    'Next: call "await startServiceWorkerRelay()" from @schmock/devtools before your app renders.\n',
  );
  return 0;
}
