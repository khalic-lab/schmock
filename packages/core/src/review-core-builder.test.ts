import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { awaitWithAbort } from "./abort";
import { CallableMockInstance } from "./builder";
import { canonicalizePath } from "./constants";
import { schmock } from "./index";
import {
  normalizeResponse,
  serializeResponseBody,
} from "./response-normalizer";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(response: Schmock.Response): string {
  return isRecord(response.body) && typeof response.body.error === "string"
    ? response.body.error
    : "";
}

describe("plugin error-recovery contract (docs/plugins.md)", () => {
  it("surfaces the Error an onError hook returns in place of the original", async () => {
    const mock = schmock();
    mock("GET /x", { ok: true }).pipe({
      name: "replacer",
      process: () => {
        throw new Error("original failure");
      },
      onError: () => new Error("replaced failure"),
    });

    const response = await mock.handle("GET", "/x");

    expect(response.status).toBe(500);
    expect(errorText(response)).toContain("replaced failure");
    expect(errorText(response)).not.toContain("original failure");
  });

  it("never consults an upstream plugin's onError for a downstream failure", async () => {
    const upstreamOnError = vi.fn(() => [200, { recovered: "upstream" }]);
    const mock = schmock();
    mock("GET /x", { ok: true })
      .pipe({
        name: "upstream",
        process: (context, current) => ({ context, response: current }),
        onError: upstreamOnError,
      })
      .pipe({
        name: "downstream",
        process: () => {
          throw new Error("downstream failure");
        },
      });

    const response = await mock.handle("GET", "/x");

    expect(upstreamOnError).not.toHaveBeenCalled();
    expect(response.status).toBe(500);
    expect(errorText(response)).toContain("downstream failure");
  });

  it("surfaces the error a throwing onError hook raised", async () => {
    const mock = schmock();
    mock("GET /x", { ok: true }).pipe({
      name: "broken-handler",
      process: () => {
        throw new Error("Process failed");
      },
      onError: () => {
        throw new Error("Handler failed");
      },
    });

    const response = await mock.handle("GET", "/x");

    expect(errorText(response)).toContain("Handler failed");
    expect(errorText(response)).not.toContain("Process failed");
  });

  it("tells process hooks that a request guard short-circuited the request", async () => {
    const seen: Array<boolean | undefined> = [];
    const mock = schmock();
    mock("GET /x", { ok: true })
      .pipe({
        name: "guard",
        beforeRequest: (context) => ({
          context,
          response: [401, { error: "denied" }],
        }),
        process: (context, current) => ({ context, response: current }),
      })
      .pipe({
        name: "observer",
        process: (context, current) => {
          seen.push(context.requestShortCircuited);
          return { context, response: current };
        },
      });

    const response = await mock.handle("GET", "/x");

    expect(response.status).toBe(401);
    expect(seen).toEqual([true]);
  });

  it("does not run process hooks over a response recovered from a generator error", async () => {
    const mock = schmock();
    mock("GET /x", () => {
      throw new Error("generator failure");
    })
      .pipe({
        name: "recoverer",
        process: (context, current) => ({ context, response: current }),
        onError: () => [503, { recovered: true }],
      })
      .pipe({
        name: "transformer",
        process: (context, current) => ({
          context,
          response: { transformed: current },
        }),
      });

    const response = await mock.handle("GET", "/x");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ recovered: true });
  });
});

describe("pipe() validation keeps every plugin shape that works", () => {
  it("accepts switched-off hooks and a missing name", async () => {
    const mock = schmock();
    mock("GET /x", { ok: true });
    const shapes: unknown[] = [
      {
        name: "switched-off",
        install: false,
        beforeRequest: undefined,
        uninstall: null,
        onError: null,
        process: (context: unknown, current: unknown) => ({
          context,
          response: current,
        }),
      },
      {
        process: (context: unknown, current: unknown) => ({
          context,
          response: current,
        }),
      },
    ];

    for (const shape of shapes) {
      expect(() => Reflect.apply(mock.pipe, mock, [shape])).not.toThrow();
    }
    expect((await mock.handle("GET", "/x")).body).toEqual({ ok: true });
  });

  it.each([
    ["no process hook", { name: "p" }],
    ["a process that is not a function", { name: "p", process: "run" }],
    [
      "a truthy non-function install",
      { name: "p", install: "yes", process: () => ({}) },
    ],
    [
      "a truthy non-function beforeRequest",
      { name: "p", beforeRequest: 1, process: () => ({}) },
    ],
    ["null", null],
  ])("rejects a plugin with %s as PLUGIN_INVALID", (_label, shape) => {
    const mock = schmock();
    expect(() => Reflect.apply(mock.pipe, mock, [shape])).toThrow(
      expect.objectContaining({ code: "PLUGIN_INVALID" }),
    );
  });
});

