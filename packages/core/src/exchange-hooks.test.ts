import { describe, expect, it, vi } from "vitest";
import { SchmockError } from "./errors.js";
import {
  assertValidPlugin,
  hasExchangeObserver,
  runExchangeHooks,
} from "./plugin-hooks.js";

const proc = (context: any, response: any) => ({ context, response });

function answeredInput(): any {
  return {
    outcome: "answered",
    request: {
      method: "POST",
      url: "http://localhost/api/users",
      headers: { "content-type": "application/json" },
      body: { name: "Ada" },
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: [{ id: 1, name: "Ada" }],
    },
    startTime: 10,
    endTime: 12.5,
  };
}

function recorder(name: string, seen: any[], order?: string[]): any {
  return {
    name,
    process: proc,
    onExchange(this: unknown, ...args: unknown[]) {
      order?.push(name);
      seen.push({ self: this, args });
    },
  };
}

describe("hasExchangeObserver", () => {
  it("is false for no plugins and for plugins without a function onExchange", () => {
    expect(hasExchangeObserver([])).toBe(false);
    expect(hasExchangeObserver([{ name: "a", process: proc }])).toBe(false);
    expect(
      hasExchangeObserver([
        { name: "a", process: proc, onExchange: null } as any,
      ]),
    ).toBe(false);
    expect(
      hasExchangeObserver([
        { name: "a", process: proc, onExchange: "yes" } as any,
      ]),
    ).toBe(false);
  });

  it("is true when any plugin has a function onExchange", () => {
    expect(
      hasExchangeObserver([
        { name: "a", process: proc },
        { name: "b", process: proc, onExchange: () => {} },
      ]),
    ).toBe(true);
  });
});

