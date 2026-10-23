import { schmock } from "@schmock/core";
import { describe, expect, it } from "vitest";
import { openapi } from "./plugin";

type OpenApiVersion = "3.0.3" | "3.1.0";

function specWithRequestContent(
  content: Record<string, unknown>,
  version: OpenApiVersion = "3.0.3",
) {
  return {
    openapi: version,
    info: { title: "request bodies", version: "1.0.0" },
    paths: {
      "/uploads": {
        post: {
          requestBody: { required: true, content },
          responses: {
            "201": {
              description: "stored",
              content: {
                "application/json": { schema: { type: "object" } },
              },
            },
          },
        },
      },
    },
  };
}

async function validatingMock(
  content: Record<string, unknown>,
  version?: OpenApiVersion,
): Promise<Schmock.CallableMockInstance> {
  const mock = schmock();
  mock.pipe(
    await openapi({
      spec: specWithRequestContent(content, version),
      validateRequests: true,
    }),
  );
  return mock;
}

/** POST through the fetch interceptor, the path React, Vue and the relay use. */
async function interceptedPost(
  mock: Schmock.CallableMockInstance,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const handle = mock.intercept({ passthrough: false });
  try {
    const response = await fetch("http://localhost/uploads", {
      method: "POST",
      ...init,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : text };
  } finally {
    handle.restore();
  }
}

const octetStream = { "content-type": "application/octet-stream" };

describe("request body validation", () => {
  describe("raw binary uploads", () => {
    it.each([
      [
        "3.0 nullable: true",
        "3.0.3" as const,
        { type: "string", format: "binary", nullable: true },
      ],
      [
        "3.1 type: [string, null]",
        "3.1.0" as const,
        { type: ["string", "null"], format: "binary" },
      ],
    ])("accepts bytes for a %s binary schema", async (_, version, schema) => {
      const mock = await validatingMock(
        { "application/octet-stream": { schema } },
        version,
      );

      const direct = await mock.handle("POST", "/uploads", {
        body: new Uint8Array([1, 2, 3]).buffer,
        headers: octetStream,
      });
      expect(direct.status).toBe(201);

      const intercepted = await interceptedPost(mock, {
        body: new Uint8Array([1, 2, 3]),
        headers: octetStream,
      });
      expect(intercepted.status).toBe(201);
    });
  });
});
