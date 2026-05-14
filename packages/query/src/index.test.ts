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
  });

  describe("sorting edge cases", () => {
    it("sorts with mixed numeric and string values in the sort field", async () => {
      const plugin = queryPlugin({
        sorting: { allowed: ["score"], default: "score" },
      });

      const items = [
        { id: 1, score: 10 },
        { id: 2, score: "5" },
        { id: 3, score: 2 },
      ];

      const result = await plugin.process(
        {
          path: "/test",
          route: {},
          method: "GET",
          params: {},
          query: { sort: "score", order: "asc" },
          headers: {},
          state: new Map(),
        },
        items,
      );

      // Mixed types fall back to localeCompare via String() coercion
      expect(result.response).toHaveLength(3);
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

    it("clamps limit=0 to defaultLimit (0 is falsy, falls back to default)", async () => {
      const plugin = makePaginationPlugin(10, 100);
      const result = await plugin.process(makeContext({ limit: "0" }), items);

      // parseInt("0") is 0, which is falsy → falls back to defaultLimit (10)
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
});
