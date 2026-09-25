import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";

/**
 * Node ingress (`mock.listen()`, the CLI) and the fetch interceptor both hand
 * a handler raw bytes for a non-text, non-form media type. A `type: string,
 * format: binary` request body is how OpenAPI declares exactly that upload,
 * so validation must accept the bytes instead of demanding a JS string.
 */
const uploadSpec = {
  openapi: "3.0.3",
  info: { title: "uploads", version: "1.0.0" },
  paths: {
    "/upload": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: { "204": { description: "stored" } },
      },
    },
  },
};

async function validatingMock() {
  const mock = schmock();
  mock.pipe(await openapi({ spec: uploadSpec, validateRequests: true }));
  return mock;
}

const octetStream = { "content-type": "application/octet-stream" };

describe("request validation of binary bodies", () => {
  it.each([
    ["an ArrayBuffer", new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer],
    ["a Uint8Array", new Uint8Array([0xff, 0xd8, 0x00])],
    ["a Blob", new Blob([new Uint8Array([1, 2, 3])])],
  ])("accepts %s for a format: binary string schema", async (_, body) => {
    const mock = await validatingMock();

    const response = await mock.handle("POST", "/upload", {
      body,
      headers: octetStream,
    });

    expect(response.status).toBe(204);
  });
});
