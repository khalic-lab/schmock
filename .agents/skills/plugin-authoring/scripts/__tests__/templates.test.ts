import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEMPLATE_DIR = resolve(__dirname, "..", "..", "templates");
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const TEMPLATE_NAMES = [
  "plugin.ts.tmpl",
  "plugin.test.ts.tmpl",
  "plugin.feature.tmpl",
  "plugin.steps.ts.tmpl",
];

const VARIABLES: Record<string, string> = {
  PLUGIN_CAMEL: "cachePlugin",
  PLUGIN_NAME: "cache",
  PLUGIN_PURPOSE: "cache generated responses",
  PLUGIN_TITLE: "Cache",
};

function render(template: string): string {
  let rendered = template;
  for (const [key, value] of Object.entries(VARIABLES)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

function renderTemplate(name: string): string {
  return render(readFileSync(join(TEMPLATE_DIR, name), "utf-8"));
}

describe("plugin authoring templates", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "schmock-plugin-templates-"));
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it("renders every template without unresolved placeholders", () => {
    for (const templateName of TEMPLATE_NAMES) {
      const rendered = render(
        readFileSync(join(TEMPLATE_DIR, templateName), "utf-8"),
      );
      writeFileSync(join(fixture, templateName.replace(".tmpl", "")), rendered);
      expect(rendered).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    }
  });

  it("keeps TypeScript templates free of unsafe any assertions", () => {
    for (const templateName of [
      "plugin.ts.tmpl",
      "plugin.test.ts.tmpl",
      "plugin.steps.ts.tmpl",
    ]) {
      const template = readFileSync(join(TEMPLATE_DIR, templateName), "utf-8");
      expect(template).not.toMatch(/\bas\s+any\b|:\s*any\b|<any>/);
    }
  });

  it("sources plugin versions from package metadata", () => {
    const template = readFileSync(
      join(TEMPLATE_DIR, "plugin.ts.tmpl"),
      "utf-8",
    );
    expect(template).toContain("version as packageVersion");
    expect(template).toContain("version: packageVersion");
    expect(template).not.toContain('version: "1.0.0"');
  });

  it("starts from an observable typed transformation", () => {
    const implementation = readFileSync(
      join(TEMPLATE_DIR, "plugin.ts.tmpl"),
      "utf-8",
    );
    const unitTest = readFileSync(
      join(TEMPLATE_DIR, "plugin.test.ts.tmpl"),
      "utf-8",
    );
    const feature = readFileSync(
      join(TEMPLATE_DIR, "plugin.feature.tmpl"),
      "utf-8",
    );
    const steps = readFileSync(
      join(TEMPLATE_DIR, "plugin.steps.ts.tmpl"),
      "utf-8",
    );

    expect(implementation).toContain('processedBy: "{{PLUGIN_NAME}}"');
    expect(implementation).not.toContain("Options");
    expect(unitTest).toContain('processedBy: "{{PLUGIN_NAME}}"');
    expect(feature).toContain(
      'Then the response body should identify the "{{PLUGIN_NAME}}" plugin',
    );
    expect(steps).toContain("processedBy: pluginName");
    expect(steps).not.toContain("response?.status");
  });

  it("typechecks and tests a rendered plugin package in an isolated fixture", () => {
    mkdirSync(join(fixture, "src", "steps"), { recursive: true });
    mkdirSync(join(fixture, "features"), { recursive: true });
    mkdirSync(join(fixture, "node_modules", "@amiceli"), { recursive: true });

    symlinkSync(
      join(PROJECT_ROOT, "node_modules", "vitest"),
      join(fixture, "node_modules", "vitest"),
    );
    symlinkSync(
      join(PROJECT_ROOT, "node_modules", "@amiceli", "vitest-cucumber"),
      join(fixture, "node_modules", "@amiceli", "vitest-cucumber"),
    );

    writeFileSync(
      join(fixture, "package.json"),
      `${JSON.stringify({ name: "@schmock/cache", version: "3.4.5", type: "module" })}\n`,
    );
    writeFileSync(
      join(fixture, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          noEmit: true,
          types: ["node"],
          typeRoots: [
            join(PROJECT_ROOT, "packages", "core", "node_modules", "@types"),
          ],
          paths: {
            "@schmock/core": [
              join(PROJECT_ROOT, "packages", "core", "src", "index.ts"),
            ],
          },
        },
        include: ["src/**/*.ts"],
      })}\n`,
    );
    writeFileSync(
      join(fixture, "src", "cache.ts"),
      renderTemplate("plugin.ts.tmpl"),
    );
    writeFileSync(
      join(fixture, "src", "cache.test.ts"),
      renderTemplate("plugin.test.ts.tmpl"),
    );
    writeFileSync(
      join(fixture, "src", "steps", "cache.steps.ts"),
      renderTemplate("plugin.steps.ts.tmpl"),
    );
    writeFileSync(
      join(fixture, "features", "cache-plugin.feature"),
      renderTemplate("plugin.feature.tmpl"),
    );

    const result = spawnSync(
      "bun",
      [
        join(PROJECT_ROOT, "node_modules", "typescript", "bin", "tsc"),
        "--project",
        join(fixture, "tsconfig.json"),
      ],
      { cwd: fixture, encoding: "utf-8" },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0) throw new Error(output);

    const testResult = spawnSync(
      "bun",
      [
        join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--root",
        fixture,
        "src/cache.test.ts",
      ],
      { cwd: fixture, encoding: "utf-8" },
    );
    const testOutput = `${testResult.stdout ?? ""}${testResult.stderr ?? ""}`;
    if (testResult.status !== 0) throw new Error(testOutput);
  });
});
