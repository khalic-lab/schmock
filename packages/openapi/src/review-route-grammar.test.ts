import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { detectCrudResources } from "./crud-detector";
import { convertPathTemplate, parseSpec } from "./parser";
import { openapi } from "./plugin";

function answering(which: string) {
  return {
    responses: {
      "200": {
        description: "ok",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { which: { type: "string" } },
            },
            example: { which },
          },
        },
      },
    },
  };
}

const spec = {
  openapi: "3.0.3",
  info: { title: "route grammar", version: "1.0.0" },
  paths: {
    "/v1/jobs/{job}:run": { post: answering("run") },
    "/v1/jobs/{job}:cancel": { post: answering("cancel") },
    "/v1/jobs:batchGet": { get: answering("batchGet") },
    "/v1/users/{user.id}": { get: answering("user") },
    "/reports/{year}-{month}-{day}": { get: answering("report") },
    "/pairs/{x}_{y}": { get: answering("pair") },
    "/broken/{a}{b}": { get: answering("broken") },
  },
};

async function mockWithSpec() {
  const mock = schmock({ state: {} });
  mock.pipe(await openapi({ spec }));
  const matched: Array<Readonly<Record<string, string>>> = [];
  const routePaths: string[] = [];
  mock.on("request:match", (event) => {
    matched.push(event.params);
    routePaths.push(event.routePath);
  });
  return { mock, matched, routePaths };
}

describe("convertPathTemplate", () => {
  it.each([
    ["/pets/{petId}", "/pets/:petId"],
    ["/v1/jobs/{job}:run", "/v1/jobs/:job\\:run"],
    ["/v1/jobs:batchGet", "/v1/jobs\\:batchGet"],
    ["/v1/users/{user.id}", '/v1/users/:"user.id"'],
    ["/reports/{year}-{month}-{day}", "/reports/:year-:month-:day"],
    ["/pairs/{x}_{y}", '/pairs/:"x"_:y'],
    ["/files/{name}-x", '/files/:"name"-x'],
    ["/files/{name-}-{ext}", '/files/:"name-"-:ext'],
    ["/files/{name}.json", "/files/:name.json"],
  ])("%s → %s", (template, expected) => {
    expect(convertPathTemplate(template)).toBe(expected);
  });
});

describe("OpenAPI path templates the core grammar cannot take verbatim", () => {
  it("routes each custom method to its own operation", async () => {
    const { mock, matched, routePaths } = await mockWithSpec();

    const cancel = await mock.handle("POST", "/v1/jobs/abc:cancel");
    expect(cancel.status).toBe(200);
    expect(routePaths.at(-1)).toBe("/v1/jobs/:job\\:cancel");
    expect(matched.at(-1)).toEqual({ job: "abc" });

    const run = await mock.handle("POST", "/v1/jobs/abc:run");
    expect(run.status).toBe(200);
    expect(routePaths.at(-1)).toBe("/v1/jobs/:job\\:run");

    expect((await mock.handle("POST", "/v1/jobs/abc")).status).toBe(404);
  });

  it("serves a custom method on a collection as a static route", async () => {
    const { mock, routePaths } = await mockWithSpec();

    const batch = await mock.handle("GET", "/v1/jobs:batchGet");
    expect(batch.status).toBe(200);
    expect(routePaths.at(-1)).toBe("/v1/jobs:batchGet");
    expect((await mock.handle("GET", "/v1/jobsbatchGet")).status).toBe(404);
  });

  it("reaches a dotted parameter under its spec name", async () => {
    const { mock, matched } = await mockWithSpec();

    // An item-only path is a lookup-only CRUD read: with no stored rows it
    // serves a generated body, so the route answers 200 (not ROUTE_NOT_FOUND)
    // and the dotted parameter arrives under its spec name.
    const user = await mock.handle("GET", "/v1/users/42");
    expect(user.status).toBe(200);
    expect(matched.at(-1)).toEqual({ "user.id": "42" });
  });

  it("splits hyphen- and underscore-joined parameters at the separator", async () => {
    const { mock, matched } = await mockWithSpec();

    const report = await mock.handle("GET", "/reports/2026-09-25");
    expect(report.status).toBe(200);
    expect(matched.at(-1)).toEqual({ year: "2026", month: "09", day: "25" });

    const pair = await mock.handle("GET", "/pairs/3_4");
    expect(pair.status).toBe(200);
    expect(matched.at(-1)).toEqual({ x: "3", y: "4" });
  });

  it("skips an operation whose parameters touch, with a parse warning", async () => {
    const parsed = await parseSpec(spec);

    expect(parsed.paths.map((path) => path.path)).not.toContain("/broken/:a:b");
    expect(parsed.warnings.join("\n")).toMatch(
      /GET \/broken\/\{a\}\{b\}: .*adjacent.*skipped/,
    );

    const { mock } = await mockWithSpec();
    expect((await mock.handle("GET", "/broken/xy")).status).toBe(404);
  });

  it("accepts schema override keys in spec, escaped and legacy Express form", async () => {
    const override = {
      type: "object",
      properties: { overridden: { type: "boolean", const: true } },
      required: ["overridden"],
    } as const;

    for (const key of [
      "POST /v1/jobs/{job}:cancel",
      "POST /v1/jobs/:job\\:cancel",
    ]) {
      await expect(
        openapi({ spec, schemas: { [key]: override } }),
      ).resolves.toBeDefined();
    }

    await expect(
      openapi({
        spec: {
          openapi: "3.0.3",
          info: { title: "pets", version: "1.0.0" },
          paths: { "/pets/{petId}": { get: answering("pet") } },
        },
        schemas: { "GET /pets/:petId": override },
      }),
    ).resolves.toBeDefined();
  });
});

describe("CRUD detection over the new path spellings", () => {
  it("keys a dotted item parameter by its spec name", async () => {
    const parsed = await parseSpec({
      openapi: "3.0.3",
      info: { title: "crud", version: "1.0.0" },
      paths: {
        "/v1/users": { get: answering("list"), post: answering("create") },
        "/v1/users/{user.id}": { get: answering("read") },
        "/v1/users/{user.id}:ban": { post: answering("ban") },
      },
    });

    const { resources, nonCrudPaths } = detectCrudResources(parsed.paths);
    expect(resources).toHaveLength(1);
    expect(resources[0].idParam).toBe("user.id");
    expect(resources[0].itemPath).toBe('/v1/users/:"user.id"');
    expect(nonCrudPaths.map((path) => path.path)).toEqual([
      '/v1/users/:"user.id"\\:ban',
    ]);
  });
});
