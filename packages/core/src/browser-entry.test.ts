import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as browserEntry from "./index.browser.js";
import * as nodeEntry from "./index.js";

/**
 * `@schmock/core` resolves to `dist/index.browser.js` under the `browser`
 * export condition (#114). That entry exports what `index.ts` does, but its
 * mocks have no HTTP server, so a browser bundle never reaches `node:http`:
 * Bun's browser target inlined about 200 KB of Node polyfills for it.
 */

const packageRoot = resolve(import.meta.dirname, "..");
const browserBuild = join(packageRoot, "dist", "index.browser.js");

/**
 * Bytes a minified Bun browser bundle of an intercept-only app may reach.
 * It measured 47 KB when the split landed, against 251 KB with the polyfills.
 */
const BROWSER_BUNDLE_CEILING = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("browser entry", () => {
  it("exports exactly the names the Node entry exports", () => {
    expect(Object.keys(browserEntry).sort()).toEqual(
      Object.keys(nodeEntry).sort(),
    );
  });

  it("builds mocks whose listen() rejects with SERVER_UNAVAILABLE", async () => {
    const mock = browserEntry.schmock();

    await expect(mock.listen(0)).rejects.toMatchObject({
      name: "SchmockError",
      code: "SERVER_UNAVAILABLE",
    });
    expect(() => mock.close()).not.toThrow();
  });

  it("builds mocks that answer like the Node entry's", async () => {
    const mock = browserEntry.schmock();
    mock("GET /users/:id", ({ params }) => ({ id: params.id }));

    const response = await mock.handle("GET", "/users/7");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: "7" });
    expect(mock.callCount("GET", "/users/7")).toBe(1);
  });

  it("is what the package's browser condition names", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    );
    const root =
      isRecord(manifest) && isRecord(manifest.exports)
        ? manifest.exports["."]
        : undefined;

    expect(root).toMatchObject({
      browser: "./dist/index.browser.js",
      import: "./dist/index.js",
      default: "./dist/index.js",
    });
    // Conditions match in key order: browser has to come before import.
    expect(Object.keys(isRecord(root) ? root : {})).toEqual([
      "types",
      "browser",
      "import",
      "default",
    ]);
  });
});

/** An app that only intercepts fetch, as a browser test setup does. */
const APP_SOURCE = `import { schmock } from "@schmock/core";
const mock = schmock();
mock("GET /users", [{ id: 1 }]);
export const intercept = () => mock.intercept({ baseUrl: "/api" });
export const listen = () => mock.listen(0);
`;

describe.skipIf(!existsSync(browserBuild))("Bun browser bundle", () => {
  let consumerDir: string;
  let bundle: { size: number; path: string; stderr: string };

  beforeAll(() => {
    // Linked by its real directory, not imported by path: the exports map and
    // its browser condition are what is under test.
    consumerDir = mkdtempSync(join(tmpdir(), "schmock-core-browser-"));
    const scope = join(consumerDir, "node_modules", "@schmock");
    mkdirSync(scope, { recursive: true });
    symlinkSync(packageRoot, join(scope, "core"), "dir");
    writeFileSync(join(consumerDir, "app.js"), APP_SOURCE);

    const outfile = join(consumerDir, "bundle.js");
    const result = spawnSync(
      "bun",
      [
        "build",
        "app.js",
        "--target=browser",
        "--minify",
        "--format=esm",
        `--outfile=${outfile}`,
      ],
      { cwd: consumerDir, encoding: "utf8" },
    );
    bundle = {
      size: existsSync(outfile) ? readFileSync(outfile).byteLength : 0,
      path: outfile,
      stderr: `${result.error ?? ""}${result.stderr ?? ""}`,
    };
  }, 60_000);

  afterAll(() => {
    rmSync(consumerDir, { recursive: true, force: true });
  });

  it("stays under the size ceiling", () => {
    expect(bundle.stderr).toBe("");
    expect(bundle.size).toBeGreaterThan(10_000);
    expect(bundle.size).toBeLessThan(BROWSER_BUNDLE_CEILING);
  });

  it("resolves the browser build, whose listen() rejects", async () => {
    const app = (await import(pathToFileURL(bundle.path).href)) as {
      intercept: () => Schmock.InterceptHandle;
      listen: () => Promise<Schmock.ServerInfo>;
    };

    const interception = app.intercept();
    try {
      expect(interception.active).toBe(true);
      await expect(app.listen()).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
    } finally {
      interception.restore();
    }
  });
});
