import { describe, expect, it } from "vitest";
import { redactUrl } from "./redact-url.js";

describe("redactUrl", () => {
  it.each([
    ["http://h/p", "http://h/p"],
    ["/p?page=2&q=a%20b+c", "/p?page=2&q=a%20b+c"],
    ["/p?token=t&q=a%20b", "/p?token=[redacted]&q=a%20b"],
    ["/p?api%5Fkey=k", "/p?api%5Fkey=[redacted]"],
    ["/p?X-Api-Key=k&password", "/p?X-Api-Key=[redacted]&password=[redacted]"],
    ["/p?secret=s#token=keep", "/p?secret=[redacted]#token=keep"],
    ["/p?%E0%A4%A=1&key=k", "/p?%E0%A4%A=1&key=[redacted]"],
    // A name that does not decode is matched as spelled.
    ["/p?%E0%A4%A_token=t", "/p?%E0%A4%A_token=[redacted]"],
  ])("rewrites %j as %j", (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });
});