describe("abort contract (docs/api.md: rejects with the signal reason)", () => {
  it("rejects a pending delay with the exact abort reason", async () => {
    const mock = schmock({ delay: 1_000 });
    mock("GET /slow", { ok: true });
    const controller = new AbortController();
    const reason = new Error("timeout");

    const pending = mock.handle("GET", "/slow", { signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("rejects a pending generator with the exact abort reason", async () => {
    const mock = schmock();
    let started = () => {};
    const generatorStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    mock("GET /pending", async () => {
      started();
      await new Promise(() => {});
      return { never: true };
    });
    const controller = new AbortController();
    const reason = new Error("user cancelled");

    const pending = mock.handle("GET", "/pending", {
      signal: controller.signal,
    });
    await generatorStarted;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("rejects a pending plugin hook with the exact abort reason", async () => {
    const mock = schmock();
    let started = () => {};
    const hookStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    mock("GET /hooked", { ok: true }).pipe({
      name: "slow-hook",
      process: async (context, response) => {
        started();
        await new Promise(() => {});
        return { context, response };
      },
    });
    const controller = new AbortController();
    const reason = new Error("navigation");

    const pending = mock.handle("GET", "/hooked", {
      signal: controller.signal,
    });
    await hookStarted;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("removes its abort listener once the awaited value resolves", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    await expect(
      awaitWithAbort(Promise.resolve("done"), controller.signal),
    ).resolves.toBe("done");

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes its abort listener once the awaited value rejects", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const failure = new Error("failed");

    await expect(
      awaitWithAbort(Promise.reject(failure), controller.signal),
    ).rejects.toBe(failure);

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

/**
 * The pre-fast-path algorithm, kept verbatim as the reference the optimised
 * `canonicalizePath` must agree with character for character.
 */
function referenceCanonicalizePath(path: string): string {
  const encodedAscii = new Set([
    " ",
    '"',
    "#",
    "<",
    ">",
    "?",
    "^",
    "`",
    "{",
    "}",
  ]);
  let result = "";
  for (let index = 0; index < path.length; ) {
    if (
      path[index] === "%" &&
      /^%[0-9A-Fa-f]{2}$/.test(path.slice(index, index + 3))
    ) {
      result += path.slice(index, index + 3).toUpperCase();
      index += 3;
      continue;
    }
    const codePoint = path.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    index += character.length;
    if (codePoint <= 0x1f || codePoint > 0x7e || encodedAscii.has(character)) {
      try {
        result += encodeURIComponent(character);
      } catch {
        result += "%EF%BF%BD";
      }
    } else {
      result += character;
    }
  }
  return result;
}

describe("canonicalizePath fast path", () => {
  it("agrees with the reference algorithm for every ASCII character in a path", () => {
    for (let code = 0; code <= 0x7f; code += 1) {
      const path = `/a${String.fromCharCode(code)}b`;
      expect(canonicalizePath(path)).toBe(referenceCanonicalizePath(path));
    }
  });

  it("still uppercases percent triplets on an otherwise safe path", () => {
    expect(canonicalizePath("/caf%c3%a9/items")).toBe("/caf%C3%A9/items");
    expect(canonicalizePath("/a%zz")).toBe("/a%zz");
  });

  it("agrees with the reference algorithm on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (path) => {
        expect(canonicalizePath(path)).toBe(referenceCanonicalizePath(path));
      }),
      { numRuns: 500, seed: 20260925 },
    );
  });
});

describe("JSON body validation", () => {
  it("serializes toJSON values after validating what toJSON returned", () => {
    const at = new Date("2026-09-25T00:00:00.000Z");
    const bytes = serializeResponseBody({
      status: 200,
      body: { at, nested: { list: [1, "two", null, true] } },
      headers: {},
    });
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"at":"2026-09-25T00:00:00.000Z","nested":{"list":[1,"two",null,true]}}',
    );
  });

  it("passes the property key to toJSON, as JSON.stringify does", () => {
    const keys: string[] = [];
    const body = {
      first: {
        toJSON(key: string) {
          keys.push(key);
          return key;
        },
      },
    };
    const response = normalizeResponse({ status: 200, body }, "GET");
    expect(response.body).toEqual({ first: "first" });
    expect(keys).toEqual(["first"]);
  });

  it.each([
    ["a nested undefined", { a: { b: undefined } }, "unsupported undefined"],
    ["an array hole", [1, undefined, 3], "unsupported undefined"],
    ["a function", { f: () => 1 }, "unsupported function"],
    ["a non-finite number", { n: Number.NaN }, "non-finite number"],
    ["a thenable", { p: Promise.resolve(1) }, "promise, iterable, and stream"],
    ["a Map", { m: new Map() }, "unsupported object"],
    [
      "an enumerable symbol key",
      { [Symbol("s")]: 1 },
      "enumerable symbol property",
    ],
    ["a nested binary value", { b: new Uint8Array(1) }, "top-level body"],
    [
      "a toJSON that returns a function",
      { t: { toJSON: () => () => 1 } },
      "unsupported function",
    ],
  ])("rejects %s with the same message", (_label, body, message) => {
    expect(() => normalizeResponse({ status: 200, body }, "GET")).toThrow(
      message,
    );
    expect(() =>
      serializeResponseBody({ status: 200, body, headers: {} }),
    ).toThrow(message);
  });

  it("reports a cycle as a non-serializable body", () => {
    const body: Record<string, unknown> = { name: "loop" };
    body.self = body;
    expect(() => normalizeResponse({ status: 200, body }, "GET")).toThrow(
      "body is not JSON-serializable",
    );
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { id: 1 };
    const response = normalizeResponse(
      { status: 200, body: { a: shared, b: shared } },
      "GET",
    );
    expect(response.body).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });
});

describe("request snapshots and history", () => {
  it("keeps a recorded response body independent of the returned response", async () => {
    const mock = schmock();
    mock("GET /item", { nested: { value: 1 } });

    const response = await mock.handle("GET", "/item");
    if (isRecord(response.body) && isRecord(response.body.nested)) {
      response.body.nested.value = 2;
    }

    expect(mock.lastRequest()?.response.body).toEqual({ nested: { value: 1 } });
  });

  it("hides routes registered after admission from that admission only", async () => {
    const instance = new CallableMockInstance();
    instance.defineRoute("GET /early", { early: true }, {});
    const admission = instance.createRequestAdmission();

    instance.defineRoute("GET /late", { late: true }, {});
    instance.defineRoute("GET /late/:id", ({ params }) => params, {});

    try {
      expect((await admission.handle("GET", "/early")).status).toBe(200);
      expect((await admission.handle("GET", "/late")).status).toBe(404);
      expect((await admission.handle("GET", "/late/1")).status).toBe(404);
      expect((await instance.handle("GET", "/late")).status).toBe(200);
      expect((await instance.handle("GET", "/late/1")).body).toEqual({
        id: "1",
      });
    } finally {
      admission.release();
    }
  });

  it("serves an admitted request from the routes it was admitted with, across reset", async () => {
    const instance = new CallableMockInstance();
    instance.defineRoute("GET /before", { before: true }, {});
    const admission = instance.createRequestAdmission();

    instance.reset();
    instance.defineRoute("GET /after", { after: true }, {});

    try {
      expect((await admission.handle("GET", "/before")).status).toBe(200);
      expect((await admission.handle("GET", "/after")).status).toBe(404);
      expect((await instance.handle("GET", "/before")).status).toBe(404);
      expect((await instance.handle("GET", "/after")).status).toBe(200);
    } finally {
      admission.release();
    }
  });

  it("keeps a plugin piped after admission out of that admission", async () => {
    const instance = new CallableMockInstance();
    instance.defineRoute("GET /x", { plain: true }, {});
    const admission = instance.createRequestAdmission();

    instance.pipe({
      name: "wrapper",
      process: (context, response) => ({
        context,
        response: { wrapped: response },
      }),
    });

    try {
      expect((await admission.handle("GET", "/x")).body).toEqual({
        plain: true,
      });
      expect((await instance.handle("GET", "/x")).body).toEqual({
        wrapped: { plain: true },
      });
    } finally {
      admission.release();
    }
  });
});
