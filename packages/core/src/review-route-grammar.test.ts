import { describe, expect, it } from "vitest";
import { canonicalizePath, normalizePath } from "./constants";
import { RouteParseError } from "./errors";
import { schmock } from "./index";
import { parseRouteKey } from "./parser";

/**
 * The compilation parseRouteKey used before the grammar review, kept verbatim
 * as the reference for "keys that were unambiguous compile exactly as before".
 */
function legacyCompile(path: string): { path: string; source: string } {
  const canonical = normalizePath(canonicalizePath(path));
  const source = canonical
    .split(/(:[a-zA-Z0-9_-]+)/g)
    .map((segment) =>
      /^:([a-zA-Z0-9_-]+)$/.test(segment)
        ? "([^/]+)"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return { path: canonical, source: `^${source}$` };
}

describe("route grammar review", () => {
  describe("keys without several parameters in one segment are unchanged", () => {
    const keys = [
      "/users",
      "/users/",
      "/users/:id",
      "/users/:userId/posts/:postId",
      "/files/:name.json",
      "/items/(:id)",
      "/users/:user-id",
      "/kebab/:kebab-case/x",
      "/a b/:id",
      "/caf\u00e9/:id",
      "/q/:id?",
      "/r/[:id]",
      "/api/v2/organizations/:orgId/teams/:teamId/members/:userId",
      "/trailing/:id-",
      "/weird/::id",
      '/quote/:"unclosed',
      '/quote/:""',
    ];

    for (const key of keys) {
      it(`GET ${key}`, () => {
        const route = parseRouteKey(`GET ${key}`);
        const legacy = legacyCompile(key);
        expect(route.path).toBe(legacy.path);
        expect(route.pattern.source).toBe(new RegExp(legacy.source).source);
      });
    }
  });

  describe("several parameters in one segment", () => {
    it("excludes the following separator from every capture but the last", () => {
      const route = parseRouteKey("GET /reports/:year-:month-:day");
      expect(route.params).toEqual(["year", "month", "day"]);
      expect(route.pattern.source).toBe(
        "^\\/reports\\/([^/\\-]+)-([^/\\-]+)-([^/]+)$",
      );
    });

    it("splits dotted versions at the first separator", () => {
      const route = parseRouteKey("GET /v/:major.:minor.:patch");
      expect("/v/1.2.3".match(route.pattern)?.slice(1)).toEqual([
        "1",
        "2",
        "3",
      ]);
    });

    it("keeps a trailing literal suffix greedy for the last parameter", () => {
      const route = parseRouteKey("GET /f/:name.:ext.gz");
      expect("/f/a.tar.b.gz".match(route.pattern)?.slice(1)).toEqual([
        "a",
        "tar.b",
      ]);
    });

    it("matches a 16 KB hostile segment in linear time", () => {
      for (const key of [
        "GET /r/:a-:b-:c",
        "GET /r/:a-:b",
        "GET /r/:a.:b.:c.:d",
        'GET /r/:"a"_:b',
      ]) {
        const route = parseRouteKey(key);
        for (const unit of ["a", "a-", "a.", "a_", "-"]) {
          const path = `/r/${unit.repeat(16_384 / unit.length)}/x`;
          const start = performance.now();
          route.pattern.test(path);
          expect(performance.now() - start).toBeLessThan(50);
        }
      }
    });
  });

  describe("percent-encoded separators", () => {
    it.each([
      [
        "GET /people/:first :last",
        "/people/Jos%C3%A9%20Ramos",
        ["Jos%C3%A9", "Ramos"],
      ],
      ["GET /t/:a{:b}", "/t/%C3%A9%7Bx%7D", ["%C3%A9", "x"]],
      ["GET /t/:a\u00e9:b", "/t/%C3%A0%C3%A9%C3%A0", ["%C3%A0", "%C3%A0"]],
      ["GET /t/:a %20:b", "/t/%C3%A9%20%20%C3%A9", ["%C3%A9", "%C3%A9"]],
    ])(
      "%s lets the earlier capture hold encoded characters",
      (key, path, params) => {
        const route = parseRouteKey(key);
        expect(path.match(route.pattern)?.slice(1)).toEqual(params);
      },
    );

    it("ends the earlier capture at the first encoded separator", () => {
      const route = parseRouteKey("GET /people/:first :last");
      expect(
        "/people/Mary%20Ann%20Smith".match(route.pattern)?.slice(1),
      ).toEqual(["Mary", "Ann%20Smith"]);
    });

    it("answers a request whose first value is not ASCII", async () => {
      const mock = schmock();
      mock("GET /people/:first :last", ({ params }) => params);
      const response = await mock.handle("GET", "/people/Jos\u00e9 Ramos");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ first: "Jos\u00e9", last: "Ramos" });
    });

    it("matches a 16 KB hostile segment in linear time", () => {
      const route = parseRouteKey("GET /r/:a :b :c");
      for (const unit of ["a", "a%20", "%20", "%C3%A9", "%2"]) {
        const path = `/r/${unit.repeat(Math.ceil(16_384 / unit.length))}/x`;
        const start = performance.now();
        route.pattern.test(path);
        expect(performance.now() - start).toBeLessThan(50);
      }
    });
  });

  describe("hyphens before another parameter", () => {
    it("treats the hyphens as the separator", () => {
      const route = parseRouteKey("GET /range/:from--:to");
      expect(route.params).toEqual(["from", "to"]);
      expect(route.path).toBe("/range/:from--:to");
      expect("/range/1--5".match(route.pattern)?.slice(1)).toEqual(["1", "5"]);
    });

    it("leaves a colon followed only by hyphens as literal text", () => {
      const route = parseRouteKey("GET /x/:--:to");
      expect(route.params).toEqual(["to"]);
      expect(route.pattern.test("/x/:--7")).toBe(true);
    });
  });

  describe("adjacent parameters", () => {
    it.each(["GET /x/:a:b", 'GET /x/:"a":b', "GET /x/:a-:b:c"])(
      "rejects %s",
      (key) => {
        expect(() => parseRouteKey(key)).toThrow(RouteParseError);
        expect(() => parseRouteKey(key)).toThrow(/adjacent/);
      },
    );
  });

  describe("escaped colons", () => {
    it("keeps the escape in the spelling of a route with parameters", () => {
      const route = parseRouteKey("POST /v1/jobs/:job\\:run");
      expect(route.params).toEqual(["job"]);
      expect(route.path).toBe("/v1/jobs/:job\\:run");
      expect("/v1/jobs/abc:run".match(route.pattern)?.[1]).toBe("abc");
      expect(route.pattern.test("/v1/jobs/abc:cancel")).toBe(false);
      expect(route.pattern.test("/v1/jobs/abc")).toBe(false);
    });

    it("drops an escape nothing needs", () => {
      expect(parseRouteKey("GET /a\\:/:id").path).toBe("/a:/:id");
    });

    it("spells a route without parameters as its literal path", () => {
      const route = parseRouteKey("POST /v1/jobs\\:batchGet");
      expect(route.params).toEqual([]);
      expect(route.path).toBe("/v1/jobs:batchGet");
    });

    it("leaves a backslash that does not precede a colon alone", () => {
      const route = parseRouteKey("GET /a\\b/:id");
      expect(route.path).toBe("/a\\b/:id");
      expect(route.pattern.test("/a\\b/1")).toBe(true);
    });
  });

  describe("quoted parameter names", () => {
    it("accepts characters outside the plain grammar", () => {
      const route = parseRouteKey('GET /users/:"user.id"/books/:"book name"');
      expect(route.params).toEqual(["user.id", "book name"]);
      expect(route.path).toBe('/users/:"user.id"/books/:"book name"');
      expect("/users/42/books/7".match(route.pattern)?.slice(1)).toEqual([
        "42",
        "7",
      ]);
    });

    it("ends the name at the closing quote", () => {
      const route = parseRouteKey('GET /f/:"name".json');
      expect(route.params).toEqual(["name"]);
      expect("/f/a.b.json".match(route.pattern)?.[1]).toBe("a.b");
    });
  });
});
