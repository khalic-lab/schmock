import { describe, expect, it } from "vitest";
import { type QueryPluginOptions, queryPlugin } from "./index";

function context(
  overrides: Partial<Schmock.PluginContext> = {},
): Schmock.PluginContext {
  return {
    path: "/test",
    route: {},
    method: "GET",
    params: {},
    query: {},
    headers: {},
    state: new Map(),
    ...overrides,
  };
}

function creationError(options: QueryPluginOptions): unknown {
  try {
    queryPlugin(options);
  } catch (error) {
    return error;
  }
  return undefined;
}

const items = [{ n: "b" }, { n: "a" }, { n: "c" }];

describe("queryPlugin error responses", () => {
  const plugin = queryPlugin({
    pagination: { defaultLimit: 1 },
    sorting: { allowed: ["n"], default: "n" },
  });

  it("leaves a structured 5xx array body untouched", async () => {
    const response = { status: 503, body: items };
    const result = await plugin.process(context(), response);
    expect(result.response).toBe(response);
  });

  it("leaves a 4xx tuple with headers untouched", async () => {
    const response = [409, items, { "x-reason": "conflict" }];
    const result = await plugin.process(context(), response);
    expect(result.response).toBe(response);
  });

  it("still transforms a 3xx array body", async () => {
    const result = await plugin.process(context(), [300, items]);
    expect(result.response).toEqual([
      300,
      {
        data: [{ n: "a" }],
        pagination: { page: 1, limit: 1, total: 3, totalPages: 3 },
      },
    ]);
  });

  it("still paginates a short-circuited 2xx array", async () => {
    const result = await plugin.process(
      context({ requestShortCircuited: true }),
      [200, items],
    );
    expect(result.response).toEqual([
      200,
      {
        data: [{ n: "a" }],
        pagination: { page: 1, limit: 1, total: 3, totalPages: 3 },
      },
    ]);
  });
});

describe("queryPlugin sorting option validation", () => {
  it("accepts a default field in the allowed list and either order", () => {
    expect(
      creationError({
        sorting: { allowed: ["n"], default: "n", defaultOrder: "desc" },
      }),
    ).toBeUndefined();
    expect(
      creationError({ sorting: { allowed: ["n"], defaultOrder: "asc" } }),
    ).toBeUndefined();
  });

  it.each([
    ["an empty string", ""],
    ["a number", 1],
  ])("rejects %s as the default sort field", (_, field) => {
    const sorting = { allowed: ["n"] };
    Reflect.set(sorting, "default", field);
    expect(creationError({ sorting })).toMatchObject({
      code: "QUERY_CONFIG_INVALID",
      context: { option: "sorting.default", received: field },
    });
  });

  it.each([
    ["an upper-case order", "ASC"],
    ["an unknown order", "sideways"],
    ["null", null],
  ])("rejects %s as the default sort order", (_, order) => {
    const sorting = { allowed: ["n"] };
    Reflect.set(sorting, "defaultOrder", order);
    expect(creationError({ sorting })).toMatchObject({
      code: "QUERY_CONFIG_INVALID",
      context: { option: "sorting.defaultOrder", received: order },
    });
  });
});

describe("queryPlugin order and limit handling", () => {
  it("matches a mixed-case order value", async () => {
    const plugin = queryPlugin({ sorting: { allowed: ["n"] } });
    const result = await plugin.process(
      context({ query: { sort: "n", order: "Desc" } }),
      items,
    );
    expect(result.response).toEqual([{ n: "c" }, { n: "b" }, { n: "a" }]);
  });

  describe("sorting defaults", () => {
    const descending = [{ n: "c" }, { n: "b" }, { n: "a" }];
    const plugin = queryPlugin({
      sorting: { allowed: ["n"], default: "n", defaultOrder: "desc" },
    });

    it.each([
      ["an empty order", { order: "" }],
      ["an unrecognised order", { order: "sideways" }],
      ["a spelled-out order", { order: "descending" }],
      ["an empty sort field", { sort: "" }],
      ["a sort field outside the allowed list", { sort: "secret" }],
      ["an empty sort and order", { sort: "", order: "" }],
    ])("falls back to the configured defaults for %s", async (_, query) => {
      const result = await plugin.process(context({ query }), items);
      expect(result.response).toEqual(descending);
    });

    it("lets a recognised order override the default order", async () => {
      const result = await plugin.process(
        context({ query: { order: "ASC" } }),
        items,
      );
      expect(result.response).toEqual([{ n: "a" }, { n: "b" }, { n: "c" }]);
    });

    it("keeps the default order for an allowed sort field", async () => {
      const result = await plugin.process(
        context({ query: { sort: "n", order: "" } }),
        items,
      );
      expect(result.response).toEqual(descending);
    });

    it("leaves the list unsorted for a disallowed field without a default", async () => {
      const unsorted = queryPlugin({ sorting: { allowed: ["n"] } });
      const result = await unsorted.process(
        context({ query: { sort: "secret", order: "desc" } }),
        items,
      );
      expect(result.response).toEqual(items);
    });

    it("pages the default order when the order value is empty", async () => {
      const paged = queryPlugin({
        pagination: { defaultLimit: 2 },
        sorting: { allowed: ["n"], default: "n", defaultOrder: "desc" },
      });
      const result = await paged.process(
        context({ query: { page: "2", order: "" } }),
        items,
      );
      expect(result.response).toMatchObject({ data: [{ n: "a" }] });
    });
  });

  it("clamps a default limit above maxLimit to maxLimit", async () => {
    const plugin = queryPlugin({
      pagination: { defaultLimit: 5, maxLimit: 2 },
    });
    const result = await plugin.process(context(), items);
    expect(result.response).toMatchObject({
      pagination: { limit: 2, total: 3, totalPages: 2 },
    });
  });
});
