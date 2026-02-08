#!/usr/bin/env bun

/// <reference path="../../../types/schmock.d.ts" />

export type { CliOptions, CliServer } from "./cli.js";
export { createCliServer, parseCliArgs, run } from "./cli.js";

// Run CLI when invoked directly
import { run } from "./cli.js";

void run(process.argv.slice(2));
