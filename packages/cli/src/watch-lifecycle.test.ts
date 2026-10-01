import type { FSWatcher } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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
  /** Fail only the watch on this directory. */
  failFor: undefined as string | undefined,
  /**
   * Hand out inert watchers that only fire when a test emits on them, so a
   * test that really writes files is not raced by the OS's own events.
   */
  inert: false,
  watchers: [] as FSWatcher[],
  /** The directory each entry of `watchers` watches. */
  directories: [] as string[],
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
  failWith: undefined as Error | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { EventEmitter } = await import("node:events");
  const watch: typeof actual.watch = ((...args: unknown[]) => {
    if (watchControl.failWith) throw watchControl.failWith;
    const directory = String(args[0]);
    if (directory === watchControl.failFor) {
      throw new Error(`EACCES: cannot watch ${directory}`);
    }
    let watcher: FSWatcher;
    if (watchControl.inert) {
      const inert = Object.assign(new EventEmitter(), {
        close: vi.fn(),
        ref: () => inert,
        unref: () => inert,
      });
      const listener = args[1];
      if (typeof listener === "function")
        inert.on("change", listener as (...a: unknown[]) => void);
      watcher = inert as unknown as FSWatcher;
    } else {
      watcher = (actual.watch as unknown as (...a: unknown[]) => FSWatcher)(
        ...args,
      );
    }
    watchControl.watchers.push(watcher);
    watchControl.directories.push(directory);
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
    if (openapiControl.failWith) throw openapiControl.failWith;
    return actual.openapi(...args);
  };
  return { ...actual, openapi };
});

