#!/usr/bin/env node

import { toError } from "@schmock/core/adapter";
import { run } from "./cli.js";

void run(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`Schmock failed: ${toError(error).message}\n`);
  process.exitCode = 1;
});
