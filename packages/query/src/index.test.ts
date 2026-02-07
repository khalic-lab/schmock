import { describe, expect, it } from "vitest";
import { queryPlugin } from "./index";

describe("queryPlugin", () => {
  it("creates a plugin with correct name", () => {
    const plugin = queryPlugin({ pagination: {} });
    expect(plugin.name).toBe("query");
    expect(plugin.version).toBe("1.0.0");
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
});