const { createCliServer } = await import("./server");

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
    watchControl.failFor = undefined;
    watchControl.inert = false;
    watchControl.watchers = [];
    watchControl.directories = [];
    openapiControl.gate = undefined;
    openapiControl.parked = false;
    openapiControl.failWith = undefined;
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
    // The watch is on the spec's DIRECTORY, so the event must name the spec
    // itself — a directory event for some other file is filtered out.
    watchControl.watchers[0]?.emit("change", "change", basename(PETSTORE_SPEC));
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

  it("ignores a directory event for an unrelated file", async () => {
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

      watchControl.watchers[0]?.emit("change", "change", "unrelated.txt");
      // Longer than the watcher's 500 ms debounce, so a reload it did schedule
      // would have announced itself by now.
      await new Promise((tick) => setTimeout(tick, 800));

      expect(stderr.join("")).not.toContain("Spec changed, reloading");
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("reloads on a directory event naming the spec", async () => {
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

      watchControl.watchers[0]?.emit(
        "change",
        "rename",
        basename(PETSTORE_SPEC),
      );
      await vi.waitFor(
        () => expect(stderr.join("")).toContain("Spec changed, reloading"),
        { timeout: 3_000 },
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("reloads on schema-like siblings only under --refs-external", async () => {
    const stderr: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
    const reloads = (): number =>
      stderr.join("").split("Spec changed, reloading").length - 1;

    try {
      server = await createCliServer({
        spec: PETSTORE_SPEC,
        port: 0,
        watch: true,
        refsExternal: true,
        shutdownGraceMs: 100,
      });
      expect(watchControl.watchers).toHaveLength(1);
      const watcher = watchControl.watchers[0];

      // The Linux feedback loop: inotify reports every write to a log file
      // the CLI's stderr is redirected to, in the spec's own directory.
      for (const name of [
        "mock.log",
        "unrelated.txt",
        ".DS_Store",
        "schemas.json.swp",
        ".schemas.json.swp",
        "schemas.json~",
        ".#schemas.json",
      ]) {
        watcher?.emit("change", "change", name);
      }
      // Longer than the watcher's 500 ms debounce, so a reload it did
      // schedule would have announced itself by now.
      await new Promise((tick) => setTimeout(tick, 800));
      expect(reloads()).toBe(0);

      watcher?.emit("change", "change", "schemas.YAML");
      await vi.waitFor(() => expect(reloads()).toBe(1), { timeout: 3_000 });
    } finally {
      stderrWrite.mockRestore();
    }
  });

  /**
   * A reload replaces the mock instance; the discarded one must be retired so
   * its plugins' `uninstall` hooks run. Nothing about it is observable from
   * outside — the CLI pipes one plugin and it has no `uninstall` — so the
   * assertion rides on core's debug lifecycle log, which `reset()` emits.
   */
  it("retires the discarded mock after a successful reload", async () => {
    const logged: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation((...a) => {
      logged.push(a.map(String).join(" "));
    });
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      server = await createCliServer({
        spec: PETSTORE_SPEC,
        port: 0,
        watch: true,
        debug: true,
        shutdownGraceMs: 100,
      });
      logged.length = 0;

      watchControl.watchers[0]?.emit(
        "change",
        "change",
        basename(PETSTORE_SPEC),
      );
      await vi.waitFor(
        () =>
          expect(
            logged.filter((line) => line.includes("Mock fully reset")),
          ).toHaveLength(1),
        { timeout: 3_000 },
      );
    } finally {
      stderrWrite.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it("keeps the current mock when a reload fails", async () => {
    const logged: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation((...a) => {
      logged.push(a.map(String).join(" "));
    });
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
        debug: true,
        shutdownGraceMs: 100,
      });
      logged.length = 0;

      // Point the reload at a spec that no longer parses.
      openapiControl.failWith = new Error("spec no longer parses");
      watchControl.watchers[0]?.emit(
        "change",
        "change",
        basename(PETSTORE_SPEC),
      );
      await vi.waitFor(
        () => expect(stderr.join("")).toContain("Reload failed"),
        { timeout: 3_000 },
      );

      expect(
        logged.filter((line) => line.includes("Mock fully reset")),
      ).toHaveLength(0);
    } finally {
      openapiControl.failWith = undefined;
      stderrWrite.mockRestore();
      consoleLog.mockRestore();
    }

    // The mock built at startup is still the one serving.
    const response = await fetch(`http://127.0.0.1:${server?.port}/pets`);
    expect(response.status).toBe(200);
  });

  describe("re-arming after a reload changes the watched directories", () => {
    let seedDir = "";
    let seedPath = "";

    afterEach(() => {
      rmSync(seedDir, { recursive: true, force: true });
    });

    /** A manifest naming `./a/pets.json` (Buddy); `./b/pets.json` is Rex. */
    function writeSeedFixture(): void {
      seedDir = mkdtempSync(join(tmpdir(), "schmock-watch-rearm-"));
      seedPath = join(seedDir, "seed.json");
      for (const [directory, name] of [
        ["a", "Buddy"],
        ["b", "Rex"],
      ] as const) {
        mkdirSync(join(seedDir, directory));
        writeFileSync(
          join(seedDir, directory, "pets.json"),
          JSON.stringify([{ id: 1, name, tag: "dog" }]),
        );
      }
      writeFileSync(seedPath, JSON.stringify({ pets: "./a/pets.json" }));
    }

    function watcherFor(directory: string): FSWatcher {
      const index = watchControl.directories.lastIndexOf(directory);
      const watcher = watchControl.watchers[index];
      if (index < 0 || !watcher) throw new Error(`No watcher for ${directory}`);
      return watcher;
    }

    /** Point the manifest at `./b/pets.json` and report the edit. */
    function moveSeedEntryToB(): void {
      writeFileSync(seedPath, JSON.stringify({ pets: "./b/pets.json" }));
      watcherFor(seedDir).emit("change", "change", "seed.json");
    }

    async function petNames(): Promise<unknown> {
      const response = await fetch(`http://127.0.0.1:${server?.port}/pets`);
      const body: unknown = await response.json();
      return Array.isArray(body)
        ? body.map((pet: { name?: unknown }) => pet.name)
        : body;
    }

    it("watches the new directory, closes the old one and ignores its late events", async () => {
      writeSeedFixture();
      watchControl.inert = true;
      const stderr: string[] = [];
      const stderrWrite = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk) => {
          stderr.push(String(chunk));
          return true;
        });
      const reloads = (): number =>
        stderr.join("").split("Spec changed, reloading").length - 1;

      try {
        server = await createCliServer({
          spec: PETSTORE_SPEC,
          port: 0,
          watch: true,
          seed: seedPath,
          shutdownGraceMs: 100,
        });
        const dirA = join(seedDir, "a");
        const dirB = join(seedDir, "b");
        expect(watchControl.directories).toContain(dirA);
        expect(watchControl.directories).not.toContain(dirB);
        const oldWatcher = watcherFor(dirA);
        expect(await petNames()).toEqual(["Buddy"]);

        moveSeedEntryToB();
        await vi.waitFor(
          () => expect(watchControl.directories).toContain(dirB),
          { timeout: 3_000 },
        );
        expect(oldWatcher.close).toHaveBeenCalled();
        expect(await petNames()).toEqual(["Rex"]);
        expect(reloads()).toBe(1);

        // An event the OS had already queued for the dropped directory.
        oldWatcher.emit("change", "change", "pets.json");
        // Longer than the watcher's 500 ms debounce.
        await new Promise((tick) => setTimeout(tick, 800));
        expect(reloads()).toBe(1);
      } finally {
        stderrWrite.mockRestore();
      }
    });

    it("reports a directory it cannot watch and keeps serving", async () => {
      writeSeedFixture();
      watchControl.inert = true;
      watchControl.failFor = join(seedDir, "b");
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
          seed: seedPath,
          shutdownGraceMs: 100,
        });

        moveSeedEntryToB();
        await vi.waitFor(
          () =>
            expect(stderr.join("")).toContain(
              `Spec watch error: EACCES: cannot watch ${join(seedDir, "b")}`,
            ),
          { timeout: 3_000 },
        );
        expect(stderr.join("")).toContain("Schmock server reloaded on");
      } finally {
        stderrWrite.mockRestore();
      }

      // The reload that could not arm the new watch still went live.
      expect(await petNames()).toEqual(["Rex"]);
    });
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
