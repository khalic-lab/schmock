import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Bundle size report (`bun run bench:size`).
 *
 * Columns:
 * - Dist JS: bytes of the runtime JavaScript in dist/ as built. Declarations
 *   (.d.ts), declaration maps and source maps are left out.
 * - Min+gz: the package's main entry (the browser build when there is one, see
 *   `mainEntry`) re-bundled with `bun build --minify`, every bare import
 *   external, then gzipped. core ships unminified tsc output while most
 *   packages ship minified bundles, so this is the only column that compares
 *   packages with each other.
 * - Source: .ts/.tsx under src/, without tests, step files, fixtures and
 *   test-utils modules.
 */

const SHIPPED_JS = /\.(?:js|mjs|cjs)$/;
const TEST_SOURCE =
  /(?:\.test|\.spec|\.steps)\.tsx?$|(?:^|\/)test-utils\.tsx?$|(?:^|\/)(?:steps|__tests__|__fixtures__)\//;

interface WorkspacePackage {
  directory: string;
  name: string;
  entry: string | undefined;
}

function walkFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...walkFiles(join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/** Bytes of runtime JavaScript under `dir`; declarations and maps excluded. */
export function distJsSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let size = 0;
  for (const file of walkFiles(dir)) {
    if (SHIPPED_JS.test(file)) size += statSync(join(dir, file)).size;
  }
  return size;
}

/**
 * Bytes of hand-written source under `dir`, without tests, steps, fixtures
 * and test utilities.
 */
export function sourceSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let size = 0;
  for (const file of walkFiles(dir)) {
    if (
      /\.tsx?$/.test(file) &&
      !file.endsWith(".d.ts") &&
      !TEST_SOURCE.test(file)
    ) {
      size += statSync(join(dir, file)).size;
    }
  }
  return size;
}

function readManifest(path: string): Record<string, unknown> {
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new Error(`${path} is not a JSON object`);
  }
  return Object.fromEntries(Object.entries(manifest));
}

/**
 * The built file behind the `.` export's `browser` condition, else its
 * `import` condition, else `default`, if any. For a package with a browser
 * build (openapi) the Min+gz column therefore measures that build, not the
 * Node entry.
 */
function mainEntry(manifest: Record<string, unknown>): string | undefined {
  const exportsField = manifest.exports;
  if (typeof exportsField === "string") return exportsField;
  if (typeof exportsField !== "object" || exportsField === null) {
    return typeof manifest.main === "string" ? manifest.main : undefined;
  }
  const root: unknown = Reflect.get(exportsField, ".");
  if (typeof root === "string") return root;
  if (typeof root !== "object" || root === null) return undefined;
  for (const condition of ["browser", "import", "default"]) {
    const target: unknown = Reflect.get(root, condition);
    if (typeof target === "string") return target;
  }
  return undefined;
}

function discoverPackages(packagesDir: string): WorkspacePackage[] {
  const discovered: WorkspacePackage[] = [];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = readManifest(manifestPath);
    const name = manifest.name;
    if (typeof name !== "string" || !name.startsWith("@schmock/")) {
      throw new Error(`${manifestPath} has no valid @schmock/* package name`);
    }
    discovered.push({
      directory: entry.name,
      name,
      entry: mainEntry(manifest),
    });
  }

  if (discovered.length === 0) {
    throw new Error("No @schmock/* workspace packages found");
  }
  return discovered.sort((left, right) => left.name.localeCompare(right.name));
}

/** Minified, gzipped size of `entryPath` with every bare import external. */
function minifiedGzipSize(entryPath: string): number {
  if (!existsSync(entryPath)) return 0;
  const outDir = mkdtempSync(join(tmpdir(), "schmock-bundle-size-"));
  try {
    const outfile = join(outDir, "bundle.js");
    const result = spawnSync(
      "bun",
      [
        "build",
        entryPath,
        "--minify",
        "--target=browser",
        "--format=esm",
        "--packages=external",
        `--outfile=${outfile}`,
      ],
      { encoding: "utf-8" },
    );
    if (result.status !== 0 || !existsSync(outfile)) {
      throw new Error(`bun build failed for ${entryPath}:\n${result.stderr}`);
    }
    return gzipSync(readFileSync(outfile)).length;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "N/A";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function report(): void {
  const root = join(import.meta.dirname, "..");
  const packagesDir = join(root, "packages");
  const packages = discoverPackages(packagesDir);
  const width = Math.max(
    "Package".length,
    ...packages.map((pkg) => pkg.name.length),
  );

  console.log("Schmock bundle size analysis\n");
  console.log(
    `${"Package".padEnd(width)} |   Dist JS |    Min+gz |     Source`,
  );
  console.log(`${"-".repeat(width)}-|-----------|-----------|-----------`);

  for (const pkg of packages) {
    const pkgDir = join(packagesDir, pkg.directory);
    const distJs = distJsSize(join(pkgDir, "dist"));
    const minGz = pkg.entry ? minifiedGzipSize(join(pkgDir, pkg.entry)) : 0;
    const src = sourceSize(join(pkgDir, "src"));

    console.log(
      `${pkg.name.padEnd(width)} | ${formatSize(distJs).padStart(9)} | ${formatSize(minGz).padStart(9)} | ${formatSize(src).padStart(10)}`,
    );
  }
}

// Run only as `bun run benchmarks/bundle-size.ts`, not when
// review-tooling.steps.ts imports `distJsSize` and `sourceSize`.
if (import.meta.main) {
  report();
}