describe("runExchangeHooks", () => {
  it("calls observers in order, skips others, one argument, this is the plugin", () => {
    const logger = { log: vi.fn() };
    const order: string[] = [];
    const seenA: any[] = [];
    const seenD: any[] = [];
    const A = recorder("A", seenA, order);
    const D = recorder("D", seenD, order);
    const plugins = [
      A,
      { name: "B", process: proc },
      { name: "C", process: proc, onExchange: null },
      D,
    ];
    runExchangeHooks({ plugins, exchange: answeredInput(), logger });
    expect(order).toEqual(["A", "D"]);
    expect(seenA).toHaveLength(1);
    expect(seenD).toHaveLength(1);
    expect(seenA[0].args).toHaveLength(1);
    expect(seenD[0].args).toHaveLength(1);
    expect(seenA[0].self).toBe(A);
    expect(seenD[0].self).toBe(D);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("gives each observer a distinct, deep-equal snapshot", () => {
    const logger = { log: vi.fn() };
    const seenA: any[] = [];
    const seenD: any[] = [];
    const input = answeredInput();
    runExchangeHooks({
      plugins: [recorder("A", seenA), recorder("D", seenD)],
      exchange: input,
      logger,
    });
    const a = seenA[0].args[0];
    const d = seenD[0].args[0];
    for (const pick of [
      (x: any) => x,
      (x: any) => x.request,
      (x: any) => x.request.headers,
      (x: any) => x.response,
      (x: any) => x.response.headers,
    ]) {
      expect(pick(a)).not.toBe(pick(d));
      expect(pick(a)).not.toBe(pick(input));
      expect(pick(d)).not.toBe(pick(input));
    }
    expect(a).toEqual(input);
    expect(d).toEqual(input);
  });

  it("freezes the snapshot parts for an answered exchange", () => {
    const seen: any[] = [];
    runExchangeHooks({
      plugins: [recorder("A", seen)],
      exchange: answeredInput(),
      logger: { log: vi.fn() },
    });
    const s = seen[0].args[0];
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.request)).toBe(true);
    expect(Object.isFrozen(s.request.headers)).toBe(true);
    expect(Object.isFrozen(s.response)).toBe(true);
    expect(Object.isFrozen(s.response.headers)).toBe(true);
  });

  it("freezes the envelope and request for failed and aborted exchanges", () => {
    const seen: any[] = [];
    const base = answeredInput();
    const failed = {
      outcome: "failed",
      request: base.request,
      error: new Error("x"),
      startTime: 1,
      endTime: 2,
    } as any;
    const aborted = {
      outcome: "aborted",
      request: base.request,
      startTime: 1,
      endTime: 2,
    } as any;
    for (const exchange of [failed, aborted]) {
      runExchangeHooks({
        plugins: [recorder("A", seen)],
        exchange,
        logger: { log: vi.fn() },
      });
    }
    for (const entry of seen) {
      const s = entry.args[0];
      expect(Object.isFrozen(s)).toBe(true);
      expect(Object.isFrozen(s.request)).toBe(true);
      expect(Object.isFrozen(s.request.headers)).toBe(true);
    }
  });

  it("copies header records", () => {
    const seen: any[] = [];
    const input = answeredInput();
    runExchangeHooks({
      plugins: [recorder("A", seen)],
      exchange: input,
      logger: { log: vi.fn() },
    });
    input.request.headers["x-extra"] = "1";
    input.response.headers["x-extra"] = "2";
    const s = seen[0].args[0];
    expect(s.request.headers).toEqual({ "content-type": "application/json" });
    expect(s.response.headers).toEqual({ "content-type": "application/json" });
  });

  it("copies bodies so one observer cannot alter another's or the input", () => {
    const seenD: any[] = [];
    const input = answeredInput();
    const mutator = {
      name: "A",
      process: proc,
      onExchange(s: any) {
        s.request.body.name = "Mallory";
        s.response.body[0].name = "Mallory";
      },
    };
    runExchangeHooks({
      plugins: [mutator, recorder("D", seenD)],
      exchange: input,
      logger: { log: vi.fn() },
    });
    const d = seenD[0].args[0];
    expect(d.request.body.name).toBe("Ada");
    expect(d.response.body[0].name).toBe("Ada");
    expect(input.request.body.name).toBe("Ada");
    expect(input.response.body[0].name).toBe("Ada");
  });

  it("copies a SharedArrayBuffer-backed request body", () => {
    const seen: any[] = [];
    const input = answeredInput();
    const view = new Uint8Array(new SharedArrayBuffer(4));
    view.set([1, 2, 3, 4]);
    input.request.body = view;
    runExchangeHooks({
      plugins: [recorder("A", seen)],
      exchange: input,
      logger: { log: vi.fn() },
    });
    view[0] = 9;
    const body = seen[0].args[0].request.body;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body.buffer instanceof SharedArrayBuffer).toBe(false);
    expect([...body]).toEqual([1, 2, 3, 4]);
  });

  it("hands a FormData request body over as a new FormData", () => {
    const seen: any[] = [];
    const input = answeredInput();
    const form = new FormData();
    form.append("a", "1");
    form.append("b", "2");
    input.request.body = form;
    runExchangeHooks({
      plugins: [recorder("A", seen)],
      exchange: input,
      logger: { log: vi.fn() },
    });
    const copy = seen[0].args[0].request.body;
    expect(copy).toBeInstanceOf(FormData);
    expect(copy).not.toBe(form);
    expect([...copy.entries()]).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    copy.append("c", "3");
    expect([...form.entries()]).toHaveLength(2);
  });

  it("replaces uncloneable bodies with the unavailable placeholder", () => {
    const placeholder = {
      kind: "unavailable",
      reason: "not-structured-cloneable",
      type: "[object Object]",
    };
    const seen: any[] = [];
    const reqInput = answeredInput();
    reqInput.request.body = { fn: () => 1 };
    const resInput = answeredInput();
    resInput.response.body = { fn: () => 1 };
    for (const exchange of [reqInput, resInput]) {
      runExchangeHooks({
        plugins: [recorder("A", seen)],
        exchange,
        logger: { log: vi.fn() },
      });
    }
    expect(seen[0].args[0].request.body).toEqual(placeholder);
    expect(seen[1].args[0].response.body).toEqual(placeholder);
  });

  it("passes a failed exchange's error by identity with exactly its keys", () => {
    const seen: any[] = [];
    const error = new Error("hook failed");
    const input: any = {
      outcome: "failed",
      request: answeredInput().request,
      error,
      startTime: 3,
      endTime: 4,
    };
    runExchangeHooks({
      plugins: [recorder("A", seen)],
      exchange: input,
      logger: { log: vi.fn() },
    });
    const s = seen[0].args[0];
    expect(s.error).toBe(error);
    expect(Object.keys(s).sort()).toEqual([
      "endTime",
      "error",
      "outcome",
      "request",
      "startTime",
    ]);
  });

  it("gives an aborted exchange exactly its keys", () => {
    const seen: any[] = [];
    const input: any = {
      outcome: "aborted",
      request: answeredInput().request,
      startTime: 3,
      endTime: 4,
    };
    runExchangeHooks({
      plugins: [recorder("A", seen)],
      exchange: input,
      logger: { log: vi.fn() },
    });
    expect(Object.keys(seen[0].args[0]).sort()).toEqual([
      "endTime",
      "outcome",
      "request",
      "startTime",
    ]);
  });

  it("copies outcome, startTime and endTime", () => {
    const seen: any[] = [];
    runExchangeHooks({
      plugins: [recorder("A", seen)],
      exchange: answeredInput(),
      logger: { log: vi.fn() },
    });
    const s = seen[0].args[0];
    expect(s.outcome).toBe("answered");
    expect(s.startTime).toBe(10);
    expect(s.endTime).toBe(12.5);
  });

  it("omits undefined bodies and keeps null", () => {
    const seen: any[] = [];
    const noBody = answeredInput();
    delete noBody.request.body;
    delete noBody.response.body;
    const undef = answeredInput();
    undef.request.body = undefined;
    undef.response.body = undefined;
    const nul = answeredInput();
    nul.request.body = null;
    nul.response.body = null;
    for (const exchange of [noBody, undef, nul]) {
      runExchangeHooks({
        plugins: [recorder("A", seen)],
        exchange,
        logger: { log: vi.fn() },
      });
    }
    for (const i of [0, 1]) {
      expect("body" in seen[i].args[0].request).toBe(false);
      expect("body" in seen[i].args[0].response).toBe(false);
    }
    expect(seen[2].args[0].request.body).toBeNull();
    expect(seen[2].args[0].response.body).toBeNull();
  });

  it("logs a sync throw under 'plugin' and still runs the next observer", () => {
    const logger = { log: vi.fn() };
    const seen: any[] = [];
    const thrower = {
      name: "thrower",
      process: proc,
      onExchange() {
        throw new Error("boom");
      },
    };
    let result: unknown = "unset";
    expect(() => {
      result = runExchangeHooks({
        plugins: [thrower, recorder("R", seen)],
        exchange: answeredInput(),
        logger,
      });
    }).not.toThrow();
    expect(result).toBeUndefined();
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      "plugin",
      "Plugin thrower onExchange failed: boom",
    );
    expect(seen).toHaveLength(1);
  });

  it("logs a non-Error throw", () => {
    const logger = { log: vi.fn() };
    const thrower = {
      name: "thrower",
      process: proc,
      onExchange() {
        throw "nope";
      },
    };
    runExchangeHooks({
      plugins: [thrower],
      exchange: answeredInput(),
      logger,
    });
    expect(logger.log).toHaveBeenCalledWith(
      "plugin",
      "Plugin thrower onExchange failed: nope",
    );
  });

  it("logs a rejected promise without an unhandled rejection", async () => {
    const logger = { log: vi.fn() };
    const spy = vi.fn();
    process.on("unhandledRejection", spy);
    try {
      const plugins = [
        {
          name: "async",
          process: proc,
          onExchange: async () => {
            throw new Error("later");
          },
        },
        {
          name: "rej",
          process: proc,
          onExchange: () => Promise.reject(new Error("again")),
        },
        {
          name: "fine",
          process: proc,
          onExchange: () => Promise.resolve(),
        },
      ];
      runExchangeHooks({ plugins, exchange: answeredInput(), logger });
      await new Promise((r) => setTimeout(r, 0));
      expect(logger.log).toHaveBeenCalledWith(
        "plugin",
        "Plugin async onExchange rejected: later",
      );
      expect(logger.log).toHaveBeenCalledWith(
        "plugin",
        "Plugin rej onExchange rejected: again",
      );
      expect(logger.log).toHaveBeenCalledTimes(2);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", spy);
    }
  });

  it("does nothing for plugins without onExchange", () => {
    const logger = { log: vi.fn() };
    runExchangeHooks({
      plugins: [{ name: "a", process: proc }],
      exchange: answeredInput(),
      logger,
    });
    expect(logger.log).not.toHaveBeenCalled();
  });
});

