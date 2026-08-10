import { describe, expect, it, vi } from "vitest";
import type { RefPolicy } from "./ref-policy";
import {
  buildRefParserOptions,
  checkRef,
  collectUnresolvedRefs,
  isUnsafeHost,
  resolveRefPolicy,
} from "./ref-policy";

describe("isUnsafeHost", () => {
  it("blocks loopback, link-local and private ranges", () => {
    for (const host of [
      "localhost",
      "api.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "::1",
      "[::1]",
      "10.1.2.3",
      "192.168.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.169.254",
      "fe80::1",
      "fd00::1",
    ]) {
      expect(isUnsafeHost(host), host).toBe(true);
    }
  });

  it("allows public hosts, including addresses adjacent to private ranges", () => {
    for (const host of [
      "schemas.example.com",
      "8.8.8.8",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "11.0.0.1",
    ]) {
      expect(isUnsafeHost(host), host).toBe(false);
    }
  });

  it("sees through IPv4-mapped IPv6 literals to the embedded address", () => {
    for (const host of [
      // hex spelling, as WHATWG URL normalizes the bracketed literal
      "::ffff:7f00:1", // 127.0.0.1
      "::ffff:a9fe:a9fe", // 169.254.169.254 (cloud metadata)
      "::ffff:0a00:1", // 10.0.0.1
      "::ffff:c0a8:1", // 192.168.0.1
      // dotted spelling, in case a ref reaches the check unnormalized
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
    ]) {
      expect(isUnsafeHost(host), host).toBe(true);
    }
  });

  it("strips a trailing dot before the name comparisons", () => {
    expect(isUnsafeHost("localhost.")).toBe(true);
    expect(isUnsafeHost("api.localhost.")).toBe(true);
  });
});

describe("checkRef host allow-list", () => {
  const policy = resolveRefPolicy({
    external: true,
    allowHttp: true,
    // Uppercase entry: URL.hostname is always lowercased, so an exact,
    // case-sensitive compare would reject a host the operator allow-listed.
    allowedHosts: ["Schemas.Example.com"],
  });

  it("matches an allow-list entry case-insensitively", () => {
    expect(checkRef("https://schemas.example.com/a.json#/A", policy)).toEqual({
      allowed: true,
    });
    expect(checkRef("https://SCHEMAS.EXAMPLE.COM/a.json#/A", policy)).toEqual({
      allowed: true,
    });
  });

  it("still blocks a host outside the allow-list", () => {
    const verdict = checkRef("https://other.example.com/a.json#/A", policy);
    expect(verdict.allowed).toBe(false);
  });

  it("blocks an IPv4-mapped loopback even inside an empty allow-list", () => {
    const anyHost = resolveRefPolicy({ external: true, allowHttp: true });
    const verdict = checkRef(
      "http://[::ffff:169.254.169.254]/latest/meta-data/#/x",
      anyHost,
    );
    expect(verdict.allowed).toBe(false);
  });
});

describe("buildRefParserOptions", () => {
  it("disables external resolution by default", () => {
    expect(buildRefParserOptions()).toEqual({ resolve: { external: false } });
    expect(buildRefParserOptions({ allowHttp: true })).toEqual({
      resolve: { external: false },
    });
  });

  it("keeps the http resolver off until allowHttp is set", () => {
    expect(buildRefParserOptions({ external: true })).toEqual({
      resolve: { external: true, http: false },
    });
  });

  it("installs a guarded http resolver that ignores non-http URLs", () => {
    const options = buildRefParserOptions({
      external: true,
      allowHttp: true,
      allowedHosts: ["schemas.example.com"],
    });
    const http = options.resolve?.http;
    if (typeof http !== "object" || http === null) {
      throw new Error("expected an http resolver object");
    }
    const canRead = http.canRead;
    if (typeof canRead !== "function") {
      throw new Error("expected a canRead function");
    }

    expect(canRead({ url: "https://schemas.example.com/a.json" })).toBe(true);
    expect(canRead({ url: "https://other.example.com/a.json" })).toBe(false);
    expect(canRead({ url: "http://127.0.0.1/a.json" })).toBe(false);
    // A file path must stay with the file resolver rather than reach fetch().
    expect(canRead({ url: "/tmp/models.json" })).toBe(false);
  });
});

describe("http resolver redirect handling", () => {
  function httpResolver(policy: RefPolicy) {
    const http = buildRefParserOptions(policy).resolve?.http;
    if (typeof http !== "object" || http === null) {
      throw new Error("expected an http resolver object");
    }
    return http;
  }

  it("re-checks each redirect target and blocks a bounce to a private host", async () => {
    const fetched: string[] = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);
        fetched.push(url);
        if (url === "https://schemas.example.com/m.json") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data" },
          });
        }
        return new Response("{}", { status: 200 });
      });
    try {
      const http = httpResolver({
        external: true,
        allowHttp: true,
        allowedHosts: ["schemas.example.com"],
        redirects: 1,
      });
      await expect(
        http.read({ url: "https://schemas.example.com/m.json" }),
      ).rejects.toThrow(/redirect .* blocked/);
      // The private target is re-checked BEFORE it is fetched, so no request
      // to the metadata address ever goes out.
      expect(fetched).not.toContain("http://169.254.169.254/latest/meta-data");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("refuses to follow any redirect when redirects is 0", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://schemas.example.com/next.json" },
        }),
    );
    try {
      const http = httpResolver({
        external: true,
        allowHttp: true,
        allowedHosts: ["schemas.example.com"],
      });
      await expect(
        http.read({ url: "https://schemas.example.com/m.json" }),
      ).rejects.toThrow(/redirect limit of 0/);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("follows a redirect that stays on an allowed host", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://schemas.example.com/m.json") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://schemas.example.com/real.json" },
          });
        }
        return new Response('{"ok":true}', { status: 200 });
      });
    try {
      const http = httpResolver({
        external: true,
        allowHttp: true,
        allowedHosts: ["schemas.example.com"],
        redirects: 1,
      });
      await expect(
        http.read({ url: "https://schemas.example.com/m.json" }),
      ).resolves.toBe('{"ok":true}');
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("collectUnresolvedRefs", () => {
  it("reports external refs and ignores internal ones", () => {
    expect(
      collectUnresolvedRefs({
        a: { $ref: "#/components/schemas/A" },
        b: { $ref: "./models.json#/Thing" },
        c: [{ $ref: "https://example.com/x.json#/A" }],
      }).sort(),
    ).toEqual(["./models.json#/Thing", "https://example.com/x.json#/A"]);
  });

  it("deduplicates repeated refs", () => {
    expect(
      collectUnresolvedRefs({
        a: { $ref: "./models.json#/Thing" },
        b: { $ref: "./models.json#/Thing" },
      }),
    ).toEqual(["./models.json#/Thing"]);
  });

  it("terminates on a cyclic document", () => {
    // A dereferenced document shares object identity across every use of a
    // component and is routinely circular. Without the WeakSet the walk never
    // returns, so this test is the guard, not a nicety.
    const node: Record<string, unknown> = { $ref: "./models.json#/Thing" };
    node.self = node;
    node.children = [node, { nested: node }];

    expect(collectUnresolvedRefs(node)).toEqual(["./models.json#/Thing"]);
  });
});
