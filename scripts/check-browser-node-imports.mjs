#!/usr/bin/env node
/**
 * Fail when a browser bundle still imports a Node built-in that is not on the
 * allowlist.
 *
 *   node scripts/check-browser-node-imports.mjs --allow node:http meta.json [...]
 *
 * Each argument after the options is an esbuild metafile (`--metafile=`). The
 * bundle must be built with `--platform=browser --external:node:*`, so every
 * surviving `node:` import is listed in the metafile as an external rather
 * than failing the build or being inlined.
 *
 * Reading the metafile is the point. Scanning the bundle's text for `"node:`
 * sees nothing when the bundler inlines a polyfill (Bun's browser target does
 * that for every `node:` built-in and leaves only an unquoted `// node:util`
 * comment behind).
 *
 * `node:http` is allowlisted by the release gate on purpose: it is core's
 * `listen()`, imported lazily on a branch a browser never takes (#395).
 */
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const USAGE =
  "Usage: check-browser-node-imports.mjs [--allow <specifier>]... <metafile>...";

function parseArgs(argv) {
  const allowed = new Set();
  const metafiles = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow") {
      const value = argv[++i];
      if (value === undefined) throw new Error(USAGE);
      allowed.add(value);
    } else if (arg.startsWith("--allow=")) {
      allowed.add(arg.slice("--allow=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}\n${USAGE}`);
    } else {
      metafiles.push(arg);
    }
  }
  if (metafiles.length === 0) throw new Error(USAGE);
  return { allowed, metafiles };
}

const BARE_BUILTINS = new Set(
  builtinModules.filter((name) => !name.startsWith("_")),
);

function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  return (
    BARE_BUILTINS.has(specifier.split("/")[0]) || BARE_BUILTINS.has(specifier)
  );
}

/** Every external Node built-in the bundle described by `metafile` imports. */
function nodeImports(metafile) {
  const found = new Set();
  const outputs = metafile?.outputs;
  if (typeof outputs !== "object" || outputs === null) {
    throw new Error("not an esbuild metafile: no outputs");
  }
  for (const output of Object.values(outputs)) {
    for (const imported of output?.imports ?? []) {
      if (imported?.external === true && isNodeBuiltin(imported.path)) {
        found.add(imported.path);
      }
    }
  }
  return [...found].sort();
}

function main() {
  const { allowed, metafiles } = parseArgs(process.argv.slice(2));
  const failures = [];
  for (const path of metafiles) {
    const imports = nodeImports(JSON.parse(readFileSync(path, "utf8")));
    const unexpected = imports.filter((specifier) => !allowed.has(specifier));
    if (unexpected.length > 0) {
      failures.push(`${path}: ${unexpected.join(", ")}`);
    } else {
      console.log(
        `${path}: Node imports ${imports.length === 0 ? "none" : imports.join(", ")} (allowed)`,
      );
    }
  }
  if (failures.length > 0) {
    console.error(
      `Browser bundle imports Node built-ins outside the allowlist [${[...allowed].join(", ")}]:\n  ${failures.join("\n  ")}`,
    );
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
