import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const packages = ["core", "schema", "express", "angular", "validation", "query"];
const root = join(import.meta.dirname, "..");

console.log("Schmock bundle size analysis\n");
console.log("Package                 | Dist Size | Source Size");
console.log("------------------------|-----------|------------");

for (const pkg of packages) {
  const distDir = join(root, "packages", pkg, "dist");
  const srcDir = join(root, "packages", pkg, "src");

  const distSize = existsSync(distDir) ? getDirSize(distDir) : 0;
  const srcSize = existsSync(srcDir) ? getDirSize(srcDir) : 0;

  console.log(
    `@schmock/${pkg.padEnd(18)} | ${formatSize(distSize).padStart(9)} | ${formatSize(srcSize).padStart(10)}`,
  );
}

function getDirSize(dir: string): number {
  const { readdirSync } = require("node:fs");
  let size = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const fullPath = join(entry.parentPath ?? entry.path, entry.name);
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
