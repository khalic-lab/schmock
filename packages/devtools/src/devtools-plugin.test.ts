import { readFileSync } from "node:fs";
import { SchmockError, schmock } from "@schmock/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devtoolsPlugin } from "./index.js";

const USERS = [{ id: 1, name: "Ada" }];

function exchangeAt(url = "http://localhost/api/users") {
  return {
    outcome: "answered" as const,
    request: { method: "GET", url, headers: {} },
    response: { status: 200, headers: {}, body: [{ id: 1, name: "Ada" }] },
    startTime: 100,
    endTime: 103.2,
  };
}

function failedExchange(error: unknown) {
  return {
    outcome: "failed" as const,
    request: { method: "GET", url: "http://localhost/api/users", headers: {} },
    error,
    startTime: 100,
    endTime: 103.2,
  };
}

function abortedExchange() {
  return {
    outcome: "aborted" as const,
    request: { method: "GET", url: "http://localhost/api/users", headers: {} },
    startTime: 100,
    endTime: 103.2,
  };
}

function trackEntries() {
  return performance.getEntriesByType("measure").filter((entry) => {
    const detail: unknown = Reflect.get(entry, "detail");
    if (typeof detail !== "object" || detail === null) return false;
    const devtools: unknown = Reflect.get(detail, "devtools");
    return (
      typeof devtools === "object" &&
      devtools !== null &&
      Reflect.get(devtools, "dataType") === "track-entry"
    );
  });
}

function devtoolsOf(entry: PerformanceEntry): Record<string, unknown> {
  const detail: unknown = Reflect.get(entry, "detail");
  const devtools: unknown =
    typeof detail === "object" && detail !== null
      ? Reflect.get(detail, "devtools")
      : undefined;
  if (typeof devtools !== "object" || devtools === null) {
    throw new Error("expected a devtools detail");
  }
  return Object.fromEntries(Object.entries(devtools));
}

/**
 * Render console format args as a console shows them: `%c` takes an argument
 * and prints nothing, `%s` prints `String(arg)`, leftover arguments follow
 * after a space. Only the format string is scanned, never substituted text.
 */
