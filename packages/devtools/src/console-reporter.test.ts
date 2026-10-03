import { afterEach, describe, expect, it, vi } from "vitest";
import { logExchange, TONE_STYLES } from "./console-reporter.js";
import type { ExchangeSummary } from "./types.js";

type Call = [string, ...unknown[]];

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

function fakeSink() {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const sink = {
    groupCollapsed: vi.fn(record("groupCollapsed")),
    log: vi.fn(record("log")),
    error: vi.fn(record("error")),
    groupEnd: vi.fn(record("groupEnd")),
  };
  return { calls, sink };
}

const requestHeaders = { "content-type": "application/json" };
const responseHeaders = { "content-type": "application/json" };
const responseBody = [{ id: 1, name: "Ada" }];

function request(extra: { body?: unknown } = {}) {
  return {
    method: "GET",
    url: "http://localhost/api/users?page=2",
    headers: requestHeaders,
    ...extra,
  };
}

function answered(
  extra: { body?: unknown } = {},
  responseExtra: { body?: unknown } = { body: responseBody },
) {
  return {
    outcome: "answered" as const,
    request: request(extra),
    response: { status: 200, headers: responseHeaders, ...responseExtra },
    startTime: 10,
    endTime: 11.4,
  };
}

const successSummary: ExchangeSummary = {
  name: "GET /api/users?page=2",
  outcome: "200",
  duration: "1.4 ms",
  tone: "success",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logExchange", () => {
  it("logs an answered exchange as group, Request, Response, groupEnd", () => {
    const { calls, sink } = fakeSink();
    const exchange = answered();
    logExchange(exchange, successSummary, "Schmock", sink);
    expect(calls).toEqual([
      [
        "groupCollapsed",
        "%c%s%c %s",
        TONE_STYLES.success,
        "Schmock",
        "",
        "GET /api/users?page=2 → 200 (1.4 ms)",
      ],
      [
        "log",
        "Request",
        {
          method: "GET",
          url: "http://localhost/api/users?page=2",
          headers: requestHeaders,
        },
      ],
      [
        "log",
        "Response",
        { status: 200, headers: responseHeaders, body: responseBody },
      ],
      ["groupEnd"],
    ]);
    expect(renderConsole(calls[0].slice(1))).toBe(
      "Schmock GET /api/users?page=2 → 200 (1.4 ms)",
    );
    const requestArg = calls[1][2] as { headers: unknown };
    const responseArg = calls[2][2] as { body: unknown };
    expect(requestArg.headers).toBe(exchange.request.headers);
    expect(responseArg.body).toBe(exchange.response.body);
  });

  it("logs a failed exchange with the error object by identity", () => {
    const { calls, sink } = fakeSink();
    const error = new Error("hook failed");
    const exchange = {
      outcome: "failed" as const,
      request: request(),
      error,
      startTime: 10,
      endTime: 13.2,
    };
    const summary: ExchangeSummary = {
      name: "GET /api/users?page=2",
      outcome: "failed: hook failed",
      duration: "3.2 ms",
      tone: "failed",
    };
    logExchange(exchange, summary, "Schmock", sink);
    expect(calls.map((c) => c[0])).toEqual([
      "groupCollapsed",
      "log",
      "error",
      "groupEnd",
    ]);
    expect(calls[0][2]).toBe(TONE_STYLES.failed);
    expect(calls[1][1]).toBe("Request");
    expect(calls[2]).toHaveLength(2);
    expect(calls[2][1]).toBe(error);
  });

  it("logs an aborted exchange with the abort line", () => {
    const { calls, sink } = fakeSink();
    const exchange = {
      outcome: "aborted" as const,
      request: request(),
      startTime: 10,
      endTime: 12,
    };
    const summary: ExchangeSummary = {
      name: "GET /api/users?page=2",
      outcome: "aborted",
      duration: "2.0 ms",
      tone: "aborted",
    };
    logExchange(exchange, summary, "Schmock", sink);
    expect(calls.map((c) => c[0])).toEqual([
      "groupCollapsed",
      "log",
      "log",
      "groupEnd",
    ]);
    expect(calls[0][2]).toBe(TONE_STYLES.aborted);
    expect(calls[1][1]).toBe("Request");
    expect(calls[2]).toEqual(["log", "Aborted by the client"]);
  });

  it("omits body keys when undefined and keeps null and values", () => {
    const first = fakeSink();
    logExchange(answered({}, {}), successSummary, "Schmock", first.sink);
    const reqObj = first.calls[1][2] as object;
    const resObj = first.calls[2][2] as object;
    expect(Object.keys(reqObj).sort()).toEqual(["headers", "method", "url"]);
    expect(Object.keys(resObj).sort()).toEqual(["headers", "status"]);

    const body = { name: "Ada" };
    const second = fakeSink();
    logExchange(
      answered({ body }, { body: null }),
      successSummary,
      "Schmock",
      second.sink,
    );
    const reqWith = second.calls[1][2] as { body: unknown };
    const resWith = second.calls[2][2] as { body: unknown };
    expect("body" in reqWith).toBe(true);
    expect(reqWith.body).toBe(body);
    expect("body" in resWith).toBe(true);
    expect(resWith.body).toBeNull();
  });

  it("ends the group and rethrows when a log call throws", () => {
    const { calls, sink } = fakeSink();
    const logError = new Error("log broke");
    sink.log.mockImplementation((label: unknown) => {
      if (label === "Request") throw logError;
    });
    let thrown: unknown;
    try {
      logExchange(answered(), successSummary, "Schmock", sink);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(logError);
    expect(sink.groupEnd).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c[0])).toEqual(["groupCollapsed", "groupEnd"]);
  });

  it("propagates a throwing groupCollapsed without touching the rest", () => {
    const { sink } = fakeSink();
    const openError = new Error("open broke");
    sink.groupCollapsed.mockImplementation(() => {
      throw openError;
    });
    let thrown: unknown;
    try {
      logExchange(answered(), successSummary, "Schmock", sink);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(openError);
    expect(sink.log).not.toHaveBeenCalled();
    expect(sink.error).not.toHaveBeenCalled();
    expect(sink.groupEnd).not.toHaveBeenCalled();
  });

  it("calls sink methods as methods of the sink", () => {
    const contexts: unknown[] = [];
    const sink = {
      groupCollapsed(this: unknown) {
        contexts.push(this);
      },
      log(this: unknown) {
        contexts.push(this);
      },
      error(this: unknown) {
        contexts.push(this);
      },
      groupEnd(this: unknown) {
        contexts.push(this);
      },
    };
    logExchange(answered(), successSummary, "Schmock", sink);
    expect(contexts).toHaveLength(4);
    for (const context of contexts) expect(context).toBe(sink);
  });

  it("uses the label in the title", () => {
    const { sink } = fakeSink();
    logExchange(answered(), successSummary, "Users API", sink);
    const args = sink.groupCollapsed.mock.calls[0];
    expect(args.slice(0, 3)).toEqual([
      "%c%s%c %s",
      TONE_STYLES.success,
      "Users API",
    ]);
    expect(renderConsole(args)).toBe(
      "Users API GET /api/users?page=2 → 200 (1.4 ms)",
    );
  });

  it("renders % directives in the label, name and outcome literally", () => {
    const { sink } = fakeSink();
    const exchange = {
      outcome: "failed" as const,
      request: request(),
      error: new Error("bad %o"),
      startTime: 10,
      endTime: 11,
    };
    const summary: ExchangeSummary = {
      name: "GET /x?q=%cA%d0",
      outcome: "failed: bad %o",
      duration: "1.0 ms",
      tone: "failed",
    };
    logExchange(exchange, summary, "API %s", sink);
    const args = sink.groupCollapsed.mock.calls[0];
    expect(args[0]).toBe("%c%s%c %s");
    expect(renderConsole(args)).toBe(
      "API %s GET /x?q=%cA%d0 → failed: bad %o (1.0 ms)",
    );
  });

  it("defaults the sink to console", () => {
    const group = vi
      .spyOn(console, "groupCollapsed")
      .mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const end = vi.spyOn(console, "groupEnd").mockImplementation(() => {});
    logExchange(answered(), successSummary, "Schmock");
    expect(group).toHaveBeenCalledTimes(1);
    expect(group).toHaveBeenCalledWith(
      "%c%s%c %s",
      TONE_STYLES.success,
      "Schmock",
      "",
      "GET /api/users?page=2 → 200 (1.4 ms)",
    );
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("TONE_STYLES", () => {
  it("holds the exact five styles and is frozen", () => {
    expect(TONE_STYLES).toEqual({
      success: "color:#fff;background:#188038;padding:0 4px;border-radius:3px",
      "client-error":
        "color:#fff;background:#b06000;padding:0 4px;border-radius:3px",
      "server-error":
        "color:#fff;background:#c5221f;padding:0 4px;border-radius:3px",
      failed: "color:#fff;background:#c5221f;padding:0 4px;border-radius:3px",
      aborted: "color:#fff;background:#5f6368;padding:0 4px;border-radius:3px",
    });
    expect(Object.isFrozen(TONE_STYLES)).toBe(true);
  });
});
