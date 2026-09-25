import type { CallableMockInstance } from "@schmock/core";
import { parseNodeQuery, schmock } from "@schmock/core";
import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { toExpress } from "./index";

/** A real Express app over an echo route, using the given query parser. */
function echoApp(queryParser?: "extended" | "simple") {
  const mock = schmock();
  mock("GET /echo", ({ query }) => ({ query }));
  const app = express();
  if (queryParser) app.set("query parser", queryParser);
  app.use(toExpress(mock));
  return app;
}

/** What the CLI and `mock.listen()` hand the mock for the same URL. */
function cliQuery(path: string): Record<string, string> {
  return parseNodeQuery(new URL(path, "http://localhost"));
}

describe("Express default query transform matches the CLI", () => {
  const urls = [
    "/echo?filter[name]=rex&filter[age]=3",
    "/echo?sort[]=x",
    "/echo?tag=a&tag=b",
    "/echo?filter.name=rex&plain=1",
    "/echo?q=a%20b%2Bc",
  ];

  it.each(["extended", "simple"] as const)(
    "with the %s query parser",
    async (parser) => {
      const app = echoApp(parser);
      for (const url of urls) {
        const response = await request(app).get(url);
        expect(response.status, url).toBe(200);
        expect(response.body.query, url).toEqual(cliQuery(url));
      }
    },
  );

  it("still hands req.query to a custom transformQuery", async () => {
    const mock = schmock();
    mock("GET /echo", ({ query }) => ({ query }));
    const transformQuery = vi.fn((query: Request["query"]) => ({
      seen: JSON.stringify(query),
    }));
    const app = express();
    app.set("query parser", "extended");
    app.use(toExpress(mock, { transformQuery }));

    const response = await request(app).get("/echo?filter[name]=rex");

    expect(transformQuery).toHaveBeenCalledWith({ filter: { name: "rex" } });
    expect(response.body.query).toEqual({
      seen: JSON.stringify({ filter: { name: "rex" } }),
    });
  });

  it("flattens a nested req.query into bracket keys when no URL is available", async () => {
    const mock = {
      handle: vi.fn(async () => ({ status: 200, body: "ok", headers: {} })),
      pipe: vi.fn(),
    };
    const req = {
      method: "GET",
      path: "/",
      headers: {},
      body: undefined,
      query: { filter: { name: "rex", tags: ["a", "b"] }, tag: ["x", "y"] },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await toExpress(mock as unknown as CallableMockInstance)(
      req as unknown as Request,
      res as unknown as Response,
      vi.fn(),
    );

    expect(mock.handle).toHaveBeenCalledWith(
      "GET",
      "/",
      expect.objectContaining({
        query: { "filter[name]": "rex", "filter[tags]": "b", tag: "y" },
      }),
    );
  });
});

describe("Express default query follows the URL req.path comes from", () => {
  function echoMock(): CallableMockInstance {
    const mock = schmock();
    mock("GET /echo", ({ query }) => ({ query }));
    return mock;
  }

  it("reads the query of a URL rewritten by earlier middleware", async () => {
    const app = express();
    app.use((req, _res, next) => {
      if (req.url.startsWith("/legacy")) req.url = "/echo?limit=5";
      next();
    });
    app.use(toExpress(echoMock()));

    const response = await request(app).get("/legacy?page=2");

    expect(response.status).toBe(200);
    expect(response.body.query).toEqual({ limit: "5" });
  });

  it("keeps the query under a mounted router", async () => {
    const router = express.Router();
    router.use(toExpress(echoMock()));
    const app = express();
    app.use("/api", router);

    const response = await request(app).get("/api/echo?page=2&tag[]=x");

    expect(response.status).toBe(200);
    expect(response.body.query).toEqual({ page: "2", "tag[]": "x" });
  });

  it("ignores a req.query replaced by earlier middleware unless transformQuery is given", async () => {
    // Express 5 exposes req.query as a prototype getter, so middleware that
    // replaces it has to redefine the property on the request.
    const replaceQuery: express.RequestHandler = (req, _res, next) => {
      Object.defineProperty(req, "query", {
        value: { page: "9" },
        configurable: true,
        enumerable: true,
        writable: true,
      });
      next();
    };

    const byDefault = express();
    byDefault.use(replaceQuery);
    byDefault.use(toExpress(echoMock()));
    const defaultResponse = await request(byDefault).get("/echo?page=1");
    expect(defaultResponse.body.query).toEqual({ page: "1" });

    const withTransform = express();
    withTransform.use(replaceQuery);
    withTransform.use(
      toExpress(echoMock(), {
        transformQuery: (query) => ({ page: String(query.page) }),
      }),
    );
    const transformedResponse =
      await request(withTransform).get("/echo?page=1");
    expect(transformedResponse.body.query).toEqual({ page: "9" });
  });
});

describe("Express sends route headers verbatim", () => {
  it.each([
    ["application/json", { a: 1 }],
    ["text/html", "<p>hi</p>"],
    ["text/csv", new Uint8Array([0x63, 0x61, 0x66, 0xe9])],
  ] as const)("keeps content-type %s unchanged", async (contentType, body) => {
    const mock = schmock();
    mock("GET /typed", [200, body, { "content-type": contentType }]);
    const app = express();
    app.use(toExpress(mock));

    const response = await request(app).get("/typed");

    expect(response.headers["content-type"]).toBe(contentType);
  });

  it("keeps the JSON fallback of a failing errorFormatter charset-free", async () => {
    const mock = schmock();
    mock("GET /boom", () => {
      throw new Error("boom");
    });
    const app = express();
    app.use(
      toExpress(mock, {
        errorFormatter: () => {
          throw new Error("formatter failed");
        },
      }),
    );

    const response = await request(app).get("/boom");

    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.body).toEqual({
      error: "Internal Server Error",
      code: "INTERNAL_ERROR",
    });
  });
});