function renderConsole(args: readonly unknown[]): string {
  const [format, ...rest] = args;
  if (typeof format !== "string") return args.map(String).join(" ");
  const text = format.replace(/%[cs]/g, (directive) => {
    if (rest.length === 0) return directive;
    const arg = rest.shift();
    return directive === "%c" ? "" : String(arg);
  });
  return [text, ...rest.map(String)].join(" ");
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectInvalid(
  options: unknown,
  option: string,
  received: unknown,
  message: string,
) {
  const error = catchError(() => devtoolsPlugin(options as never));
  expect(error).toBeInstanceOf(SchmockError);
  if (!(error instanceof SchmockError)) return;
  expect(error.code).toBe("DEVTOOLS_CONFIG_INVALID");
  expect(error.context).toEqual({ option, received });
  expect(error.message).toBe(message);
}

describe("devtoolsPlugin", () => {
  let groupCollapsed: ReturnType<typeof vi.spyOn>;
  let groupEnd: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  /** The first group title as the console renders it. */
  function firstTitle(): string {
    return renderConsole(groupCollapsed.mock.calls[0]);
  }

  beforeEach(() => {
    groupCollapsed = vi
      .spyOn(console, "groupCollapsed")
      .mockImplementation(() => {});
    groupEnd = vi.spyOn(console, "groupEnd").mockImplementation(() => {});
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    performance.clearMeasures();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns a plugin with exactly name, version, process and onExchange", () => {
    const plugin = devtoolsPlugin();
    expect(Object.keys(plugin).sort()).toEqual([
      "name",
      "onExchange",
      "process",
      "version",
    ]);
    expect(plugin.name).toBe("devtools");
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(plugin.version).toBe(pkg.version);
    const ctx = { path: "/x" };
    const res = { status: 1 };
    const out = Reflect.apply(plugin.process, plugin, [ctx, res]);
    expect(Object.keys(out).sort()).toEqual(["context", "response"]);
    expect(out.context).toBe(ctx);
    expect(out.response).toBe(res);
    expect(devtoolsPlugin()).not.toBe(devtoolsPlugin());
  });

  it("reports to the console and one track entry by default", () => {
    const result = devtoolsPlugin().onExchange?.(exchangeAt());
    expect(result).toBeUndefined();
    expect(groupCollapsed).toHaveBeenCalledTimes(1);
    expect(firstTitle()).toBe(
      "Schmock GET http://localhost/api/users → 200 (3.2 ms)",
    );
    expect(groupCollapsed.mock.calls[0][1]).toContain("background:#188038");
    expect(groupEnd).toHaveBeenCalledTimes(1);
    const entries = trackEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("GET http://localhost/api/users");
    const devtools = devtoolsOf(entries[0]);
    expect(devtools.track).toBe("Schmock");
    expect(devtools.color).toBe("primary");
    expect("trackGroup" in devtools).toBe(false);
  });

  it("honours console: false", () => {
    devtoolsPlugin({ console: false }).onExchange?.(exchangeAt());
    expect(groupCollapsed).not.toHaveBeenCalled();
    expect(trackEntries()).toHaveLength(1);
  });

  it("honours performance: false", () => {
    devtoolsPlugin({ performance: false }).onExchange?.(exchangeAt());
    expect(groupCollapsed).toHaveBeenCalledTimes(1);
    expect(trackEntries()).toHaveLength(0);
  });

  it("honours track and trackGroup", () => {
    devtoolsPlugin({ track: "Users API", trackGroup: "My app" }).onExchange?.(
      exchangeAt(),
    );
    expect(firstTitle()).toMatch(/^Users API GET /);
    const entries = trackEntries();
    expect(entries).toHaveLength(1);
    const devtools = devtoolsOf(entries[0]);
    expect(devtools.track).toBe("Users API");
    expect(devtools.trackGroup).toBe("My app");
  });

  it("reads location.origin at call time for path labels", () => {
    const plugin = devtoolsPlugin();
    vi.stubGlobal("location", new URL("http://localhost/"));
    plugin.onExchange?.(exchangeAt("http://localhost/api/users?page=2"));
    expect(firstTitle()).toBe("Schmock GET /api/users?page=2 → 200 (3.2 ms)");
    expect(trackEntries().map((e) => e.name)).toEqual([
      "GET /api/users?page=2",
    ]);
    vi.unstubAllGlobals();
    groupCollapsed.mockClear();
    plugin.onExchange?.(exchangeAt("http://localhost/api/users?page=2"));
    expect(firstTitle()).toBe(
      "Schmock GET http://localhost/api/users?page=2 → 200 (3.2 ms)",
    );
  });

  it("tolerates a throwing location getter", () => {
    const plugin = devtoolsPlugin();
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(() => plugin.onExchange?.(exchangeAt())).not.toThrow();
      expect(groupCollapsed).toHaveBeenCalledTimes(1);
      expect(firstTitle()).toBe(
        "Schmock GET http://localhost/api/users → 200 (3.2 ms)",
      );
    } finally {
      Reflect.deleteProperty(globalThis, "location");
    }
  });

  it("snapshots options at creation", () => {
    const opts: { track: string; console?: boolean } = { track: "A" };
    const plugin = devtoolsPlugin(opts);
    opts.track = "B";
    opts.console = false;
    plugin.onExchange?.(exchangeAt());
    expect(groupCollapsed).toHaveBeenCalledTimes(1);
    expect(firstTitle()).toMatch(/^A GET /);
  });

  describe("validation", () => {
    it("rejects non-object options", () => {
      expectInvalid(
        null,
        "options",
        null,
        "devtoolsPlugin: options must be an object (received null)",
      );
      expectInvalid(
        5,
        "options",
        5,
        "devtoolsPlugin: options must be an object (received 5)",
      );
      expectInvalid(
        [],
        "options",
        [],
        "devtoolsPlugin: options must be an object (received )",
      );
    });

    it("rejects a non-boolean console", () => {
      expectInvalid(
        { console: "yes" },
        "console",
        "yes",
        'devtoolsPlugin: console must be a boolean (received "yes")',
      );
    });

    it("rejects a non-boolean performance", () => {
      expectInvalid(
        { performance: 1 },
        "performance",
        1,
        "devtoolsPlugin: performance must be a boolean (received 1)",
      );
    });

    it("rejects an empty or non-string track", () => {
      expectInvalid(
        { track: "" },
        "track",
        "",
        'devtoolsPlugin: track must be a non-empty string (received "")',
      );
      expectInvalid(
        { track: 7 },
        "track",
        7,
        "devtoolsPlugin: track must be a non-empty string (received 7)",
      );
    });

    it("rejects an empty or non-string trackGroup", () => {
      expectInvalid(
        { trackGroup: "" },
        "trackGroup",
        "",
        'devtoolsPlugin: trackGroup must be a non-empty string (received "")',
      );
      expectInvalid(
        { trackGroup: 7 },
        "trackGroup",
        7,
        "devtoolsPlugin: trackGroup must be a non-empty string (received 7)",
      );
    });

    it("reports the first failing option in order", () => {
      expectInvalid(
        { console: 1, track: "" },
        "console",
        1,
        "devtoolsPlugin: console must be a boolean (received 1)",
      );
    });

    it("accepts valid options", () => {
      for (const ok of [
        undefined,
        {},
        { console: false, performance: true, track: "X", trackGroup: "G" },
        { trackGroup: undefined },
      ]) {
        expect(() => devtoolsPlugin(ok)).not.toThrow();
        expect(devtoolsPlugin(ok).name).toBe("devtools");
      }
    });
  });

  it("can be piped into schmock()", async () => {
    const mock = schmock();
    expect(() => mock.pipe(devtoolsPlugin())).not.toThrow();
    mock("GET /api/users", USERS);
    const res = await mock.handle("GET", "/api/users");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(USERS);
  });

  it("reports a failed exchange", () => {
    const error = new Error("hook failed");
    devtoolsPlugin().onExchange?.(failedExchange(error));
    expect(firstTitle()).toBe(
      "Schmock GET http://localhost/api/users → failed: hook failed (3.2 ms)",
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toBe(error);
    expect(devtoolsOf(trackEntries()[0]).color).toBe("error");
  });

  it("reports an aborted exchange", () => {
    devtoolsPlugin().onExchange?.(abortedExchange());
    expect(firstTitle().endsWith("→ aborted (3.2 ms)")).toBe(true);
    expect(devtoolsOf(trackEntries()[0]).color).toBe("secondary");
  });
});
