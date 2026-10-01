import { Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliServer, isLoopbackHost, parseCliArgs, run } from "./cli";

const PETSTORE_SPEC = resolve(
  __dirname,
  "../../openapi/src/__fixtures__/petstore-openapi3.json",
);

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

interface RunningCli {
  stderr(): string;
  /** Deliver SIGINT to the handler `run` registered, as the OS would. */
  signal(): void;
  finished: Promise<void>;
}

/**
 * Start `run()` in-process with stderr captured, and wait for the banner.
 * The caller owns shutdown: `signal()` then `await finished`.
 */
async function startRun(args: string[]): Promise<RunningCli> {
  const baseline = process.listeners("SIGINT");
  let stderr = "";
  const stderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  const finished = run(args).finally(() => stderrWrite.mockRestore());
  finished.catch(() => {});

  const deadline = Date.now() + 10_000;
  while (!/Schmock server running on/.test(stderr) && Date.now() < deadline) {
    await sleep(25);
  }
  expect(stderr).toMatch(/Schmock server running on/);
  const added = process
    .listeners("SIGINT")
    .filter((listener) => !baseline.includes(listener));
  expect(added).toHaveLength(1);

  return {
    stderr: () => stderr,
    signal: () => added[0]?.("SIGINT"),
    finished,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── #94: --port and the numeric flags accept decimal digits only ──────────

describe("numeric flag validation", () => {
  it.each([["--port="], ["--port= "]])(
    "rejects an empty %s instead of falling back to 3000",
    (flag) => {
      expect(() => parseCliArgs(["a.json", flag])).toThrow(/Invalid port/);
    },
  );

  it.each([[" "], ["0x1F90"], ["1e3"], ["80.0"], ["+80"]])(
    "rejects --port %j",
    (value) => {
      expect(() => parseCliArgs(["a.json", "--port", value])).toThrow(
        /Invalid port/,
      );
    },
  );

  it("still accepts a plain decimal port, including 0", () => {
    expect(parseCliArgs(["a.json", "--port", "8080"]).port).toBe(8080);
    expect(parseCliArgs(["a.json", "--port", "0"]).port).toBe(0);
  });

  it.each([["0x10"], ["1e2"], ["2.0"]])(
    "rejects --admin-history-limit %j",
    (value) => {
      expect(() =>
        parseCliArgs(["a.json", "--admin", "--admin-history-limit", value]),
      ).toThrow(/admin-history-limit/);
    },
  );

  it.each([["1e3"], ["0x10"], ["+5"]])("rejects --seed-random %j", (value) => {
    expect(() => parseCliArgs(["a.json", "--seed-random", value])).toThrow(
      /seed-random/,
    );
  });

  it("still accepts a negative --seed-random", () => {
    expect(parseCliArgs(["a.json", "--seed-random=-42"]).fakerSeed).toBe(-42);
  });
});

// ── #95: admin-only flags without --admin ─────────────────────────────────

describe("admin-only flags without --admin", () => {
  it("rejects --admin-token when --admin is off", () => {
    expect(() => parseCliArgs(["a.json", "--admin-token", "tok"])).toThrow(
      /--admin-token requires --admin/,
    );
  });

  it("still accepts --admin-token together with --admin", () => {
    expect(
      parseCliArgs(["a.json", "--admin", "--admin-token", "tok"]).adminToken,
    ).toBe("tok");
  });

  it("warns that --admin-history-limit has no effect without --admin", async () => {
    const cli = await startRun([
      "--spec",
      PETSTORE_SPEC,
      "--port",
      "0",
      "--admin-history-limit",
      "10",
    ]);
    cli.signal();
    await cli.finished;
    expect(cli.stderr()).toContain(
      "--admin-history-limit has no effect without --admin",
    );
  });
});

// ── #96: the programmatic admin token is validated too ────────────────────

describe("createCliServer admin token validation", () => {
  it.each([[""], ["   "], ["two words"], ["tok\n"]])(
    "rejects adminToken %j instead of starting a locked admin API",
    async (adminToken) => {
      await expect(
        createCliServer({
          spec: PETSTORE_SPEC,
          port: 0,
          admin: true,
          adminToken,
        }),
      ).rejects.toThrow(/admin token/i);
    },
  );

  it("ignores the token entirely when admin is off", async () => {
    const server = await createCliServer({
      spec: PETSTORE_SPEC,
      port: 0,
      adminToken: "",
      shutdownGraceMs: 100,
    });
    try {
      expect(server.adminToken).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

// ── an authorized request to an unknown admin path ────────────────────────

describe("unknown admin endpoints", () => {
  it.each([
    ["GET", "nope"],
    ["POST", "routes"],
  ])(
    "answers an authorized %s /schmock-admin/%s with a CORS-free 404",
    async (method, endpoint) => {
      const server = await createCliServer({
        spec: PETSTORE_SPEC,
        port: 0,
        admin: true,
        cors: true,
        shutdownGraceMs: 100,
      });
      try {
        const response = await fetch(
          `http://127.0.0.1:${server.port}/schmock-admin/${endpoint}`,
          {
            method,
            headers: { authorization: `Bearer ${server.adminToken}` },
          },
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: "Unknown admin endpoint",
          code: "NOT_FOUND",
        });
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      } finally {
        await server.close();
      }
    },
  );
});

// ── #144: IPv4-mapped loopback is loopback ────────────────────────────────

describe("isLoopbackHost", () => {
  it("treats an IPv4-mapped loopback address as loopback", () => {
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::ffff:127.0.0.1]")).toBe(true);
  });

  it("still treats an IPv4-mapped public address as reachable", () => {
    expect(isLoopbackHost("::ffff:10.0.0.1")).toBe(false);
  });
});

// ── run() keeps its signal handlers until the close settles ─────────────

describe("signal handlers during shutdown", () => {
  it("stay attached while the close drains, so a repeat signal is absorbed", async () => {
    const realClose = Server.prototype.close;
    let wedged:
      | { server: Server; callback?: (error?: Error) => void }
      | undefined;
    vi.spyOn(Server.prototype, "close").mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void,
    ) {
      wedged = { server: this, callback };
      return this;
    });
    const baselineSigterm = process.listeners("SIGTERM");

    const cli = await startRun(["--spec", PETSTORE_SPEC, "--port", "0"]);
    const sigtermHandlers = () =>
      process
        .listeners("SIGTERM")
        .filter((listener) => !baselineSigterm.includes(listener));
    const handler = sigtermHandlers()[0];
    try {
      expect(handler).toBeDefined();
      cli.signal();
      expect(cli.stderr()).toContain("Shutting down...");

      // Detaching now would restore the default disposition, so a second
      // Ctrl-C would kill the process mid-drain.
      expect(process.listeners("SIGINT")).toContain(handler);
      expect(process.listeners("SIGTERM")).toContain(handler);

      // Delivered through the emitter, as the OS would, rather than by
      // calling the captured reference: a detached handler never sees it.
      process.emit("SIGINT", "SIGINT");
      expect(cli.stderr()).toContain("Shutdown already in progress");
    } finally {
      vi.restoreAllMocks();
      if (wedged) realClose.call(wedged.server, wedged.callback);
      await cli.finished;
    }

    // Once the close settles, run releases what it registered.
    expect(process.listeners("SIGINT")).not.toContain(handler);
    expect(process.listeners("SIGTERM")).not.toContain(handler);
  });
});

// ── #93: a wedged close always has an escape hatch ────────────────────────

describe("a repeat signal after the grace window", () => {
  it("forces the process to exit when the close is wedged", async () => {
    const realClose = Server.prototype.close;
    let wedged:
      | { server: Server; callback?: (error?: Error) => void }
      | undefined;
    vi.spyOn(Server.prototype, "close").mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void,
    ) {
      wedged = { server: this, callback };
      return this;
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    const cli = await startRun(["--spec", PETSTORE_SPEC, "--port", "0"]);
    try {
      cli.signal();
      expect(cli.stderr()).toContain("Shutting down...");

      // Inside the grace window a repeat is acknowledged, not fatal.
      cli.signal();
      expect(exit).not.toHaveBeenCalled();

      const start = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(start + 60_000);
      cli.signal();
      expect(exit).toHaveBeenCalledWith(1);
      expect(cli.stderr()).toMatch(/forcing exit/i);
    } finally {
      vi.restoreAllMocks();
      // Release the server the stub kept open so `run` can settle.
      if (wedged) realClose.call(wedged.server, wedged.callback);
      await cli.finished;
    }
  });
});
