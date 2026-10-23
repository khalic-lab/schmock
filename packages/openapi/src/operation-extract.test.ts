import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { parseSpec } from "./parser";
import { openapi } from "./plugin";

function swagger2(paths: Record<string, unknown>) {
  return {
    swagger: "2.0",
    info: { title: "swagger 2", version: "1.0.0" },
    paths,
  };
}

describe("operation extraction", () => {
  describe("Swagger 2.0 inline schema keywords", () => {
    const headerSpec = swagger2({
      "/items": {
        get: {
          parameters: [
            {
              name: "limit",
              in: "query",
              type: "integer",
              minimum: 1,
              maximum: 50,
              default: 10,
            },
          ],
          responses: {
            "200": {
              description: "OK",
              headers: {
                "X-Rate-Limit": { type: "integer", default: 100 },
                "X-Page-Size": { type: "integer", minimum: 10 },
                "X-Version": { type: "string", default: "v2" },
                "X-Token": { type: "string", minLength: 8 },
                "X-Retry": {
                  type: "number",
                  minimum: 2,
                  exclusiveMinimum: true,
                  maximum: 4,
                },
              },
            },
          },
        },
      },
    });

    it("keeps every JSON Schema keyword a header declares inline", async () => {
      const spec = await parseSpec(headerSpec);
      const headers = spec.paths[0].responses.get(200)?.headers;

      expect(headers?.["X-Rate-Limit"].schema).toEqual({
        type: "integer",
        default: 100,
      });
      expect(headers?.["X-Token"].schema).toEqual({
        type: "string",
        minLength: 8,
      });
      expect(headers?.["X-Retry"].schema).toEqual({
        type: "number",
        exclusiveMinimum: 2,
        maximum: 4,
      });
    });

    it("keeps every JSON Schema keyword a parameter declares inline", async () => {
      const spec = await parseSpec(headerSpec);

      expect(spec.paths[0].parameters[0].schema).toEqual({
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 10,
      });
    });

    it("generates header values from those keywords", async () => {
      const mock = schmock();
      mock.pipe(await openapi({ spec: headerSpec }));

      const response = await mock.handle("GET", "/items");

      expect(response.headers).toMatchObject({
        "X-Rate-Limit": "100",
        "X-Page-Size": "10",
        "X-Version": "v2",
        "X-Token": "xxxxxxxx",
        "X-Retry": "3",
      });
    });
  });

  describe("Swagger 2.0 type: file", () => {
    const downloadSpec = swagger2({
      "/report": {
        get: {
          produces: ["application/pdf"],
          responses: {
            "200": { description: "the report", schema: { type: "file" } },
          },
        },
      },
    });

    it("reads a file response as a binary string", async () => {
      const spec = await parseSpec(downloadSpec);

      expect(spec.paths[0].responses.get(200)?.schema).toEqual({
        type: "string",
        format: "binary",
      });
    });

    it("answers a file download instead of failing generation", async () => {
      const mock = schmock();
      mock.pipe(await openapi({ spec: downloadSpec, validateResponses: true }));

      const response = await mock.handle("GET", "/report");

      expect(response.status).toBe(200);
      expect(typeof response.body).toBe("string");
      expect(response.headers["content-type"]).toBe("application/pdf");
    });

    it("validates an upload whose body parameter says file", async () => {
      const mock = schmock();
      mock.pipe(
        await openapi({
          spec: swagger2({
            "/upload": {
              post: {
                consumes: ["application/octet-stream"],
                parameters: [
                  {
                    name: "file",
                    in: "body",
                    required: true,
                    schema: { type: "file" },
                  },
                ],
                responses: { "204": { description: "stored" } },
              },
            },
          }),
          validateRequests: true,
        }),
      );

      // No Content-Type: the body is checked against the body parameter's
      // own schema, which used to fail to compile.
      const response = await mock.handle("POST", "/upload", {
        body: new Uint8Array([1, 2, 3]),
      });

      expect(response.status).toBe(204);
    });
  });
});
