import type { FSWatcher } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Watcher failures are not reachable from outside the process: `fs.watch`
 * succeeds for every path a spec can also be read from, and an FSWatcher
 * `error` event needs the OS to lose the file mid-flight. Both paths are
 * therefore driven through a mocked `watch` — everything else in `node:fs`
 * stays real, so spec loading is untouched (asserted by the last test here).
 */
const watchControl = vi.hoisted(() => ({
  failWith: undefined as Error | undefined,
  watchers: [] as FSWatcher[],
}));

/**
 * Lets a test park a reload mid-flight: when `gate` is set, the next
 * `openapi()` call (the reload's spec parse) waits on it before proceeding.
 * The initial server construction runs with the gate unset, so only reloads
 * are affected.
 */
const openapiControl = vi.hoisted(() => ({
  gate: undefined as Promise<void> | undefined,
  parked: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch: typeof actual.watch = ((...args: unknown[]) => {
    if (watchControl.failWith) throw watchControl.failWith;
    const watcher = (actual.watch as unknown as (...a: unknown[]) => FSWatcher)(
      ...args,
    );
    watchControl.watchers.push(watcher);
    return watcher;
  }) as typeof actual.watch;

  return { ...actual, default: { ...actual.default, watch }, watch };
});

vi.mock("@schmock/openapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@schmock/openapi")>();
  const openapi: typeof actual.openapi = async (...args) => {
    if (openapiControl.gate) {
      openapiControl.parked = true;
      await openapiControl.gate;
    }
    return actual.openapi(...args);
  };
  return { ...actual, openapi };
});

const { createCliServer } = await import("./cli");

const PETSTORE_SPEC = resolve(
  __dirname,
  "../../openapi/src/__fixtures__/petstore-openapi3.json",
);

function reserveAvailablePort(): Promise<number> {
  return new Promise((done, fail) => {
    const reservation = createNetServer();
    reservation.once("error", fail);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      if (address === null || typeof address === "string") {
        reservation.close();
        fail(new Error("Expected an IP port reservation"));
        return;
      }
      const { port } = address;
      reservation.close(() => done(port));
    });
  });
}

function expectPortIsFree(port: number): Promise<void> {
  return new Promise<void>((done, fail) => {
    const probe = createNetServer();
    probe.once("error", fail);
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => done());
    });
  });
}

describe("watcher lifecycle", () => {
  let server: Awaited<ReturnType<typeof createCliServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    watchControl.failWith = undefined;
    watchControl.watchers = [];
    openapiControl.gate = undefined;
    openapiControl.parked = false;
  });

  it("leaves no socket bound when the watcher cannot be created", async () => {
    const port = await reserveAvailablePort();
    watchControl.failWith = Object.assign(new Error("ENOSPC: watch failed"), {
      code: "ENOSPC",
    });

    await expect(
      createCliServer({ spec: PETSTORE_SPEC, port, watch: true }),
    ).rejects.toThrow(/watch failed/);

    // The bind happens before the watch, so a naive implementation leaves this
    // port held by a server nobody has a handle to.
    await expectPortIsFree(port);
  });

  it("reports a watcher runtime error instead of crashing", async () => {
    const stderr: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });

    try {
      server = await createCliServer({
        spec: PETSTORE_SPEC,
        port: 0,
        watch: true,
        shutdownGraceMs: 100,
      });
      expect(watchControl.watchers).toHaveLength(1);

      // An unhandled 'error' on an EventEmitter is a process-level throw.
      watchControl.watchers[0]?.emit("error", new Error("EPERM: watch lost"));

      expect(stderr.join("")).toContain("Spec watch error: EPERM: watch lost");
    } finally {
      stderrWrite.mockRestore();
    }

    // Still serving the mock it already had.
    const response = await fetch(`http://127.0.0.1:${server?.port}/pets`);
    expect(response.status).toBe(200);
  });

  it("close() stops accepting and settles within the grace bound while a reload is in flight", async () => {
    const graceMs = 300;
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      watch: true,
      shutdownGraceMs: graceMs,
    });
    const { port } = server;
    expect(watchControl.watchers).toHaveLength(1);

    // Park the next reload inside its spec parse, then trigger it.
    let releaseGate = (): void => {};
    openapiControl.gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    watchControl.watchers[0]?.emit("change", "change", "spec.json");
    await vi.waitFor(() => expect(openapiControl.parked).toBe(true), {
      timeout: 3_000,
    });

    // With the reload still parked, close() must release the socket
    // immediately and settle within the declared bound — not block behind
    // the watcher's drain of the in-flight reload.
    const started = Date.now();
    const closing = server.close();
    server = undefined;
    await expect(fetch(`http://127.0.0.1:${port}/pets`)).rejects.toThrow();

    await closing;
    // Generous slack: pre-fix, this hung until the gate was released.
    expect(Date.now() - started).toBeLessThan(graceMs * 10);

    releaseGate();
  });

  it("still loads specs through the partially mocked fs module", async () => {
    server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      shutdownGraceMs: 100,
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/pets`);
    expect(response.status).toBe(200);
  });
});
