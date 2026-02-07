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

  it("should list valid packages", () => {
    expect(content).toContain('VALID_PACKAGES="core schema express angular"');
  });

  it("should run validation before publishing", () => {
    const validationIdx = content.indexOf("Running validation");
    const publishIdx = content.indexOf("Publishing...");
    expect(validationIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(-1);
    expect(validationIdx).toBeLessThan(publishIdx);
  });

  it("should use --access public for npm publish", () => {
    expect(content).toContain("npm publish --access public");
  });

  it("should create GitHub releases", () => {
    expect(content).toContain("gh release create");
  });

  it("should handle unknown package names", () => {
    expect(content).toContain("Unknown package");
  });
});
