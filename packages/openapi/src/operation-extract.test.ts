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
