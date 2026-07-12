#!/usr/bin/env node

import { run } from "./cli.js";

void run(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `Schmock failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
