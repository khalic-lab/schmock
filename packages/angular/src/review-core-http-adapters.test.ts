// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HttpErrorResponse,
  type HttpHandler,
  HttpParams,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import type * as Schmock from "@schmock/core";
import { schmock } from "@schmock/core";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { type AngularAdapterOptions, createSchmockInterceptor } from "./index";

const passthrough: HttpHandler = {
  handle: vi.fn(() => of(new HttpResponse({ body: "real backend" }))),
};

function intercept(
  mock: Schmock.CallableMockInstance,
  req: HttpRequest<unknown>,
  options: AngularAdapterOptions = {},
) {
  const Interceptor = createSchmockInterceptor(mock, options);
  return firstValueFrom(new Interceptor().intercept(req, passthrough));
}

async function interceptError(
  mock: Schmock.CallableMockInstance,
  req: HttpRequest<unknown>,
  options: AngularAdapterOptions,
): Promise<HttpErrorResponse> {
  try {
    await intercept(mock, req, options);
  } catch (error) {
    if (error instanceof HttpErrorResponse) return error;
    throw error;
  }
  throw new Error("expected an HttpErrorResponse");
}

function throwingMock(): Schmock.CallableMockInstance {
  const mock = schmock();
  const boom = () => {
    throw new Error("boom");
  };
  mock("GET /boom", boom);
  mock("HEAD /boom", boom);
  return mock;
}

describe("Angular in-band errorFormatter output is normalized", () => {
  it("drops the formatted body on a HEAD request", async () => {
    const error = await interceptError(
      throwingMock(),
      new HttpRequest("HEAD", "/boom"),
      { errorFormatter: (e) => ({ message: e.message }) },
    );

    expect(error.status).toBe(500);
    expect(error.error ?? null).toBeNull();
  });

  it("delivers JSON values, not live Date instances", async () => {
    const error = await interceptError(
      throwingMock(),
      new HttpRequest("GET", "/boom"),
      { errorFormatter: () => ({ when: new Date(0) }) },
    );

    expect(error.error).toEqual({ when: "1970-01-01T00:00:00.000Z" });
    expect(error.headers.get("content-type")).toBe("application/json");
  });

  it("falls back to the minimal body when the formatter returns an Error", async () => {
    const error = await interceptError(
      throwingMock(),
      new HttpRequest("GET", "/boom"),
      { errorFormatter: (e) => ({ cause: e }) },
    );

    expect(error.error).toEqual({
      error: "Internal Server Error",
      code: "INTERNAL_ERROR",
    });
  });
});

describe("Angular repeated query keys resolve like the CLI (last wins)", () => {
  function echoMock() {
    const handle = vi.fn(async () => ({ status: 200, body: {}, headers: {} }));
    const mock = { handle, pipe: vi.fn() };
    return { handle, mock: mock as unknown as Schmock.CallableMockInstance };
  }

  function queryOf(handle: ReturnType<typeof echoMock>["handle"]): unknown {
    const options: unknown = handle.mock.calls.at(-1)?.at(2);
    if (typeof options !== "object" || options === null) return undefined;
    return "query" in options ? options.query : undefined;
  }

  it("in the URL string", async () => {
    const { handle, mock } = echoMock();
    await intercept(mock, new HttpRequest("GET", "/echo?tag=a&tag=b"));
    expect(queryOf(handle)).toEqual({ tag: "b" });
  });

  it("in HttpParams", async () => {
    const { handle, mock } = echoMock();
    const params = new HttpParams().append("tag", "a").append("tag", "b");
    await intercept(mock, new HttpRequest("GET", "/echo", null, { params }));
    expect(queryOf(handle)).toEqual({ tag: "b" });
  });

  it("across the URL and HttpParams, in wire order", async () => {
    const { handle, mock } = echoMock();
    const params = new HttpParams().set("tag", "b").set("only", "p");
    await intercept(
      mock,
      new HttpRequest("GET", "/echo?tag=a&page=2", null, { params }),
    );
    expect(queryOf(handle)).toEqual({ tag: "b", page: "2", only: "p" });
  });
});

describe("Angular bundle keeps @schmock/openapi optional", () => {
  it("never emits a literal import of the optional peer", () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    const manifest: unknown = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    );
    const script =
      typeof manifest === "object" &&
      manifest !== null &&
      "scripts" in manifest &&
      typeof manifest.scripts === "object" &&
      manifest.scripts !== null &&
      "build:lib" in manifest.scripts &&
      typeof manifest.scripts["build:lib"] === "string"
        ? manifest.scripts["build:lib"]
        : undefined;
    if (script === undefined) throw new Error("missing build:lib script");

    // Rebuild with the package's own flags, but into a scratch directory.
    const outDir = mkdtempSync(join(tmpdir(), "schmock-angular-bundle-"));
    try {
      const args = script
        .replace(/^bun\s+/, "")
        .replace(/--outdir(?:=|\s+)\S+/, `--outdir=${outDir}`)
        .split(/\s+/);
      const result = spawnSync("bun", args, {
        cwd: packageRoot,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);

      const bundle = readFileSync(join(outDir, "index.js"), "utf8");
      expect(bundle).not.toMatch(/import\(\s*["'`]@schmock\/openapi["'`]\s*\)/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
