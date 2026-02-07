import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RouteParseError } from "./errors";
import { schmock } from "./index";
import { parseRouteKey } from "./parser";

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
] as const;

const method = fc.constantFrom(...HTTP_METHODS);

// --- Segment generators, from tame to hostile ---

const safeSeg = fc.stringMatching(/^[a-z0-9_-]{1,20}$/);
const upperSeg = fc.stringMatching(/^[A-Za-z0-9]{1,20}$/);
// fc.string() in v4 generates full unicode by default
const unicodeSeg = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => !s.includes("/") && !s.includes("\0"));
const regexMetaSeg = fc.stringMatching(/^[.*+?^${}()|[\]\\]{1,10}$/);
const encodedSeg = safeSeg.map((s) => encodeURIComponent(s));
const doubleEncodedSeg = safeSeg.map((s) =>
  encodeURIComponent(encodeURIComponent(s)),
);
const nullByteSeg = safeSeg.map((s) => `${s}\x00`);
const whitespaceSeg = fc.stringMatching(/^[ \t]{1,5}$/);
const traversalSeg = fc.constantFrom(
  "..",
  ".",
  "%2e%2e",
  "%2e",
  "..%2f",
  "%2f..",
);
const emptySeg = fc.constant("");
const emojiSeg = fc.constantFrom(
  "\u{1F600}",
  "\u{1F4A9}",
  "\u{1F1E7}\u{1F1F7}",
  "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
  "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}",
  "\u{0041}\u{030A}",
  "\u{2764}\u{FE0F}",
  "caf\u{00E9}",
  "\u{D55C}\u{AD6D}\u{C5B4}",
  "\u{0639}\u{0631}\u{0628}\u{064A}",
);
const mixedEmojiSeg = fc.tuple(safeSeg, emojiSeg).map(([a, b]) => `${a}${b}`);

const hostileSeg = fc.oneof(
  { weight: 3, arbitrary: safeSeg },
  { weight: 2, arbitrary: unicodeSeg },
  { weight: 2, arbitrary: regexMetaSeg },
  { weight: 2, arbitrary: emojiSeg },
  { weight: 1, arbitrary: mixedEmojiSeg },
  { weight: 1, arbitrary: encodedSeg },
  { weight: 1, arbitrary: doubleEncodedSeg },
  { weight: 1, arbitrary: nullByteSeg },
  { weight: 1, arbitrary: whitespaceSeg },
  { weight: 1, arbitrary: traversalSeg },
  { weight: 1, arbitrary: emptySeg },
  { weight: 1, arbitrary: upperSeg },
);

// --- Path generators ---

const safePath = fc
  .array(safeSeg, { minLength: 1, maxLength: 6 })
  .map((segs) => `/${segs.join("/")}`);

const hostilePath = fc
  .array(hostileSeg, { minLength: 1, maxLength: 6 })
  .map((segs) => `/${segs.join("/")}`);

const doubleSlashPath = fc
  .array(safeSeg, { minLength: 2, maxLength: 4 })
  .map((segs) => `/${segs.join("//")}`);

const trailingSlashPath = safePath.map((p) => `${p}/`);

const deepPath = fc
  .array(safeSeg, { minLength: 10, maxLength: 30 })
  .map((segs) => `/${segs.join("/")}`);

// --- Route key generators ---

const routeKey = fc.tuple(method, safePath).map(([m, p]) => `${m} ${p}`);

const paramRouteKey = fc
  .tuple(
    method,
    fc.array(safeSeg, { minLength: 1, maxLength: 4 }),
    fc.array(safeSeg, { minLength: 1, maxLength: 3 }),
  )
  .map(([m, statics, params]) => {
    const parts = statics.map((s, i) =>
      i < params.length ? `${s}/:${params[i]}` : s,
    );
    return `${m} /${parts.join("/")}`;
  });

// Route keys with hostile characters in the path portion
const hostileRouteKey = fc
  .tuple(method, hostilePath)
  .map(([m, p]) => `${m} ${p}`);

// --- Arbitrary inputs ---

const arbitraryString = fc.string({ minLength: 0, maxLength: 200 });

// --- Namespace generators ---

const namespace = fc.oneof(
  safeSeg.map((s) => `/${s}`),
  fc.constant("/"),
  safeSeg, // no leading slash
  safeSeg.map((s) => `/${s}/`), // trailing slash
  fc.constant(""),
  safeSeg.map((s) => `//${s}`), // double leading slash
  fc
    .tuple(safeSeg, safeSeg)
    .map(([a, b]) => `/${a}/${b}`), // nested
);

// ============================================================
// parseRouteKey properties
// ============================================================