describe("assertValidPlugin onExchange", () => {
  const reason = "onExchange must be a function when set";

  function catchError(plugin: any): any {
    try {
      assertValidPlugin(plugin);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("rejects a truthy non-function onExchange with PLUGIN_INVALID", () => {
    const error = catchError({ name: "bad", process: proc, onExchange: "yes" });
    expect(error).toBeInstanceOf(SchmockError);
    expect(error.code).toBe("PLUGIN_INVALID");
    expect(error.message).toBe(
      `Invalid plugin "bad": onExchange must be a function when set`,
    );
    expect(error.context).toEqual({ plugin: "bad", reason });
  });

  it("rejects object and number onExchange with the same reason", () => {
    for (const value of [{}, 1]) {
      const error = catchError({
        name: "bad",
        process: proc,
        onExchange: value,
      });
      expect(error).toBeInstanceOf(SchmockError);
      expect(error.code).toBe("PLUGIN_INVALID");
      expect(error.context).toEqual({ plugin: "bad", reason });
    }
  });

  it("accepts falsy values and functions", () => {
    for (const value of [null, false, undefined, 0, "", () => {}]) {
      expect(() =>
        assertValidPlugin({
          name: "ok",
          process: proc,
          onExchange: value,
        } as any),
      ).not.toThrow();
    }
  });

  it("checks beforeRequest before onExchange", () => {
    const error = catchError({
      name: "bad",
      process: proc,
      beforeRequest: 1,
      onExchange: 1,
    });
    expect(error).toBeInstanceOf(SchmockError);
    expect(error.context).toEqual({
      plugin: "bad",
      reason: "beforeRequest must be a function when set",
    });
  });
});
