#!/usr/bin/env node
/**
 * Post-build step for @schmock/core.
 *
 * The source uses an ambient `Schmock` namespace declared in `schmock.d.ts` at
 * the package root. tsc strips the `/// <reference path="../schmock.d.ts" />`
 * directives from emitted `dist/*.d.ts` because the referenced file sits
 * outside `rootDir`. Without intervention, every consumer hits
 * `TS2503: Cannot find namespace 'Schmock'`.
 *
 * Fix: inline the namespace into `dist/index.d.ts` wrapped in `declare global`
 * so it survives `moduleResolution: bundler` (where triple-slash references
 * are not honored across node_modules) and works regardless of which dist file
 * the consumer's compiler loads first. The sibling dist files in this package
 * and downstream `@schmock/*` packages that re-export from `@schmock/core`
 * see the namespace through normal global resolution.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const src = resolve(pkgRoot, "schmock.d.ts");
const indexDts = resolve(pkgRoot, "dist", "index.d.ts");

const marker = "// >>> schmock ambient namespace <<<";
const current = readFileSync(indexDts, "utf8");
if (current.includes(marker)) {
  process.exit(0);
}

const raw = readFileSync(src, "utf8").trimEnd();
// `dist/index.d.ts` is a module (top-level exports), so a plain
// `declare namespace` would be module-local. Wrap in `declare global` to
// expose the namespace program-wide.
const body = raw.replace(/^declare\s+namespace\s+Schmock\b/m, "namespace Schmock");
const block = `${marker}\ndeclare global {\n${body}\n}\n${marker}\n`;

writeFileSync(indexDts, block + current);
