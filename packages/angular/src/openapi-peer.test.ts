// Import Angular compiler FIRST before any other imports
import "@angular/compiler";

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HTTP_INTERCEPTORS,
  type HttpInterceptor,
  HttpRequest,
  HttpResponse,
} from "@angular/common/http";
import type * as Schmock from "@schmock/core";
import { lastValueFrom, of } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A stand-in for `openapi()`: a plugin that registers one route. */
function stubOpenapi() {
  const plugin: Schmock.Plugin = {
    name: "stub-openapi",
    install(instance) {
      instance("GET /pets", [{ id: 1 }]);
    },
    process: (context, response) => ({ context, response }),
  };
  return vi.fn(async (_options: Schmock.OpenApiOptions) => plugin);
}

async function getPets(Interceptor: new () => HttpInterceptor) {
  const event = await lastValueFrom(
    new Interceptor().intercept(new HttpRequest("GET", "/api/pets"), {
      handle: () => of(new HttpResponse({ body: "real backend" })),
    }),
  );
  return event instanceof HttpResponse ? event.body : undefined;
}

describe("the FromSpec helpers take an injected openapi peer (wave-3 #41)", () => {
  afterEach(() => {
    vi.doUnmock("@schmock/openapi");
    vi.resetModules();
  });

  // The runtime import of the peer always fails here, as in a bundled app.
  async function freshHelpersWithoutPeer() {
    vi.resetModules();
    vi.doMock("@schmock/openapi", () => {
      throw new Error("Cannot find package '@schmock/openapi'");
    });
    return import("./index");
  }

  it("builds the interceptor with the injected factory", async () => {
    const { createSchmockInterceptorFromSpec } =
      await freshHelpersWithoutPeer();
    const openapi = stubOpenapi();
    const options = { spec: { openapi: "3.0.3" }, fakerSeed: 7 };

    const Interceptor = await createSchmockInterceptorFromSpec(
      options,
      { baseUrl: "/api" },
      { openapi },
    );

    expect(openapi).toHaveBeenCalledWith(options);
    expect(await getPets(Interceptor)).toEqual([{ id: 1 }]);
  });

  it("provides the interceptor with the injected factory", async () => {
    const { provideSchmockInterceptorFromSpec } =
      await freshHelpersWithoutPeer();

    const provider = await provideSchmockInterceptorFromSpec(
      { spec: {} },
      { baseUrl: "/api" },
      { openapi: stubOpenapi() },
    );

    expect(provider.provide).toBe(HTTP_INTERCEPTORS);
    const interceptor = provider.useFactory();
    const event = await lastValueFrom(
      interceptor.intercept(new HttpRequest("GET", "/api/pets"), {
        handle: () => of(new HttpResponse({ body: "real backend" })),
      }),
    );
    expect(event instanceof HttpResponse && event.body).toEqual([{ id: 1 }]);
  });

  it("still falls back to the runtime import without one", async () => {
    const { createSchmockInterceptorFromSpec } =
      await freshHelpersWithoutPeer();
    await expect(
      createSchmockInterceptorFromSpec({ spec: {} }),
    ).rejects.toMatchObject({ code: "OPENAPI_PEER_UNAVAILABLE" });
  });

  it("rejects a peer that has no openapi() factory", async () => {
    const { createSchmockInterceptorFromSpec } =
      await freshHelpersWithoutPeer();
    const notAPeer = { openapi: "not a factory" } as unknown as Parameters<
      typeof createSchmockInterceptorFromSpec
    >[2];

    await expect(
      createSchmockInterceptorFromSpec({ spec: {} }, {}, notAPeer),
    ).rejects.toMatchObject({
      code: "OPENAPI_PEER_UNAVAILABLE",
      message: "The peer passed to the spec helpers has no openapi() factory",
    });
  });
});

/**
 * What an Angular app bundled for the browser runs: the adapter, Angular and
 * core inlined, and only what the app imports statically. The stub peer is
 * part of the app; `@schmock/openapi` itself is never resolvable at runtime.
 */
const APP_SOURCE = `import "@angular/compiler";
import { HttpRequest, HttpResponse } from "@angular/common/http";
import { lastValueFrom, of } from "rxjs";
import { createSchmockInterceptorFromSpec } from "../src/index.ts";

const plugin = {
  name: "stub-openapi",
  install(instance) {
    instance("GET /pets", [{ id: 1 }]);
  },
  process: (context, response) => ({ context, response }),
};

async function attempt(peer) {
  try {
    const Interceptor = await createSchmockInterceptorFromSpec(
      { spec: {} },
      { baseUrl: "/api" },
      peer,
    );
    const event = await lastValueFrom(
      new Interceptor().intercept(new HttpRequest("GET", "/api/pets"), {
        handle: () => of(new HttpResponse({ body: "real backend" })),
      }),
    );
    return { ok: true, body: event instanceof HttpResponse ? event.body : null };
  } catch (error) {
    return { ok: false, code: error?.code ?? String(error) };
  }
}

console.log(
  JSON.stringify({
    injected: await attempt({ openapi: async () => plugin }),
    runtimeImport: await attempt(undefined),
  }),
);
`;

describe("a bundled app using the injected peer", () => {
  it("serves the spec's routes where the runtime import cannot load", () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    // The entry sits in the package so the bundler resolves Angular, rxjs and
    // core (through the repo's tsconfig paths) as an app's build would. The
    // bundle runs from a directory with no node_modules above it, like a
    // browser with no import map.
    const entryDir = mkdtempSync(join(packageRoot, ".peer-bundle-"));
    const outDir = mkdtempSync(join(tmpdir(), "schmock-angular-peer-"));
    try {
      const entry = join(entryDir, "app.ts");
      const bundle = join(outDir, "app.mjs");
      writeFileSync(entry, APP_SOURCE, "utf8");

      const built = spawnSync(
        "bun",
        [
          "build",
          entry,
          "--target",
          "browser",
          "--format",
          "esm",
          "--outfile",
          bundle,
        ],
        { cwd: packageRoot, encoding: "utf8" },
      );
      expect(built.status, built.stderr).toBe(0);
      // The fallback's computed import is still there, unresolved.
      expect(readFileSync(bundle, "utf8")).toContain(
        '["@schmock", "openapi"].join("/")',
      );

      const ran = spawnSync(process.execPath, [bundle], {
        cwd: outDir,
        encoding: "utf8",
      });
      expect(ran.status, ran.stderr).toBe(0);
      const result: unknown = JSON.parse(
        ran.stdout.trim().split("\n").at(-1) ?? "",
      );

      expect(result).toEqual({
        injected: { ok: true, body: [{ id: 1 }] },
        runtimeImport: { ok: false, code: "OPENAPI_PEER_UNAVAILABLE" },
      });
    } finally {
      rmSync(entryDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
