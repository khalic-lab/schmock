#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runInit } from "./init.js";

process.exitCode = runInit(process.argv.slice(2), {
  cwd: process.cwd(),
  source: fileURLToPath(new URL("./schmock-sw.js", import.meta.url)),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
