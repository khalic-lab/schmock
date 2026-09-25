import { getResponseParts, replaceResponseBody, schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { queryPlugin } from "./index";

function context(
  overrides: Partial<Schmock.PluginContext> = {},
): Schmock.PluginContext {
  return {
    path: "/items",
    route: {},
    method: "GET",
    params: {},
    query: {},
    headers: {},
    state: new Map(),
    ...overrides,
  };
}

const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
const firstPage = {
  data: [{ id: 1 }],
  pagination: { page: 1, limit: 1, total: 3, totalPages: 3 },
};

function paginating(): Schmock.Plugin {
  return queryPlugin({ pagination: { defaultLimit: 1 } });
}

/** Tuples whose third element core refuses as headers. */
const malformedHeaderElements: ReadonlyArray<[string, unknown]> = [
  ["a string", "not-a-record"],
  ["an array", ["x-a"]],
  ["null", null],
  ["a number", 5],
  ["a record with a non-string value", { n: 5 }],
];

describe("queryPlugin consumes core's response decomposition (R9)", () => {
  describe("a tuple whose third element is not a string record", () => {
    for (const [label, third] of malformedHeaderElements) {
      it(`reshapes the body and carries ${label} through as core would`, async () => {
        const response = [200, items, third];

        const result = await paginating().process(context(), response);

        expect(getResponseParts(response).kind).toBe("tuple");
        expect(result.response).toEqual([200, firstPage, third]);
        expect(result.response).toEqual(
          replaceResponseBody(response, firstPage),
        );
        if (!Array.isArray(result.response)) {
          throw new Error("Expected the tuple shape to be kept");
        }
        expect(result.response[2]).toBe(third);
        expect(result.response).not.toBe(response);
        expect(response[1]).toBe(items);
      });

      it(`leaves a 4xx tuple carrying ${label} untouched`, async () => {
        const response = [404, items, third];

        const result = await paginating().process(context(), response);

        expect(result.response).toBe(response);
      });
    }

    it("still reaches core, which rejects it as INVALID_RESPONSE", async () => {
      const mock = schmock();
      mock("GET /items", () => [200, items, "not-a-record"]).pipe(paginating());

      const response = await mock.handle("GET", "/items");

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: "INVALID_RESPONSE" });
    });

    it("rejects non-string header values the same way end to end", async () => {
      const mock = schmock();
      mock("GET /items", () => [200, items, { n: 5 }]).pipe(paginating());

      const response = await mock.handle("GET", "/items");

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        code: "INVALID_RESPONSE",
        error: "Invalid response: header values must be strings",
      });
    });
  });

  describe("agrees with getResponseParts on every shape", () => {
    const shapes: ReadonlyArray<[string, unknown, boolean]> = [
      ["a plain array", items, true],
      ["a two-element tuple", [200, items], true],
      ["a tuple with headers", [206, items, { "x-a": "1" }], true],
      ["a 3xx tuple", [304, items], true],
      ["an envelope", { status: 200, body: items }, true],
      [
        "an envelope with headers",
        { status: 200, body: items, headers: { "x-a": "1" } },
        true,
      ],
      [
        "an envelope with undefined headers",
        { status: 200, body: items, headers: undefined },
        true,
      ],
      ["a 4xx envelope", { status: 422, body: items }, false],
      ["a 5xx tuple", [503, items], false],
      [
        "an object with non-string headers (not an envelope)",
        { status: 200, body: items, headers: { n: 1 } },
        false,
      ],
      [
        "an object with array headers (not an envelope)",
        { status: 200, body: items, headers: ["x"] },
        false,
      ],
      ["an object without a body", { status: 200, items }, false],
      ["an object with a string status", { status: "200", body: items }, false],
      ["null", null, false],
      ["undefined", undefined, false],
    ];

    for (const [label, response, reshaped] of shapes) {
      it(`${reshaped ? "reshapes" : "passes through"} ${label}`, async () => {
        const result = await paginating().process(context(), response);

        if (reshaped) {
          expect(result.response).toEqual(
            replaceResponseBody(response, firstPage),
          );
          expect(getResponseParts(result.response).body).toEqual(firstPage);
        } else {
          expect(result.response).toBe(response);
        }
      });
    }

    it("reshapes a four-element array as a plain list of four items", async () => {
      // Not a status tuple, so core delivers the array whole: the plugin
      // paginates it as data, exactly as core would deliver it.
      const response = [200, items, {}, {}];
      const plugin = queryPlugin({ pagination: { defaultLimit: 2 } });

      const result = await plugin.process(context(), response);

      expect(getResponseParts(response).kind).toBe("plain");
      expect(result.response).toEqual({
        data: [200, items],
        pagination: { page: 1, limit: 2, total: 4, totalPages: 2 },
      });
    });

    it("reshapes an out-of-range status pair as a plain list", async () => {
      const response = [99, items];
      const plugin = queryPlugin({ pagination: { defaultLimit: 1 } });

      const result = await plugin.process(context(), response);

      expect(getResponseParts(response).kind).toBe("plain");
      expect(result.response).toEqual({
        data: [99],
        pagination: { page: 1, limit: 1, total: 2, totalPages: 2 },
      });
    });
  });

  it("does not mutate the envelope it reshapes", async () => {
    const headers = { "x-a": "1" };
    const response = { status: 200, body: items, headers, extra: true };

    const result = await paginating().process(context(), response);

    expect(result.response).toEqual({ status: 200, body: firstPage, headers });
    expect(response).toEqual({
      status: 200,
      body: items,
      headers,
      extra: true,
    });
  });

  describe("tuple headers are read while the plugin runs", () => {
    // getResponseParts copies the carried headers, so the plugin now reads the
    // third element itself. Before R9 it was first read by core's parser, and
    // a throwing getter surfaced as INTERNAL_ERROR instead of PLUGIN_ERROR.
    it("reports a throwing header getter as the query plugin's failure", async () => {
      const headers = {
        get "x-a"(): string {
          throw new Error("boom");
        },
      };
      const mock = schmock();
      mock("GET /items", () => [200, items, headers]).pipe(paginating());

      const response = await mock.handle("GET", "/items");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Plugin "query" failed: boom',
        code: "PLUGIN_ERROR",
      });
    });

    it("still delivers headers exposed through a getter", async () => {
      const headers = {
        get "x-a"(): string {
          return "1";
        },
      };
      const mock = schmock();
      mock("GET /items", () => [200, items, headers]).pipe(paginating());

      const response = await mock.handle("GET", "/items");

      expect(response.status).toBe(200);
      expect(response.headers).toMatchObject({ "x-a": "1" });
      expect(response.body).toEqual(firstPage);
    });
  });
});

