import { describe, expect, it } from "vitest";
import { version as packageVersion } from "../package.json";
import { queryPlugin } from "./index";

describe("queryPlugin", () => {
  it("creates a plugin with correct name", () => {
    const plugin = queryPlugin({ pagination: {} });
    expect(plugin.name).toBe("query");
    expect(plugin.version).toBe(packageVersion);
  });

  it("passes through non-array responses", async () => {
    const plugin = queryPlugin({ pagination: {} });
    const result = await plugin.process(
      {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: {},
        headers: {},
        state: new Map(),
      },
      { message: "not an array" },
    );

    expect(result.response).toEqual({ message: "not an array" });
  });

  it("paginates array responses", async () => {
    const plugin = queryPlugin({
      pagination: { defaultLimit: 2, maxLimit: 10 },
    });

    const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const result = await plugin.process(
      {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: { page: "2", limit: "2" },
        headers: {},
        state: new Map(),
      },
      items,
    );

    expect(result.response).toEqual({
      data: [{ id: 3 }, { id: 4 }],
      pagination: { page: 2, limit: 2, total: 5, totalPages: 3 },
    });
  });

  it("paginates the array body of a two-element status tuple", async () => {
    const plugin = queryPlugin({
      pagination: { defaultLimit: 2, maxLimit: 10 },
    });
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const context: Schmock.PluginContext = {
      path: "/test",
      route: {},
      method: "GET",
      params: {},
      query: { page: "2", limit: "2" },
      headers: {},
      state: new Map(),
    };

    const result = await plugin.process(context, [206, items] satisfies [
      number,
      unknown,
    ]);

    expect(result.response).toEqual([
      206,
      {
        data: [{ id: 3 }, { id: 4 }],
        pagination: { page: 2, limit: 2, total: 5, totalPages: 3 },
      },
    ]);
  });

  it("paginates a status tuple body without changing its headers", async () => {
    const plugin = queryPlugin({
      pagination: { defaultLimit: 2, maxLimit: 10 },
    });
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const headers = {
      "content-type": "application/json",
      "x-response-source": "tuple",
    };
    const context: Schmock.PluginContext = {
      path: "/test",
      route: {},
      method: "GET",
      params: {},
      query: { page: "2", limit: "2" },
      headers: {},
      state: new Map(),
    };

    const result = await plugin.process(context, [
      206,
      items,
      headers,
    ] satisfies [number, unknown, Record<string, string>]);

    expect(result.response).toEqual([
      206,
      {
        data: [{ id: 3 }, { id: 4 }],
        pagination: { page: 2, limit: 2, total: 5, totalPages: 3 },
      },
      headers,
    ]);
  });

  it("paginates a structured response body without changing metadata", async () => {
    const plugin = queryPlugin({
      pagination: { defaultLimit: 2, maxLimit: 10 },
    });
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const response = {
      status: 206,
      body: items,
      headers: { "x-response-source": "structured" },
    };
    const context: Schmock.PluginContext = {
      path: "/test",
      route: {},
      method: "GET",
      params: {},
      query: { page: "2", limit: "2" },
      headers: {},
      state: new Map(),
    };

    const result = await plugin.process(context, response);

    expect(result.response).toEqual({
      status: 206,
      body: {
        data: [{ id: 3 }, { id: 4 }],
        pagination: { page: 2, limit: 2, total: 5, totalPages: 3 },
      },
      headers: { "x-response-source": "structured" },
    });
  });

  it("passes response containers through when their semantic body is not an array", async () => {
    const plugin = queryPlugin({ pagination: { defaultLimit: 2 } });
    const context: Schmock.PluginContext = {
      path: "/test",
      route: {},
      method: "GET",
      params: {},
      query: { page: "2", limit: "2" },
      headers: {},
      state: new Map(),
    };
    const responses: unknown[] = [
      [
        202,
        { message: "accepted" },
        { "x-response-source": "tuple" },
      ] satisfies [number, unknown, Record<string, string>],
      {
        status: 202,
        body: { message: "accepted" },
        headers: { "x-response-source": "structured" },
      },
    ];

    for (const response of responses) {
      const result = await plugin.process(context, response);
      expect(result.response).toBe(response);
    }
  });

  it("sorts array responses", async () => {
    const plugin = queryPlugin({
      sorting: { allowed: ["name"], default: "name" },
    });

    const items = [
      { id: 3, name: "Charlie" },
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];

    const result = await plugin.process(
      {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: { sort: "name", order: "asc" },
        headers: {},
        state: new Map(),
      },
      items,
    );

    expect(result.response.map((i: any) => i.name)).toEqual([
      "Alice",
      "Bob",
      "Charlie",
    ]);
  });

  it("filters array responses", async () => {
    const plugin = queryPlugin({
      filtering: { allowed: ["role"] },
    });

    const items = [
      { id: 1, name: "Alice", role: "admin" },
      { id: 2, name: "Bob", role: "user" },
      { id: 3, name: "Charlie", role: "admin" },
    ];

    const result = await plugin.process(
      {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: { "filter[role]": "admin" },
        headers: {},
        state: new Map(),
      },
      items,
    );

    expect(result.response).toHaveLength(2);
    expect(result.response.every((i: any) => i.role === "admin")).toBe(true);
  });

  it("respects maxLimit", async () => {
    const plugin = queryPlugin({
      pagination: { defaultLimit: 5, maxLimit: 3 },
    });

    const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const result = await plugin.process(
      {
        path: "/test",
        route: {},
        method: "GET",
        params: {},
        query: { limit: "100" },
        headers: {},
        state: new Map(),
      },
      items,
    );

    expect(result.response.data).toHaveLength(3);
  });

  describe("filtering edge cases", () => {
    it("returns empty result when input array is empty", async () => {
      const plugin = queryPlugin({
        filtering: { allowed: ["role"] },
      });

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: { "filter[role]": "admin" },
          headers: {},
          state: new Map(),
        },
        [],
      );

      expect(result.response).toEqual([]);
    });

    it("excludes items that lack the filter field", async () => {
      const plugin = queryPlugin({
        filtering: { allowed: ["role"] },
      });

      const items = [
        { id: 1, role: "admin" },
        { id: 2, name: "no-role" },
        { id: 3, role: "admin" },
      ];

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: { "filter[role]": "admin" },
          headers: {},
          state: new Map(),
        },
        items,
      );

      expect(result.response).toHaveLength(2);
      expect(result.response.every((i: any) => i.role === "admin")).toBe(true);
    });

    it("handles filter value with special regex characters as literal string", async () => {
      const plugin = queryPlugin({
        filtering: { allowed: ["domain"] },
      });

      const items = [
        { id: 1, domain: "foo.bar" },
        { id: 2, domain: "fooXbar" },
        { id: 3, domain: "foo.bar" },
      ];

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: { "filter[domain]": "foo.bar" },
          headers: {},
          state: new Map(),
        },
        items,
      );

      expect(result.response).toHaveLength(2);
      expect(result.response.every((i: any) => i.domain === "foo.bar")).toBe(
        true,
      );
    });

    it("ignores the plain field=value form", async () => {
      const plugin = queryPlugin({ filtering: { allowed: ["role"] } });

      const items = [
        { id: 1, role: "admin" },
        { id: 2, role: "user" },
      ];

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: { role: "admin" },
          headers: {},
          state: new Map(),
        },
        items,
      );

      expect(result.response).toEqual(items);
    });

    it("does not consume pagination controls as filters", async () => {
      const plugin = queryPlugin({
        pagination: { defaultLimit: 1 },
        filtering: { allowed: ["page"] },
      });

      const items = [
        { id: 1, page: "2" },
        { id: 2, page: "1" },
      ];

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: { page: "2" },
          headers: {},
          state: new Map(),
        },
        items,
      );

      expect(result.response.pagination).toEqual({
        page: 2,
        limit: 1,
        total: 2,
        totalPages: 2,
      });
      expect(result.response.data).toEqual([{ id: 2, page: "1" }]);
    });

    it("supports both prefixed filter forms", async () => {
      const items = [
        { id: 1, role: "admin" },
        { id: 2, role: "user" },
      ];

      for (const key of ["filter[role]", "filter.role"]) {
        const plugin = queryPlugin({ filtering: { allowed: ["role"] } });
        const result = await plugin.process(
          {
            path: "/test",
            route: {},
            method: "GET",
            params: {},
            query: { [key]: "admin" },
            headers: {},
            state: new Map(),
          },
          items,
        );

        expect(result.response).toEqual([{ id: 1, role: "admin" }]);
      }
    });
  });

  describe("sorting edge cases", () => {
    const sortScores = async (
      scores: unknown[],
      order: "asc" | "desc" = "asc",
    ) => {
      const plugin = queryPlugin({
        sorting: { allowed: ["score"], default: "score" },
      });

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: { sort: "score", order },
          headers: {},
          state: new Map(),
        },
        scores.map((score, index) => ({ id: index + 1, score })),
      );

      return (result.response as { score: unknown }[]).map((i) => i.score);
    };

    const permutations = <T>(values: T[]): T[][] => {
      if (values.length <= 1) return [values];
      return values.flatMap((value, index) =>
        permutations([
          ...values.slice(0, index),
          ...values.slice(index + 1),
        ]).map((rest) => [value, ...rest]),
      );
    };

    it("orders mixed numeric and string values independently of input order", async () => {
      // Numbers sort before strings, so the result never depends on input order
      for (const permutation of permutations([10, "5", 2])) {
        expect(await sortScores(permutation)).toEqual([2, 10, "5"]);
      }
    });

    it("produces a permutation-invariant order for every mixed-type triple", async () => {
      const values: unknown[] = [3, 10, "1z", "2", "apple", true, false, null];

      for (let a = 0; a < values.length; a++) {
        for (let b = a + 1; b < values.length; b++) {
          for (let c = b + 1; c < values.length; c++) {
            const triple = [values[a], values[b], values[c]];
            const [expected, ...others] = await Promise.all(
              permutations(triple).map((permutation) =>
                sortScores(permutation),
              ),
            );

            for (const actual of others) {
              expect(actual).toEqual(expected);
            }
          }
        }
      }
    });

    it("groups non-finite numbers between finite numbers and strings", async () => {
      expect(await sortScores(["a", Number.NaN, 1])).toEqual([
        1,
        Number.NaN,
        "a",
      ]);
    });

    it("mirrors the ascending order when sorting descending", async () => {
      const values = [3, "1z", true, 10, "apple"];
      const ascending = await sortScores(values);

      expect(await sortScores(values, "desc")).toEqual(
        [...ascending].reverse(),
      );
    });

    it("pushes items with undefined sort field values to the end", async () => {
      const plugin = queryPlugin({
        sorting: { allowed: ["name"], default: "name" },
      });

      const items = [
        { id: 1 },
        { id: 2, name: "Alice" },
        { id: 3, name: "Bob" },
      ];

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: { sort: "name", order: "asc" },
          headers: {},
          state: new Map(),
        },
        items,
      );

      expect(result.response[0].name).toBe("Alice");
      expect(result.response[1].name).toBe("Bob");
      expect(result.response[2].name).toBeUndefined();
    });

    it("maintains relative order for items with equal sort values", async () => {
      const plugin = queryPlugin({
        sorting: { allowed: ["priority"], default: "priority" },
      });

      const items = [
        { id: 1, priority: 1, label: "first" },
        { id: 2, priority: 1, label: "second" },
        { id: 3, priority: 1, label: "third" },
      ];

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: { sort: "priority", order: "asc" },
          headers: {},
          state: new Map(),
        },
        items,
      );

      // Sort stability: equal values preserve insertion order
      expect(result.response.map((i: any) => i.label)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });
  });

  describe("pagination edge cases", () => {
    const makePaginationPlugin = (defaultLimit = 10, maxLimit = 100) =>
      queryPlugin({
        pagination: { defaultLimit, maxLimit },
      });

    const items = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));

    const makeContext = (query: Record<string, string>) => ({
      path: "/test",
      route: {},
      method: "GET" as const,
      params: {},
      query,
      headers: {},
      state: new Map(),
    });

    it("clamps page=0 to page 1", async () => {
      const plugin = makePaginationPlugin(2);
      const result = await plugin.process(makeContext({ page: "0" }), items);

      expect(result.response.pagination.page).toBe(1);
      expect(result.response.data).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it("clamps page=-1 to page 1", async () => {
      const plugin = makePaginationPlugin(2);
      const result = await plugin.process(makeContext({ page: "-1" }), items);

      expect(result.response.pagination.page).toBe(1);
      expect(result.response.data).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it("falls back to defaultLimit when limit=0 (below the minimum of 1)", async () => {
      const plugin = makePaginationPlugin(10, 100);
      const result = await plugin.process(makeContext({ limit: "0" }), items);

      // 0 is a valid integer but below the minimum of 1 → falls back to defaultLimit (10)
      expect(result.response.pagination.limit).toBe(10);
      expect(result.response.data).toHaveLength(5);
    });

    it("clamps limit exceeding maxLimit to maxLimit", async () => {
      const plugin = makePaginationPlugin(10, 3);
      const result = await plugin.process(makeContext({ limit: "999" }), items);

      expect(result.response.pagination.limit).toBe(3);
      expect(result.response.data).toHaveLength(3);
    });

    it("defaults gracefully when page is non-numeric", async () => {
      const plugin = makePaginationPlugin(2);
      const result = await plugin.process(makeContext({ page: "abc" }), items);

      expect(result.response.pagination.page).toBe(1);
      expect(result.response.data).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it("defaults gracefully when limit is non-numeric", async () => {
      const plugin = makePaginationPlugin(2);
      const result = await plugin.process(makeContext({ limit: "abc" }), items);

      expect(result.response.pagination.limit).toBe(2);
      expect(result.response.data).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it("returns empty data with correct total for a very large page number", async () => {
      const plugin = makePaginationPlugin(2);
      const result = await plugin.process(makeContext({ page: "9999" }), items);

      expect(result.response.data).toEqual([]);
      expect(result.response.pagination.total).toBe(5);
      expect(result.response.pagination.totalPages).toBe(3);
    });

    it("returns data=[], total=0, totalPages=0 for empty array input", async () => {
      const plugin = makePaginationPlugin(10);
      const result = await plugin.process(makeContext({}), []);

      expect(result.response.data).toEqual([]);
      expect(result.response.pagination.total).toBe(0);
      expect(result.response.pagination.totalPages).toBe(0);
    });
  });

  describe("process method edge cases", () => {
    it("passes through null response unchanged", async () => {
      const plugin = queryPlugin({
        pagination: { defaultLimit: 10 },
        filtering: { allowed: ["role"] },
        sorting: { allowed: ["name"] },
      });

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: {},
          headers: {},
          state: new Map(),
        },
        null,
      );

      expect(result.response).toBeNull();
    });

    it("passes through object (non-array) response unchanged", async () => {
      const plugin = queryPlugin({
        pagination: { defaultLimit: 10 },
        filtering: { allowed: ["role"] },
        sorting: { allowed: ["name"] },
      });

      const obj = { message: "hello", count: 42 };
      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: {},
          headers: {},
          state: new Map(),
        },
        obj,
      );

      expect(result.response).toEqual(obj);
    });

    it("passes through undefined response unchanged", async () => {
      const plugin = queryPlugin({
        pagination: { defaultLimit: 10 },
        filtering: { allowed: ["role"] },
        sorting: { allowed: ["name"] },
      });

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: {},
          headers: {},
          state: new Map(),
        },
        undefined,
      );

      expect(result.response).toBeUndefined();
    });
  });

  describe("option validation", () => {
    const invalidOptions: [string, string, unknown][] = [
      [
        "maxLimit 0",
        "pagination.maxLimit must be a positive integer",
        { pagination: { maxLimit: 0 } },
      ],
      [
        "maxLimit -5",
        "pagination.maxLimit must be a positive integer",
        { pagination: { maxLimit: -5 } },
      ],
      [
        "defaultLimit NaN",
        "pagination.defaultLimit must be a positive integer",
        { pagination: { defaultLimit: Number.NaN } },
      ],
      [
        "defaultLimit 2.5",
        "pagination.defaultLimit must be a positive integer",
        { pagination: { defaultLimit: 2.5 } },
      ],
      [
        "empty pageParam",
        "pagination.pageParam must be a non-empty string",
        { pagination: { pageParam: "" } },
      ],
      [
        "empty limitParam",
        "pagination.limitParam must be a non-empty string",
        { pagination: { limitParam: "" } },
      ],
      [
        "empty sortParam",
        "sorting.sortParam must be a non-empty string",
        { sorting: { allowed: ["name"], sortParam: "" } },
      ],
      [
        "empty orderParam",
        "sorting.orderParam must be a non-empty string",
        { sorting: { allowed: ["name"], orderParam: "" } },
      ],
      [
        "empty filterPrefix",
        "filtering.filterPrefix must be a non-empty string",
        { filtering: { allowed: ["role"], filterPrefix: "" } },
      ],
      [
        "missing sorting.allowed",
        "sorting.allowed must be an array of field names",
        { sorting: {} },
      ],
      [
        "non-array filtering.allowed",
        "filtering.allowed must be an array of field names",
        { filtering: { allowed: "role" } },
      ],
      [
        "empty allowed field name",
        "sorting.allowed must contain only non-empty field names",
        { sorting: { allowed: [""] } },
      ],
      [
        "__proto__ in filtering.allowed",
        "filtering.allowed must not contain the reserved field name",
        { filtering: { allowed: ["__proto__"] } },
      ],
      [
        "constructor in sorting.allowed",
        "sorting.allowed must not contain the reserved field name",
        { sorting: { allowed: ["constructor"] } },
      ],
      [
        "prototype in filtering.allowed",
        "filtering.allowed must not contain the reserved field name",
        { filtering: { allowed: ["prototype"] } },
      ],
    ];

    for (const [label, expectedMessage, options] of invalidOptions) {
      it(`rejects ${label}`, () => {
        expect(() => queryPlugin(options as any)).toThrow(expectedMessage);
      });
    }

    it("throws a SchmockError carrying the QUERY_CONFIG_INVALID code", () => {
      expect.assertions(3);
      try {
        queryPlugin({ pagination: { maxLimit: 0 } });
      } catch (error) {
        expect((error as Error).name).toBe("SchmockError");
        expect((error as { code: string }).code).toBe("QUERY_CONFIG_INVALID");
        expect((error as Error).message).toMatch(
          /^queryPlugin: pagination\.maxLimit must be a positive integer \(received 0\)$/,
        );
      }
    });

    it("accepts every valid option", () => {
      expect(() =>
        queryPlugin({
          pagination: {
            defaultLimit: 5,
            maxLimit: 50,
            pageParam: "p",
            limitParam: "l",
          },
          sorting: {
            allowed: ["name"],
            default: "name",
            defaultOrder: "desc",
            sortParam: "s",
            orderParam: "o",
          },
          filtering: { allowed: ["role"], filterPrefix: "where" },
        }),
      ).not.toThrow();
    });
  });

  describe("optional options", () => {
    it("can be created without any options", () => {
      expect(() => queryPlugin()).not.toThrow();
    });

    it("passes array responses through untouched when no options are given", async () => {
      const plugin = queryPlugin();
      const items = [{ id: 1 }, { id: 2 }];

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: { page: "2", limit: "1", sort: "id" },
          headers: {},
          state: new Map(),
        },
        items,
      );

      expect(result.response).toEqual(items);
    });

    it("passes non-array responses through when no options are given", async () => {
      const plugin = queryPlugin();
      const body = { message: "hello" };

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: {},
          headers: {},
          state: new Map(),
        },
        body,
      );

      expect(result.response).toBe(body);
    });
  });

  describe("strict query value parsing", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));

    const paginate = async (query: Record<string, string>) => {
      const plugin = queryPlugin({
        pagination: { defaultLimit: 10, maxLimit: 100 },
      });
      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query,
          headers: {},
          state: new Map(),
        },
        items,
      );
      return result.response.pagination;
    };

    const rejected: [string, string][] = [
      ["partially numeric", "3abc"],
      ["exponent notation", "1e2"],
      ["fractional", "2.9"],
      ["whitespace padded", " 2 "],
      ["negative", "-1"],
      ["hexadecimal", "0x10"],
      ["signed", "+2"],
      ["zero", "0"],
    ];

    for (const [label, value] of rejected) {
      it(`falls back to page 1 for a ${label} page value`, async () => {
        expect((await paginate({ page: value })).page).toBe(1);
      });

      it(`falls back to defaultLimit for a ${label} limit value`, async () => {
        expect((await paginate({ limit: value })).limit).toBe(10);
      });
    }

    it("falls back to page 1 for an unsafe integer page value", async () => {
      const pagination = await paginate({ page: "999999999999999999999" });

      expect(pagination.page).toBe(1);
      expect(pagination.totalPages).toBe(3);
    });

    it("accepts exact integer values", async () => {
      expect(await paginate({ page: "2", limit: "5" })).toEqual({
        page: 2,
        limit: 5,
        total: 25,
        totalPages: 5,
      });
    });
  });

  describe("own-property access", () => {
    const makeContext = (query: Record<string, string>) => ({
      path: "/test",
      route: {},
      method: "GET" as const,
      params: {},
      query,
      headers: {},
      state: new Map(),
    });

    it("does not treat inherited query keys as filter values", async () => {
      const plugin = queryPlugin({ filtering: { allowed: ["role"] } });
      const items = [
        { id: 1, role: "user" },
        { id: 2, role: "admin" },
      ];
      // The filter key the plugin looks up exists, but only on the prototype:
      // a prototype-consulting read would filter down to the admin item.
      const query: Record<string, string> = Object.create({
        "filter[role]": "admin",
      });

      const result = await plugin.process(makeContext(query), items);

      expect(result.response).toEqual(items);
    });

    it("does not treat inherited query keys as sort controls", async () => {
      const plugin = queryPlugin({
        sorting: { allowed: ["name"], default: "name", sortParam: "toString" },
      });
      const items = [{ name: "Charlie" }, { name: "Alice" }, { name: "Bob" }];

      const result = await plugin.process(makeContext({}), items);

      expect(result.response.map((i: any) => i.name)).toEqual([
        "Alice",
        "Bob",
        "Charlie",
      ]);
    });

    it("does not treat inherited query keys as pagination controls", async () => {
      const plugin = queryPlugin({ pagination: { defaultLimit: 2 } });
      // `page` resolves to "3" through the prototype chain only: a
      // prototype-consulting read would return page 3 with no data.
      const query: Record<string, string> = Object.create({ page: "3" });

      const result = await plugin.process(makeContext(query), [
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ]);

      expect(result.response.pagination.page).toBe(1);
      expect(result.response.data).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it("ignores inherited item properties when filtering", async () => {
      const plugin = queryPlugin({ filtering: { allowed: ["role"] } });
      const own = { id: 1, role: "admin" };
      const inherited = Object.create({ role: "admin" });
      inherited.id = 2;

      const result = await plugin.process(
        makeContext({ "filter[role]": "admin" }),
        [own, inherited],
      );

      expect(result.response).toEqual([own]);
    });

    it("ignores inherited item properties when sorting", async () => {
      const plugin = queryPlugin({
        sorting: { allowed: ["name"], default: "name" },
      });
      const inherited = Object.create({ name: "Aaron" });
      inherited.id = 1;
      const own = { id: 2, name: "Zoe" };

      const result = await plugin.process(makeContext({}), [inherited, own]);

      expect(result.response[0]).toBe(own);
      expect(result.response[1]).toBe(inherited);
    });
  });
});
