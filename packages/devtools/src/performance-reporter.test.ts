import { afterEach, describe, expect, it, vi } from "vitest";
import { measureExchange, TONE_COLORS } from "./performance-reporter.js";

const URL_ABS = "http://localhost/api/users";

function answered(startTime = 100, endTime = 101.4) {
  return {
    outcome: "answered",
    request: { method: "GET", url: URL_ABS, headers: {} },
    response: { status: 200, headers: {} },
    startTime,
    endTime,
  };
}

const summary = {
  name: "GET /api/users",
  outcome: "200",
  duration: "1.4 ms",
  tone: "success",
};

const expectedDetail = {
  devtools: {
    dataType: "track-entry",
    track: "Schmock",
    color: "primary",
    tooltipText: "GET http://localhost/api/users → 200",
    properties: [
      ["Method", "GET"],
      ["URL", "http://localhost/api/users"],
      ["Outcome", "200"],
      ["Duration", "1.4 ms"],
    ],
  },
};

afterEach(() => {
  performance.clearMeasures();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("measureExchange", () => {
  it("calls timeline.measure once as a method with name, start, end and detail", () => {
    const timeline = { measure: vi.fn() };
    measureExchange(answered(), summary, { track: "Schmock" }, timeline);

    expect(timeline.measure).toHaveBeenCalledTimes(1);
    expect(timeline.measure.mock.contexts[0]).toBe(timeline);
    const [name, options] = timeline.measure.mock.calls[0];
    expect(name).toBe("GET /api/users");
    expect(Object.keys(options).sort()).toEqual(["detail", "end", "start"]);
    expect(options.start).toBe(100);
    expect(options.end).toBe(101.4);
    expect(options.detail).toEqual(expectedDetail);
    expect("trackGroup" in options.detail.devtools).toBe(false);
  });

  it("includes trackGroup when given", () => {
    const timeline = { measure: vi.fn() };
    measureExchange(
      answered(),
      summary,
      { track: "Users API", trackGroup: "My app" },
      timeline,
    );
    const devtools = timeline.measure.mock.calls[0][1].detail.devtools;
    expect(devtools.track).toBe("Users API");
    expect(devtools.trackGroup).toBe("My app");
    expect(Object.keys(devtools).sort()).toEqual([
      "color",
      "dataType",
      "properties",
      "tooltipText",
      "track",
      "trackGroup",
    ]);
  });

  it("clamps end to start when the end precedes it", () => {
    const timeline = { measure: vi.fn() };
    measureExchange(answered(50, 40), summary, { track: "Schmock" }, timeline);
    const options = timeline.measure.mock.calls[0][1];
    expect(options.start).toBe(50);
    expect(options.end).toBe(50);
  });

  it.each([
    ["success", "primary"],
    ["client-error", "tertiary"],
    ["server-error", "error"],
    ["failed", "error"],
    ["aborted", "secondary"],
  ])("uses color for tone %s", (tone, color) => {
    const timeline = { measure: vi.fn() };
    measureExchange(
      answered(),
      { ...summary, tone },
      { track: "Schmock" },
      timeline,
    );
    expect(timeline.measure.mock.calls[0][1].detail.devtools.color).toBe(color);
  });

  it("exposes a frozen TONE_COLORS with the exact mapping", () => {
    expect(TONE_COLORS).toEqual({
      success: "primary",
      "client-error": "tertiary",
      "server-error": "error",
      failed: "error",
      aborted: "secondary",
    });
    expect(Object.isFrozen(TONE_COLORS)).toBe(true);
  });

  it("creates a real Node measure entry with a readable detail", () => {
    measureExchange(answered(), summary, { track: "Schmock" });
    const entries = performance.getEntriesByType("measure");
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.name).toBe("GET /api/users");
    expect(entry.startTime).toBe(100);
    expect(entry.duration).toBeCloseTo(1.4, 3);
    expect(entry.detail).toEqual(expectedDetail);
  });

  it("does nothing and does not throw without a timeline", () => {
    let thrown: unknown;
    try {
      vi.stubGlobal("performance", undefined);
      measureExchange(answered(), summary, { track: "Schmock" });
    } catch (error) {
      thrown = error;
    } finally {
      vi.unstubAllGlobals();
    }
    expect(thrown).toBeUndefined();
    expect(performance.getEntriesByType("measure")).toHaveLength(0);
  });

  it("ignores a timeline without a measure function", () => {
    expect(() =>
      measureExchange(answered(), summary, { track: "Schmock" }, {}),
    ).not.toThrow();
    expect(() =>
      measureExchange(
        answered(),
        summary,
        { track: "Schmock" },
        { measure: "nope" },
      ),
    ).not.toThrow();
    expect(performance.getEntriesByType("measure")).toHaveLength(0);
  });

  it("swallows a throwing measure after calling it once", () => {
    const timeline = {
      measure: vi.fn(() => {
        throw new Error("unsupported");
      }),
    };
    expect(() =>
      measureExchange(answered(), summary, { track: "Schmock" }, timeline),
    ).not.toThrow();
    expect(timeline.measure).toHaveBeenCalledTimes(1);
  });

  it("passes only plain string pairs as properties", () => {
    const timeline = { measure: vi.fn() };
    measureExchange(answered(), summary, { track: "Schmock" }, timeline);
    const { properties } = timeline.measure.mock.calls[0][1].detail.devtools;
    expect(properties).toHaveLength(4);
    for (const pair of properties) {
      expect(pair).toHaveLength(2);
      expect(typeof pair[0]).toBe("string");
      expect(typeof pair[1]).toBe("string");
    }
  });
});