describe("parseRouteKey — fuzz", () => {
  it("never throws an unhandled error on arbitrary ASCII input", () => {
    fc.assert(
      fc.property(arbitraryString, (input) => {
        try {
          parseRouteKey(input);
        } catch (e) {
          expect(e).toBeInstanceOf(RouteParseError);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("never throws an unhandled error on arbitrary unicode input", () => {
    fc.assert(
      fc.property(arbitraryString, (input) => {
        try {
          parseRouteKey(input);
        } catch (e) {
          expect(e).toBeInstanceOf(RouteParseError);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("rejects inputs that look like methods but have hostile paths", () => {
    fc.assert(
      fc.property(hostileRouteKey, (key) => {
        try {
          const result = parseRouteKey(key);
          // If it parses, the regex must be valid
          expect(result.pattern).toBeInstanceOf(RegExp);
        } catch (e) {
          expect(e).toBeInstanceOf(RouteParseError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("always produces a valid regex for well-formed route keys", () => {
    fc.assert(
      fc.property(routeKey, (key) => {
        const result = parseRouteKey(key);
        expect(result.pattern).toBeInstanceOf(RegExp);
        expect(result.pattern.test(result.path)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("produced regex never matches a completely unrelated path", () => {
    fc.assert(
      fc.property(routeKey, (key) => {
        const result = parseRouteKey(key);
        // An empty string should never match a route pattern
        expect(result.pattern.test("")).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("produced regex is safe against hostile test paths", () => {
    fc.assert(
      fc.property(routeKey, hostilePath, (key, reqPath) => {
        const result = parseRouteKey(key);
        const matched = result.pattern.test(reqPath);
        expect(typeof matched).toBe("boolean");
      }),
      { numRuns: 1000 },
    );
  });

  it("produced regex handles double-slash paths without crashing", () => {
    fc.assert(
      fc.property(routeKey, doubleSlashPath, (key, reqPath) => {
        const result = parseRouteKey(key);
        const matched = result.pattern.test(reqPath);
        expect(typeof matched).toBe("boolean");
      }),
      { numRuns: 300 },
    );
  });

  it("produced regex handles trailing-slash paths without crashing", () => {
    fc.assert(
      fc.property(routeKey, trailingSlashPath, (key, reqPath) => {
        const result = parseRouteKey(key);
        const matched = result.pattern.test(reqPath);
        expect(typeof matched).toBe("boolean");
      }),
      { numRuns: 300 },
    );
  });

  it("parameter count always matches colon segments", () => {
    fc.assert(
      fc.property(paramRouteKey, (key) => {
        const result = parseRouteKey(key);
        const colonCount = (key.match(/:/g) || []).length;
        expect(result.params).toHaveLength(colonCount);
      }),
      { numRuns: 500 },
    );
  });

  it("parameter names never contain slashes", () => {
    fc.assert(
      fc.property(paramRouteKey, (key) => {
        const result = parseRouteKey(key);
        for (const param of result.params) {
          expect(param).not.toContain("/");
        }
      }),
      { numRuns: 500 },
    );
  });

  it("pattern is always anchored (^ and $)", () => {
    fc.assert(
      fc.property(routeKey, (key) => {
        const result = parseRouteKey(key);
        const src = result.pattern.source;
        expect(src.startsWith("^")).toBe(true);
        expect(src.endsWith("$")).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("method in result always matches method in input", () => {
    fc.assert(
      fc.property(routeKey, (key) => {
        const result = parseRouteKey(key);
        const inputMethod = key.split(" ")[0];
        expect(result.method).toBe(inputMethod);
      }),
      { numRuns: 300 },
    );
  });
});

// ============================================================
// handle() properties
// ============================================================

describe("handle() — fuzz", () => {
  it("never throws on arbitrary request paths", () => {
    const mock = schmock();
    mock("GET /users/:id", () => ({ id: 1 }));
    mock("POST /items", () => ({ ok: true }));
    mock("DELETE /items/:id/comments/:cid", () => ({ deleted: true }));

    fc.assert(
      fc.asyncProperty(method, arbitraryString, async (m, reqPath) => {
        const response = await mock.handle(m, reqPath);
        expect(response).toBeDefined();
        expect(typeof response.status).toBe("number");
        expect([200, 404, 500]).toContain(response.status);
      }),
      { numRuns: 1000 },
    );
  });

  it("never throws on arbitrary unicode request paths", () => {
    const mock = schmock();
    mock("GET /data/:key", () => ({ ok: true }));

    fc.assert(
      fc.asyncProperty(arbitraryString, async (reqPath) => {
        const response = await mock.handle("GET", reqPath);
        expect(response).toBeDefined();
        expect(typeof response.status).toBe("number");
      }),
      { numRuns: 500 },
    );
  });

  it("never throws on hostile path segments", () => {
    const mock = schmock();
    mock("GET /api/:resource/:id", () => ({ found: true }));

    fc.assert(
      fc.asyncProperty(hostilePath, async (reqPath) => {
        const response = await mock.handle("GET", reqPath);
        expect(response).toBeDefined();
        expect(typeof response.status).toBe("number");
      }),
      { numRuns: 500 },
    );
  });

  it("never throws on double-slash paths", () => {
    const mock = schmock();
    mock("GET /a/:b", () => ({ ok: true }));

    fc.assert(
      fc.asyncProperty(doubleSlashPath, async (reqPath) => {
        const response = await mock.handle("GET", reqPath);
        expect(response).toBeDefined();
        expect(typeof response.status).toBe("number");
      }),
      { numRuns: 300 },
    );
  });

  it("never throws on deeply nested paths", () => {
    const mock = schmock();
    mock("GET /a/:b", () => ({ ok: true }));

    fc.assert(
      fc.asyncProperty(deepPath, async (reqPath) => {
        const response = await mock.handle("GET", reqPath);
        expect(response).toBeDefined();
      }),
      { numRuns: 200 },
    );
  });

  it("matched params are always strings", () => {
    let capturedParams: Record<string, string> = {};
    const mock = schmock();
    mock("GET /x/:a/:b", (ctx) => {
      capturedParams = ctx.params;
      return { ok: true };
    });

    fc.assert(
      fc.asyncProperty(hostileSeg, hostileSeg, async (a, b) => {
        // Avoid slashes in segments since they'd split the path differently
        if (a.includes("/") || b.includes("/")) return;
        const response = await mock.handle("GET", `/x/${a}/${b}`);
        if (response.status === 200) {
          expect(typeof capturedParams.a).toBe("string");
          expect(typeof capturedParams.b).toBe("string");
          expect(capturedParams.a).toBe(a);
          expect(capturedParams.b).toBe(b);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("emoji params are captured verbatim", () => {
    let capturedParams: Record<string, string> = {};
    const mock = schmock();
    mock("GET /emoji/:val", (ctx) => {
      capturedParams = ctx.params;
      return { ok: true };
    });

    fc.assert(
      fc.asyncProperty(emojiSeg, async (emoji) => {
        const response = await mock.handle("GET", `/emoji/${emoji}`);
        expect(response.status).toBe(200);
        expect(capturedParams.val).toBe(emoji);
      }),
      { numRuns: 100 },
    );
  });

  it("mixed emoji + ASCII paths resolve without error", () => {
    const mock = schmock();
    mock("GET /search/:query", () => ({ results: [] }));

    fc.assert(
      fc.asyncProperty(mixedEmojiSeg, async (seg) => {
        const response = await mock.handle("GET", `/search/${seg}`);
        expect(response).toBeDefined();
        expect(typeof response.status).toBe("number");
      }),
      { numRuns: 200 },
    );
  });

  it("namespace stripping handles arbitrary prefixes", () => {
    fc.assert(
      fc.asyncProperty(namespace, hostilePath, async (ns, reqPath) => {
        const mock = schmock({ namespace: ns });
        mock("GET /test", () => ({ ok: true }));
        const response = await mock.handle("GET", reqPath);
        expect(response).toBeDefined();
        expect(typeof response.status).toBe("number");
      }),
      { numRuns: 500 },
    );
  });

  it("namespace + valid route resolves correctly", () => {
    fc.assert(
      fc.asyncProperty(safeSeg, async (ns) => {
        const mock = schmock({ namespace: `/${ns}` });
        mock("GET /ping", () => ({ pong: true }));
        const response = await mock.handle("GET", `/${ns}/ping`);
        expect(response.status).toBe(200);
      }),
      { numRuns: 300 },
    );
  });

  it("unmatched routes always return 404 with ROUTE_NOT_FOUND code", () => {
    const mock = schmock();
    mock("GET /only-this", () => ({ ok: true }));

    // Generate paths that definitely won't match "/only-this"
    const nonMatchingPath = fc
      .array(safeSeg, { minLength: 2, maxLength: 5 })
      .map((segs) => `/${segs.join("/")}`);

    fc.assert(
      fc.asyncProperty(nonMatchingPath, async (reqPath) => {
        const response = await mock.handle("GET", reqPath);
        expect(response.status).toBe(404);
        expect((response.body as any).code).toBe("ROUTE_NOT_FOUND");
      }),
      { numRuns: 500 },
    );
  });

  it("regex matching terminates quickly (no ReDoS)", () => {
    const mock = schmock();
    mock("GET /a/:b/:c/:d/:e", () => ({ ok: true }));

    const longRepeated = fc
      .integer({ min: 100, max: 1000 })
      .map((n) => `/${"a/".repeat(n)}z`);

    fc.assert(
      fc.asyncProperty(longRepeated, async (reqPath) => {
        const start = performance.now();
        const response = await mock.handle("GET", reqPath);
        const elapsed = performance.now() - start;
        expect(response).toBeDefined();
        expect(elapsed).toBeLessThan(50);
      }),
      { numRuns: 200 },
    );
  });

  it("many registered routes still resolve without delay", () => {
    const mock = schmock();
    // Register 100 routes
    for (let i = 0; i < 100; i++) {
      mock(`GET /r${i}/:id` as any, () => ({ route: i }));
    }

    fc.assert(
      fc.asyncProperty(hostilePath, async (reqPath) => {
        const start = performance.now();
        const response = await mock.handle("GET", reqPath);
        const elapsed = performance.now() - start;
        expect(response).toBeDefined();
        expect(elapsed).toBeLessThan(50);
      }),
      { numRuns: 300 },
    );
  });
});