describe("queryPlugin isObjectLike keeps accepting arrays (R15)", () => {
  it("filters array items by their own index keys", async () => {
    const plugin = queryPlugin({ filtering: { allowed: ["0"] } });
    const rows = [
      ["a", 1],
      ["b", 2],
      ["a", 3],
    ];

    const result = await plugin.process(
      context({ query: { "filter[0]": "a" } }),
      rows,
    );

    expect(result.response).toEqual([
      ["a", 1],
      ["a", 3],
    ]);
  });

  it("sorts array items by their own index keys", async () => {
    const plugin = queryPlugin({ sorting: { allowed: ["1"] } });
    const rows = [
      ["b", 2],
      ["a", 3],
      ["c", 1],
    ];

    const result = await plugin.process(
      context({ query: { sort: "1", order: "desc" } }),
      rows,
    );

    expect(result.response).toEqual([
      ["a", 3],
      ["b", 2],
      ["c", 1],
    ]);
  });

  it("still drops primitive items from a filtered list", async () => {
    const plugin = queryPlugin({ filtering: { allowed: ["id"] } });

    const result = await plugin.process(
      context({ query: { "filter[id]": "1" } }),
      [{ id: 1 }, 1, "1", null, { id: 2 }],
    );

    expect(result.response).toEqual([{ id: 1 }]);
  });
});
