import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "publish.sh");

/**
 * publish.sh is destructive (actually publishes to npm), so we only
 * test argument parsing and script structure, not full execution.
 */

describe("publish.sh", () => {
  const content = readFileSync(SCRIPT, "utf-8");

  it("should be a valid bash script with strict mode", () => {
    expect(content).toContain("#!/usr/bin/env bash");
    expect(content).toContain("set -euo pipefail");
  });

  it("should define the publish_package function", () => {
    expect(content).toContain("publish_package()");
  });

  it("should default target to 'all' when no argument given", () => {
    expect(content).toContain('TARGET="${1:-all}"');
  });

  it("should list all 11 packages in dependency order", () => {
    expect(content).toContain(
      "PACKAGES=(core faker validation query express react vue openapi angular cli schmock)",
    );
    // Packages previously missing from the stale 8-package list.
    for (const pkg of ["react", "vue", "schmock"]) {
      expect(content).toContain(pkg);
    }
  });

  it("should run validation before publishing", () => {
    const validationIdx = content.indexOf("Running validation");
    const publishIdx = content.indexOf("Publishing @schmock");
    expect(validationIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(-1);
    expect(validationIdx).toBeLessThan(publishIdx);
  });

  it("should npm publish with the required leading ./ path and --access public", () => {
    expect(content).toContain('npm publish "./${pkg_dir}" --access public');
  });

  it("should create ONE unified vX.Y.Z release, not per-package releases", () => {
    expect(content).toContain('gh release create "v${VERSION}"');
    // The old per-package tag form must be gone.
    expect(content).not.toContain('${pkg}-v${version}');
  });

  it("should skip packages already published (resumable)", () => {
    expect(content).toContain("is_published");
    expect(content).toContain("already on npm");
  });

  it("should handle unknown package names", () => {
    expect(content).toContain("Unknown package");
  });
});
