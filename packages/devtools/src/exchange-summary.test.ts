import type * as Schmock from "@schmock/core";
import { describe, expect, it } from "vitest";
import { summarizeExchange } from "./exchange-summary.js";

const request = (
  url = "http://localhost/api/users?page=2",
  method = "GET",
) => ({
  method,
  url,
  headers: { accept: "application/json" },
});

const answered = (
  status = 200,
  url?: string,
  startTime = 10,
  endTime = 13.2,
): Schmock.Exchange => ({
  outcome: "answered",
  request: request(url),
  response: { status, headers: { "content-type": "application/json" } },
  startTime,
  endTime,
});

const failed = (error: unknown): Schmock.Exchange => ({
  outcome: "failed",
  request: request(),
  error,
  startTime: 10,
  endTime: 13.2,
});

const aborted = (): Schmock.Exchange => ({
  outcome: "aborted",
  request: request(),
  startTime: 10,
  endTime: 13.2,
});

describe("summarizeExchange name", () => {
  const ABS = "http://localhost/api/users?page=2";

  it("uses pathname and search when pageOrigin is the same origin", () => {
    expect(summarizeExchange(answered(), "http://localhost").name).toBe(
      "GET /api/users?page=2",
    );
  });

  it("uses the origin of a full page URL", () => {
    expect(
      summarizeExchange(answered(), "http://localhost/some/page?x=1").name,
    ).toBe("GET /api/users?page=2");
  });

  it("keeps the absolute URL for a different origin", () => {
    expect(summarizeExchange(answered(), "http://localhost:3000").name).toBe(
      `GET ${ABS}`,
    );
  });

  it("keeps the absolute URL without a pageOrigin", () => {
    expect(summarizeExchange(answered()).name).toBe(`GET ${ABS}`);
    expect(summarizeExchange(answered(), undefined).name).toBe(`GET ${ABS}`);
  });

  it("ignores an unparsable pageOrigin without throwing", () => {
    expect(summarizeExchange(answered(), "not a url").name).toBe(`GET ${ABS}`);
  });

  it("treats the opaque origin string null as no match", () => {
    expect(summarizeExchange(answered(), "null").name).toBe(`GET ${ABS}`);
  });

  it("renders a root path as /", () => {
    expect(
      summarizeExchange(answered(200, "http://localhost/"), "http://localhost")
        .name,
    ).toBe("GET /");
  });

  it("never matches opaque origins", () => {
    expect(
      summarizeExchange(
        answered(200, "data:text/plain,hi"),
        "data:text/plain,page",
      ).name,
    ).toBe("GET data:text/plain,hi");
  });

  it("uses the request method verbatim", () => {
    const ex: Schmock.Exchange = {
      ...answered(),
      request: request(ABS, "PROPFIND"),
    };
    expect(summarizeExchange(ex).name).toBe(`PROPFIND ${ABS}`);
  });
});

describe("summarizeExchange outcome", () => {
  it("is the status for answered", () => {
    expect(summarizeExchange(answered(200)).outcome).toBe("200");
  });

  it("is the message for an Error failure", () => {
    expect(summarizeExchange(failed(new Error("hook failed"))).outcome).toBe(
      "failed: hook failed",
    );
  });

  it("stringifies non-Error failures", () => {
    expect(summarizeExchange(failed("boom")).outcome).toBe("failed: boom");
    expect(summarizeExchange(failed(42)).outcome).toBe("failed: 42");
  });

  it("falls back for an unprintable failure", () => {
    expect(summarizeExchange(failed(Object.create(null))).outcome).toBe(
      "failed: <unprintable>",
    );
  });

  it("is aborted for aborted", () => {
    expect(summarizeExchange(aborted()).outcome).toBe("aborted");
  });
});

describe("summarizeExchange duration", () => {
  it("formats one decimal and ms", () => {
    expect(summarizeExchange(answered(200, undefined, 10, 13.2)).duration).toBe(
      "3.2 ms",
    );
    expect(
      summarizeExchange(answered(200, undefined, 0, 1234.56)).duration,
    ).toBe("1234.6 ms");
  });

  it("is 0.0 ms for equal times", () => {
    expect(summarizeExchange(answered(200, undefined, 10, 10)).duration).toBe(
      "0.0 ms",
    );
  });

  it("is never negative", () => {
    expect(summarizeExchange(answered(200, undefined, 20, 10)).duration).toBe(
      "0.0 ms",
    );
  });
});

describe("summarizeExchange tone", () => {
  it.each([
    [200, "success"],
    [302, "success"],
    [399, "success"],
    [400, "client-error"],
    [499, "client-error"],
    [500, "server-error"],
    [599, "server-error"],
  ])("maps status %i to %s", (status, tone) => {
    expect(summarizeExchange(answered(status)).tone).toBe(tone);
  });

  it("maps failed and aborted", () => {
    expect(summarizeExchange(failed(new Error("x"))).tone).toBe("failed");
    expect(summarizeExchange(aborted()).tone).toBe("aborted");
  });
});

describe("summarizeExchange result", () => {
  it("returns exactly the four summary keys", () => {
    expect(summarizeExchange(answered(), "http://localhost")).toEqual({
      name: "GET /api/users?page=2",
      outcome: "200",
      duration: "3.2 ms",
      tone: "success",
    });
  });

  it("does not mutate the input", () => {
    const ex = answered();
    const copy = structuredClone(ex);
    summarizeExchange(ex, "http://localhost");
    expect(ex).toEqual(copy);
  });
});
