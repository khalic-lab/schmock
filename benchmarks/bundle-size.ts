import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const packagesDir = join(root, "packages");
const packages = discoverPackages();
const packageColumnWidth = Math.max(
  "Package".length,
  ...packages.map((pkg) => pkg.name.length),
);

console.log("Schmock bundle size analysis\n");
console.log(
  `${"Package".padEnd(packageColumnWidth)} | Dist Size | Source Size`,
);
console.log(`${"-".repeat(packageColumnWidth)}-|-----------|------------`);

for (const pkg of packages) {
  const distDir = join(packagesDir, pkg.directory, "dist");
  const srcDir = join(packagesDir, pkg.directory, "src");

  const distSize = existsSync(distDir) ? getDirSize(distDir) : 0;
  const srcSize = existsSync(srcDir) ? getDirSize(srcDir) : 0;

  console.log(
    `${pkg.name.padEnd(packageColumnWidth)} | ${formatSize(distSize).padStart(9)} | ${formatSize(srcSize).padStart(10)}`,
  );
}

interface WorkspacePackage {
  directory: string;
  name: string;
}

function discoverPackages(): WorkspacePackage[] {
  const discovered: WorkspacePackage[] = [];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;

    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("name" in manifest) ||
      typeof manifest.name !== "string" ||
      !manifest.name.startsWith("@schmock/")
    ) {
      throw new Error(`${manifestPath} has no valid @schmock/* package name`);
    }
    discovered.push({ directory: entry.name, name: manifest.name });
  }

  if (discovered.length === 0) {
    throw new Error("No @schmock/* workspace packages found");
  }
  return discovered.sort((left, right) => left.name.localeCompare(right.name));
}

function getDirSize(dir: string): number {
  let size = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
      continue;
    }
    if (entry.isFile()) {
      size += statSync(fullPath).size;
    }
  }
  return size;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "N/A";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
