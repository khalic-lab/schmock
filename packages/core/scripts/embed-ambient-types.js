#!/usr/bin/env node
/**
 * Post-build step for @schmock/core.
 *
 * The source uses an ambient `Schmock` namespace declared in `schmock.d.ts` at
 * the package root. tsc strips the `/// <reference path="../schmock.d.ts" />`
 * directives when emitting `dist/*.d.ts` because the referenced file sits
 * outside `rootDir`. The result is a published package whose `.d.ts` files use
 * `Schmock.X` types but have no way to find the namespace declaration — every
 * consumer hits `TS2503: Cannot find namespace 'Schmock'`.
 *
 * Fix: copy `schmock.d.ts` next to the published dist files and prepend a
 * `/// <reference path="./schmock.d.ts" />` directive to `dist/index.d.ts`.
 * The reference is loaded transitively whenever any consumer (including the
 * other @schmock/* packages whose dist also uses `Schmock.X`) imports from
 * `@schmock/core`, making the namespace globally available.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const src = resolve(pkgRoot, "schmock.d.ts");
const distFile = resolve(pkgRoot, "dist", "schmock.d.ts");
const indexDts = resolve(pkgRoot, "dist", "index.d.ts");

copyFileSync(src, distFile);

const directive = '/// <reference path="./schmock.d.ts" />\n';
const current = readFileSync(indexDts, "utf8");
if (!current.startsWith(directive)) {
  writeFileSync(indexDts, directive + current);
}
